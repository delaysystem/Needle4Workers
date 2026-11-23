/** Stateless depth router: one entry point, single-depth backends.
 *
 * Each backend runs exactly one model depth (same worker code, different
 * WEIGHTS_CHUNKS). This router holds no engine: it counts user messages,
 * applies the depth policy, and proxies. Measured tier quality (goldens):
 * 4L 7/252, 8L 8/252, 12L 29/252, 16L 127/252, 20L 238/252 — which is why
 * the default policy is single-20 and depth-split is explicit opt-in.
 *
 * Env: ROUTE_POLICY ("single-20" default | "depth-split"),
 *   BACKEND_4L_URL, BACKEND_16L_URL, BACKEND_20L_URL (20L required),
 *   AUTH_TOKEN (required outside the open demo posture; unset fails closed
 *   with 401, same semantics as the worker), ALLOWED_ORIGINS (comma-separated
 *   CORS allowlist; legacy ALLOWED_ORIGIN also honored),
 *   ALLOW_OPEN_DEMO=1 (local-dev-only opt-in to the open posture).
 * Override: X-Needle-Depth: 4|16|20 wins over the policy.
 */

import { HANDOFF_TOOL, matchFastpath } from "../src/lib/fastpath";
import { HttpError, validateChatBody } from "../src/lib/guardrails";
import { Metrics, logRequest } from "../src/lib/metrics";
import { buildChatResponse } from "../src/lib/response";

interface RouterEnv {
  ROUTE_POLICY?: string;
  BACKEND_4L_URL?: string;
  BACKEND_16L_URL?: string;
  BACKEND_20L_URL?: string;
  AUTH_TOKEN?: string;
  ALLOWED_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
  ALLOW_OPEN_DEMO?: string;
}

const metrics = new Metrics();
const PROXY_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 5_000;

/** Depth for a turn count under a policy. Pure and unit-tested. */
export function routeDepth(userTurns: number, policy: string): 4 | 16 | 20 {
  if (policy !== "depth-split") return 20;
  if (userTurns <= 1) return 4;
  if (userTurns === 2) return 16;
  return 20;
}

function backendFor(depth: 4 | 16 | 20, env: RouterEnv): string | null {
  if (depth === 4) return env.BACKEND_4L_URL ?? null;
  if (depth === 16) return env.BACKEND_16L_URL ?? null;
  return env.BACKEND_20L_URL ?? null;
}

/** The only value that opens the demo posture; anything else fails closed.
 * Origin: SEC-12 backend posture (src/index.ts ALLOW_OPEN_DEMO_VALUE). */
const ROUTER_OPEN_DEMO_VALUE = "1";

/** True only when the operator explicitly opted into the open demo posture
 * (local development). Anything else — staging, prod, previews — fails closed. */
function isRouterOpenDemo(env: RouterEnv): boolean {
  return env.ALLOW_OPEN_DEMO === ROUTER_OPEN_DEMO_VALUE;
}

/** Explicit CORS origin allowlist from env. Empty = unconfigured. */
function parseRouterAllowedOrigins(env: RouterEnv): string[] {
  const origins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.ALLOWED_ORIGIN?.trim()) origins.push(env.ALLOWED_ORIGIN.trim());
  return [...new Set(origins)];
}

/** CORS origin for this request: the request Origin echoed back iff it is
 * allowlisted; "*" only in the explicit open-demo posture; otherwise the
 * header is omitted and browsers deny the cross-origin read. */
function routerCorsOrigin(env: RouterEnv, request: Request): string | null {
  const allowlist = parseRouterAllowedOrigins(env);
  if (allowlist.length > 0) {
    const origin = request.headers.get("Origin");
    return origin && allowlist.includes(origin) ? origin : null;
  }
  return isRouterOpenDemo(env) ? "*" : null;
}

/** Set once per isolate so a missing AUTH_TOKEN warns once, not per request. */
let warnedRouterMissingAuthToken = false;

function routerUnauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/** 401 unless the bearer matches AUTH_TOKEN. An unset AUTH_TOKEN fails closed
 * (401) outside the explicit open-demo posture instead of proxying open. */
function requireAuth(request: Request, env: RouterEnv): Response | null {
  const token = env.AUTH_TOKEN;
  if (!token) {
    if (isRouterOpenDemo(env)) return null;
    if (!warnedRouterMissingAuthToken) {
      warnedRouterMissingAuthToken = true;
      console.error(
        "needle-router: refusing request: AUTH_TOKEN is not configured " +
        "(set the AUTH_TOKEN secret, or ALLOW_OPEN_DEMO=1 for local dev only)"
      );
    }
    return routerUnauthorized();
  }
  if (request.headers.get("Authorization") === `Bearer ${token}`) return null;
  return routerUnauthorized();
}

async function proxyChat(
  baseUrl: string, body: string, request: Request, timeoutMs: number
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of ["Authorization", "X-Request-Id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(baseUrl.replace(/\/+$/, "") + "/v1/chat/completions", {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function withDepthHeader(res: Response, depth: string, fellBack: boolean): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Served-By-Depth", depth);
  if (fellBack) headers.set("X-Needle-Fell-Back", "1");
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request: Request, env: RouterEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Request-Id, X-Needle-Depth",
        "Access-Control-Max-Age": "86400",
      };
      const origin = routerCorsOrigin(env, request);
      if (origin) headers["Access-Control-Allow-Origin"] = origin;
      return new Response(null, { status: 204, headers });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          service: "needle-router",
          policy: env.ROUTE_POLICY || "single-20",
          backends: {
            "4": Boolean(env.BACKEND_4L_URL),
            "16": Boolean(env.BACKEND_16L_URL),
            "20": Boolean(env.BACKEND_20L_URL),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      const probe = async (key: "4" | "16" | "20", base: string | null) => {
        if (!base) return [key, "unconfigured"] as const;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), READY_TIMEOUT_MS);
          try {
            const res = await fetch(base.replace(/\/+$/, "") + "/health", { signal: ctrl.signal });
            return [key, res.ok ? "up" : `down-${res.status}`] as const;
          } finally {
            clearTimeout(timer);
          }
        } catch {
          return [key, "down"] as const;
        }
      };
      const results = await Promise.all([
        probe("4", env.BACKEND_4L_URL ?? null),
        probe("16", env.BACKEND_16L_URL ?? null),
        probe("20", env.BACKEND_20L_URL ?? null),
      ]);
      const byDepth = Object.fromEntries(results);
      const ready = byDepth["20"] === "up";
      return new Response(JSON.stringify({ ready, backends: byDepth }), {
        status: ready ? 200 : 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/metrics") {
      const authed = requireAuth(request, env);
      if (authed) return authed;
      return new Response(JSON.stringify(metrics.snapshot()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/v1/chat/completions" || url.pathname === "/chat")
    ) {
      const t0 = Date.now();
      const earlyAuth = requireAuth(request, env);
      if (earlyAuth) return earlyAuth;
      try {
        const rawBody = await request.text();
        let body: any;
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new HttpError(400, "Request body must be valid JSON");
        }
        const { query, tools } = validateChatBody(body);
        const userTurns = (body.messages as any[]).filter((m) => m && m.role === "user").length;

        // Fastpath serves here: no proxy hop at all.
        if (matchFastpath(query, tools)) {
          const fastBody = JSON.stringify(
            buildChatResponse([{ name: HANDOFF_TOOL, arguments: {} }], "", null, "needle-router")
          );
          const latencyMs = Date.now() - t0;
          metrics.record({ status: 200, latencyMs, fastpath: true, tier: "fastpath" });
          logRequest({ status: 200, latency_ms: latencyMs, fastpath: true, tier: "fastpath" });
          return new Response(fastBody, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Served-By-Depth": "fastpath",
            },
          });
        }

        const override = request.headers.get("X-Needle-Depth");
        let depth: 4 | 16 | 20;
        if (override !== null) {
          if (override !== "4" && override !== "16" && override !== "20") {
            throw new HttpError(400, "X-Needle-Depth must be 4, 16, or 20");
          }
          depth = parseInt(override, 10) as 4 | 16 | 20;
        } else {
          depth = routeDepth(userTurns, env.ROUTE_POLICY || "single-20");
        }
        const primary = backendFor(depth, env);
        if (!primary) {
          throw new HttpError(500, `router misconfigured: no backend for depth ${depth}`);
        }
        const fallback = backendFor(20, env);
        const tryDepths: (4 | 16 | 20)[] =
          depth === 20 || !fallback || fallback === primary ? [depth] : [depth, 20];
        let lastError: string | null = null;
        for (const attempt of tryDepths) {
          const base = backendFor(attempt, env) as string;
          try {
            const upstream = await proxyChat(base, rawBody, request, PROXY_TIMEOUT_MS);
            if (!upstream.ok && attempt !== 20) {
              lastError = `depth ${attempt} -> ${upstream.status}`;
              continue;
            }
            const latencyMs = Date.now() - t0;
            const fellBack = attempt !== depth;
            metrics.record({
              status: upstream.status, latencyMs, tier: String(attempt),
              ...(fellBack ? { retried: true } : {}),
            });
            logRequest({ status: upstream.status, latency_ms: latencyMs, tier: String(attempt), fell_back: fellBack });
            return withDepthHeader(upstream, String(attempt), fellBack);
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (attempt === 20) break;
          }
        }
        const latencyMs = Date.now() - t0;
        metrics.record({ status: 502, latencyMs });
        logRequest({ status: 502, latency_ms: latencyMs });
        return new Response(
          JSON.stringify({ error: "All backends failed", detail: lastError }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        );
      } catch (err: any) {
        const latencyMs = Date.now() - t0;
        if (err instanceof HttpError) {
          metrics.record({ status: err.status, latencyMs });
          logRequest({ status: err.status, latency_ms: latencyMs });
          return new Response(JSON.stringify({ error: err.message }), {
            status: err.status,
            headers: { "Content-Type": "application/json" },
          });
        }
        metrics.record({ status: 500, latencyMs });
        logRequest({ status: 500, latency_ms: latencyMs });
        return new Response(JSON.stringify({ error: err?.message || "Router error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
