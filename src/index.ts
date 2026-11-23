import { AsyncMutex } from "./lib/async-mutex";
import {
  EngineHealth,
  HttpError,
  IDEMPOTENCY_CAP,
  IdempotencyCache,
  PinnedTools,
  isSaturated,
  isTransientInferenceError,
  preparePinnedTools,
  resolveEngineToolsJson,
  validateChatBody,
  validateToolCalls,
} from "./lib/guardrails";
import { HANDOFF_TOOL, matchFastpath } from "./lib/fastpath";
import { Metrics, estimateTokens, logRequest } from "./lib/metrics";
import { ChatCall, buildChatResponse } from "./lib/response";
import { loadRules, matchRule } from "./lib/rules";
import fastpathSpec from "./lib/fastpath.json";
import { b2ConfigFromEnv, fetchWeightResponses, fillEngineFromResponses } from "./lib/weights";
import { NeedleEngine } from "./wasm/needle-engine";

// In-isolate engine singleton and linear memory mutex
let engineInstance: NeedleEngine | null = null;
let engineInitPromise: Promise<NeedleEngine> | null = null;
const mutex = new AsyncMutex();
const idempotency = new IdempotencyCache(IDEMPOTENCY_CAP);
const engineHealth = new EngineHealth();
const metrics = new Metrics();

let cachedRules: ReturnType<typeof loadRules> | null = null;
/** Lazily compiled verdict rules; throws loudly (→500) on a bad spec. */
function getRules() {
  if (!cachedRules) cachedRules = loadRules(fastpathSpec);
  return cachedRules;
}

let pinnedCache: { raw: string; pinned: PinnedTools | null } | null = null;
/**
 * Deployment-pinned tools from PINNED_TOOLS (a JSON tools array), parsed
 * once per distinct value. Unset/empty = feature off; unparseable warns
 * once per value and runs unpinned rather than 500ing every request.
 */
function getPinnedTools(env: Env): PinnedTools | null {
  const raw = (env as any).PINNED_TOOLS as string | undefined;
  if (!raw) return null;
  if (!pinnedCache || pinnedCache.raw !== raw) {
    let pinned: PinnedTools | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("PINNED_TOOLS must be a JSON array of tools");
      pinned = preparePinnedTools(parsed);
    } catch (err: any) {
      console.warn(`PINNED_TOOLS ignored (collapse off): ${err?.message ?? err}`);
    }
    pinnedCache = { raw, pinned };
  }
  return pinnedCache.pinned;
}

/** Drop a possibly poisoned engine so the next request rebuilds it. */
function dropEngine(): void {
  engineInstance = null;
  engineInitPromise = null;
}

/** Test-only: reset engine + health so cold-start tests are order-independent. */
export function __resetEngineForTests(): void {
  dropEngine();
  engineHealth.noteSuccess();
}



/** Requests currently parked on an in-flight cold engine init. */
let initWaiters = 0;

/** Env var that opts a deployment into the open demo posture. Local-dev-only
 * flag: staging/prod must never set it. Origin: SEC-12. */
const ALLOW_OPEN_DEMO_VAR = "ALLOW_OPEN_DEMO";
/** The only value that opens the demo posture; anything else fails closed. */
const ALLOW_OPEN_DEMO_VALUE = "1";
/** Env vars carrying the explicit CORS origin allowlist: a comma-separated
 * list plus the legacy single-origin var. Origin: SEC-12. */
const ALLOWED_ORIGINS_VAR = "ALLOWED_ORIGINS";
const ALLOWED_ORIGIN_VAR = "ALLOWED_ORIGIN";

/** True only when the operator explicitly opted into the open demo posture
 * (local development). Anything else — staging, prod, previews — fails closed. */
function isOpenDemoPosture(env: Env): boolean {
  return (env as any)[ALLOW_OPEN_DEMO_VAR] === ALLOW_OPEN_DEMO_VALUE;
}

/** Explicit CORS origin allowlist from env. Empty = unconfigured. */
function parseAllowedOrigins(env: Env): string[] {
  const list = String((env as any)[ALLOWED_ORIGINS_VAR] ?? "");
  const single = String((env as any)[ALLOWED_ORIGIN_VAR] ?? "");
  const origins = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (single.trim()) origins.push(single.trim());
  return [...new Set(origins)];
}

/** CORS origin for this request: the request Origin echoed back iff it is
 * allowlisted; "*" only in the explicit open-demo posture; otherwise null
 * (callers omit the header and browsers deny the cross-origin read). */
function corsOrigin(env: Env, request: Request): string | null {
  const allowlist = parseAllowedOrigins(env);
  if (allowlist.length > 0) {
    const origin = request.headers.get("Origin");
    return origin && allowlist.includes(origin) ? origin : null;
  }
  return isOpenDemoPosture(env) ? "*" : null;
}

/** Access-Control-Allow-Origin header for this request, or {} when the
 * origin is not allowlisted (fail closed: no header, browser denies). */
function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = corsOrigin(env, request);
  return origin ? { "Access-Control-Allow-Origin": origin } : {};
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/** Set once per isolate so a missing AUTH_TOKEN warns once, not per request. */
let warnedMissingAuthToken = false;

/** 401 unless the bearer matches AUTH_TOKEN. An unset AUTH_TOKEN fails closed
 * (401) outside the explicit open-demo posture instead of serving open
 * unauthenticated inference. */
function requireAuth(request: Request, env: Env): Response | null {
  const token = (env as any).AUTH_TOKEN as string | undefined;
  if (!token) {
    if (isOpenDemoPosture(env)) return null;
    if (!warnedMissingAuthToken) {
      warnedMissingAuthToken = true;
      console.error(
        "needle: refusing request: AUTH_TOKEN is not configured " +
        "(set the AUTH_TOKEN secret, or ALLOW_OPEN_DEMO=1 for local dev only)"
      );
    }
    return unauthorized();
  }
  if (request.headers.get("Authorization") === `Bearer ${token}`) return null;
  return unauthorized();
}

/** Rejects tools payloads big enough to stall prefill (measured: the 978-char
 *  golden tools prefill 263 prefix tokens in ~5.5s, ~20ms/token; a 4.6KB
 *  payload took 29s). */
const MAX_TOOLS_BYTES = 8192;

/** Initializes the engine singleton and loads 20L handoff weights unless already loaded. */
async function getOrInitEngine(env: Env, baseUrl: string): Promise<NeedleEngine> {
  if (engineInstance) return engineInstance;
  // Share one in-flight init: concurrent cold requests must not each build an engine.
  if (!engineInitPromise) {
    engineInitPromise = initFreshEngine(env, baseUrl).then(
      (fresh) => {
        engineInstance = fresh;
        return fresh;
      },
      (err) => {
        engineInitPromise = null;
        throw err;
      }
    );
  }
  return engineInitPromise;
}

async function initFreshEngine(env: Env, baseUrl: string): Promise<NeedleEngine> {
  const chunks = (env.WEIGHTS_CHUNKS || "/needle3-20l-handoff.cact.aa,/needle3-20l-handoff.cact.ab,/needle3-20l-handoff.cact.ac")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fresh = new NeedleEngine();
  // Overlap: chunk fetch (network) runs while the WASM module imports and
  // instantiates (local). The fill joins both — alloc needs response
  // lengths and a live module. Promise.all subscribes to both legs, so a
  // failed instantiate never leaves a rejected fetch unhandled.
  const [_, fetched] = await Promise.all([
    fresh.initWasm(),
    fetchWeightResponses({
      chunks,
      baseUrl,
      assetsFetcher: env.ASSETS ?? null,
      b2: b2ConfigFromEnv(env),
    }),
  ]);
  const rc = await fillEngineFromResponses(fresh, fetched, (env as any).WEIGHTS_SHA ?? null);
  if (rc !== 0) {
    throw new Error(`_needle_load failed with code ${rc}: refusing a corrupt engine`);
  }
  return fresh;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(env, request),
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Needle-Layers, X-Request-Id",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 1. GET /health or GET /v1/model/info
    if (
      request.method === "GET" &&
      (url.pathname === "/health" || url.pathname === "/v1/model/info")
    ) {
      return new Response(
        JSON.stringify({
          status: "healthy",
          model: "Needle 3 20L",
          simd: 128,
          layer_count: parseInt(env.NEEDLE_LAYERS || "20", 10),
          engine_loaded: engineInstance ? engineInstance.isLoaded() : false,
          b2_fallback: b2ConfigFromEnv(env) !== null,
          mutex: { locked: mutex.isLocked, queue_length: mutex.queueLength },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(env, request),
          },
        }
      );
    }

    // 2. GET /v1/metrics: isolate-local counters and latency quantiles.
    if (request.method === "GET" && url.pathname === "/v1/metrics") {
      const authed = requireAuth(request, env);
      if (authed) return authed;
      return new Response(JSON.stringify(metrics.snapshot()), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(env, request),
        },
      });
    }

    // 3. GET /ready: readiness for load balancers (liveness stays on /health).
    if (request.method === "GET" && url.pathname === "/ready") {
      const loaded = engineInstance ? engineInstance.isLoaded() : false;
      const healthy = engineHealth.isHealthy();
      const ready = loaded && healthy;
      return new Response(
        JSON.stringify({
          ready,
          ...(!ready
            ? { reason: !loaded ? "engine not loaded" : "engine health tripped",
                consecutive_thrown: engineHealth.consecutiveThrown }
            : {}),
        }),
        {
          status: ready ? 200 : 503,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(env, request),
          },
        }
      );
    }

    // 3. POST /v1/chat/completions: OpenAI compatible tool calling endpoint.
    // Required-stripped tools go to the engine (see stripRequiredKeys);
    // outputs validate against the full caller-supplied schema.
    if (
      request.method === "POST" &&
      url.pathname === "/v1/chat/completions"
    ) {
      const t0 = Date.now();
      const requestId = request.headers.get("X-Request-Id");
      const finish = (
        status: number,
        body: string,
        extra: Record<string, string> = {},
        outcome: {
          retried?: boolean; replayed?: boolean; saturated?: boolean; fastpath?: boolean;
          pinned?: boolean;
          decodeTps?: number; initMs?: number; promptChars?: number; outputChars?: number;
        } = {}
      ): Response => {
        const latencyMs = Date.now() - t0;
        metrics.record({ status, latencyMs, ...outcome });
        logRequest({
          request_id: requestId,
          status,
          latency_ms: latencyMs,
          ...outcome,
        });
        return new Response(body, {
          status,
          headers: {
            "Content-Type": "application/json",
            "X-Needle-Latency": String(latencyMs),
            ...extra,
          },
        });
      };
      const earlyAuth = requireAuth(request, env);
      if (earlyAuth) return earlyAuth;
      try {
        const body: any = await request.json().catch(() => ({}));
        const { query, tools, maxTokens } = validateChatBody(body);

        const toolsJson = JSON.stringify(tools);
        if (toolsJson.length > MAX_TOOLS_BYTES) {
          return finish(
            400,
            JSON.stringify({ error: `Tools payload exceeds ${MAX_TOOLS_BYTES} bytes` })
          );
        }

        if (requestId) {
          const replay = idempotency.get(requestId);
          if (replay) {
            return finish(replay.status, replay.body, { "X-Needle-Replayed": "1" }, { replayed: true });
          }
        }
        // Layer 1 — verdict rules: structural patterns (mention-vs-ask,
        // info-questions, money+ask, bare demands...) short-circuit with
        // full v3 verdicts, abstain included. Proven by the ported
        // adversarial suite + the golden static gate (every fire == gold).
        const declared = new Set((tools ?? []).map((t: any) => t?.name));
        let rule = matchRule(getRules(), query);
        if (rule && !rule.calls.every((c) => declared.has(c.name))) {
          // Rule names a tool the caller did not declare: fall through
          // rather than emit a call the client never allowed.
          rule = null;
        }
        if (rule) {
          const ruledCalls = rule.calls.map((c) => ({
            name: c.name, arguments: { ...(c.arguments ?? {}) },
          }));
          const fastResponse = buildChatResponse(
            ruledCalls, "", null, "needle-3-20l"
          );
          const fastBody = JSON.stringify(fastResponse);
          if (requestId) idempotency.set(requestId, 200, fastBody);
          return finish(
            200,
            fastBody,
            {
              ...corsHeaders(env, request),
              "X-Needle-Layers": env.NEEDLE_LAYERS || "20",
              "X-Needle-Fastpath": "1",
              "X-Needle-Rule": rule.id,
            },
            { fastpath: true, promptChars: query.length, outputChars: fastBody.length }
          );
        }
        // Layer 2 — bare-ask fast path: unambiguous bare asks skip the
        // engine entirely (no mutex, no queue, no inference). Proven safe
        // by the golden implication test; emits the general verdict.
        if (matchFastpath(query, tools)) {
          const fastResponse = buildChatResponse(
            [{ name: HANDOFF_TOOL, arguments: { reason: "general" } }], "", null, "needle-3-20l"
          );
          const fastBody = JSON.stringify(fastResponse);
          if (requestId) idempotency.set(requestId, 200, fastBody);
          return finish(
            200,
            fastBody,
            {
              ...corsHeaders(env, request),
              "X-Needle-Layers": env.NEEDLE_LAYERS || "20",
              "X-Needle-Fastpath": "1",
              "X-Needle-Rule": "bare-ask",
            },
            { fastpath: true, promptChars: query.length, outputChars: fastBody.length }
          );
        }
        // The cap also bounds worst-case queue wait (~cap × p95 latency);
        // a wait timeout that cannot preempt sync WASM would only waste work.
        // Note: warm inference never yields, so only the init-waiter half
        // is observable live (cold weight fetch is async); the mutex half
        // stands ready for streaming/async engines.
        if (isSaturated(mutex.queueLength, initWaiters)) {
          return finish(
            429,
            JSON.stringify({ error: "Server busy, retry later" }),
            { "Retry-After": "5" },
            { saturated: true }
          );
        }

        // Run inside mutex.runExclusive, with one reset-and-retry on thrown errors.
        // Count everyone not yet served by a loaded engine, including the
        // request that triggers the init (it parks on it too).
        const needsInit = !engineInstance;
        if (needsInit) initWaiters++;
        let engine;
        try {
          engine = await getOrInitEngine(env, request.url);
        } finally {
          if (needsInit) initWaiters--;
        }
        let retried = false;
        // The engine sees required-stripped tools (its validator would
        // otherwise suppress every call); outputs are still validated
        // against the caller's raw schema below. Pinned deployments
        // collapse semantically identical callers onto the proven bytes.
        const { json: engineToolsJson, pinned: pinnedTools } = resolveEngineToolsJson(
          tools, getPinnedTools(env)
        );
        // Affinity key: the exact bytes the engine sees. The engine
        // tokenizes the raw tools string, not parsed content (measured
        // 2026-11-18: key order alone flips verdicts and misses the
        // single-prefix cache), so only byte-identical neighbors share
        // an init — a canonicalized key would batch requests that each
        // still pay the full multi-second prefill.
        const toolsKey = engineToolsJson;
        // Worker-measured init prefill: ~0ms on an engine prefix-cache hit,
        // seconds on a miss. Exposed per request so load tests can count
        // misses without inferring them from wall time.
        let initMs = 0;
        const runOnce = () =>
          mutex.runExclusive(async () => {
            const tInit = Date.now();
            engine.init("", engineToolsJson);
            initMs = Date.now() - tInit;
            // No reset here: complete() resets the KV ring in its own
            // finally on every path that creates KV state, so a second
            // reset would only re-memset a clean ring.
            return engine.complete(query, maxTokens);
          }, toolsKey);
        let rawResult;
        try {
          rawResult = await runOnce();
        } catch (err) {
          if (!isTransientInferenceError(err)) throw err;
          retried = true;
          // No reset here: complete()'s finally already reset, and a reset
          // outside the mutex could wipe KV state another request holds.
          rawResult = await runOnce();
        }
        engineHealth.noteSuccess();

        // Measured compute for this inference (tps from the engine, sizes exact;
        // initMs rides along so prefix-cache misses show in logs + /v1/metrics).
        const compute = {
          decodeTps: typeof rawResult.decode_tps === "number" ? rawResult.decode_tps : undefined,
          initMs,
          pinned: pinnedTools,
          promptChars: query.length,
          outputChars: (rawResult.raw_output || "").length,
        };
        if (rawResult.success === false) {
          const message =
            rawResult.error || (rawResult as any).error_code || "Inference failed";
          return finish(500, JSON.stringify({ error: message }), {}, { retried, ...compute });
        }
        const callErrors = validateToolCalls(rawResult.function_calls || [], tools);
        if (callErrors.length > 0) {
          return finish(
            502,
            JSON.stringify({ error: "Model output failed schema validation", details: callErrors }),
            {},
            { retried, ...compute }
          );
        }

        // Format OpenAI-compatible response
        const chatResponse: Record<string, any> = buildChatResponse(
          (rawResult.function_calls || []) as ChatCall[],
          rawResult.raw_output || "",
          rawResult.reasoning || null,
          "needle-3-20l"
        );
        chatResponse.usage = {
          prompt_tokens: estimateTokens(query.length),
          completion_tokens: estimateTokens((rawResult.raw_output || "").length),
          total_tokens: estimateTokens(query.length + (rawResult.raw_output || "").length),
        };
        chatResponse.usage_estimated = true;
        chatResponse.usage_details = {
          prompt_chars: query.length,
          completion_chars: (rawResult.raw_output || "").length,
          prefill_tps: rawResult.prefill_tps ?? 0,
          decode_tps: rawResult.decode_tps ?? 0,
          init_ms: initMs,
        };

        const responseBody = JSON.stringify(chatResponse);
        if (requestId) idempotency.set(requestId, 200, responseBody);
        return finish(
          200,
          responseBody,
          {
            ...corsHeaders(env, request),
            "X-Needle-Layers": env.NEEDLE_LAYERS || "20",
            "X-Needle-SIMD": "128",
            ...(retried ? { "X-Needle-Retried": "1" } : {}),
            ...(pinnedTools ? { "X-Needle-Pinned": "1" } : {}),
          },
          { retried, ...compute }
        );
      } catch (err: any) {
        if (err instanceof HttpError) {
          return finish(err.status, JSON.stringify({ error: err.message }));
        }
        if (engineHealth.noteThrown()) dropEngine();
        // Server-side detail: the client gets the message, tail/logs get the stack.
        console.error(JSON.stringify({
          type: "needle.error",
          message: err?.message ?? String(err),
          stack: typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 6) : undefined,
        }));
        return finish(500, JSON.stringify({ error: err?.message || "Inference error" }));
      }
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
