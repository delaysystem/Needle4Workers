/** SEC-12: fail-closed auth + explicit CORS allowlist. Hermetic (no weights,
 * no network): fastpath queries prove auth passage without touching the
 * engine, and 401s reject before any engine work. */
import { describe, expect, test } from "bun:test";
import worker from "../src/index";

const HANDOFF = [
  { name: "request_human_handoff", parameters: { type: "object", properties: {}, required: [] } },
];

function chatReq(headers: Record<string, string> = {}) {
  return new Request("http://localhost:8787/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Please, get me a human." }],
      tools: HANDOFF,
    }),
  });
}

// No ASSETS binding: any engine touch 500s, so a 200 proves the request
// passed auth AND the fastpath bypass.
const NO_ENGINE: any = { NEEDLE_LAYERS: "20", WEIGHTS_CHUNKS: "/missing.aa" };

describe("fail-closed auth (SEC-12)", () => {
  test("chat + metrics 401 when AUTH_TOKEN is unset outside local dev", async () => {
    const chat = await worker.fetch(chatReq(), { ...NO_ENGINE }, {} as any);
    expect(chat.status).toBe(401);
    expect((await chat.json()) as any).toEqual({ error: "Unauthorized" });
    const metrics = await worker.fetch(
      new Request("http://localhost:8787/v1/metrics"), { ...NO_ENGINE }, {} as any
    );
    expect(metrics.status).toBe(401);
  });

  test("ALLOW_OPEN_DEMO=1 restores the local-dev open posture", async () => {
    const res = await worker.fetch(
      chatReq(), { ...NO_ENGINE, ALLOW_OPEN_DEMO: "1" }, {} as any
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Needle-Fastpath")).toBe("1");
    const metrics = await worker.fetch(
      new Request("http://localhost:8787/v1/metrics"),
      { ...NO_ENGINE, ALLOW_OPEN_DEMO: "1" }, {} as any
    );
    expect(metrics.status).toBe(200);
  });

  test("any other ALLOW_OPEN_DEMO value still fails closed", async () => {
    for (const value of ["0", "true", "yes", ""]) {
      const res = await worker.fetch(
        chatReq(), { ...NO_ENGINE, ALLOW_OPEN_DEMO: value }, {} as any
      );
      expect(res.status).toBe(401);
    }
  });

  test("set AUTH_TOKEN enforces the bearer even in demo posture", async () => {
    const env = { ...NO_ENGINE, AUTH_TOKEN: "s3cret", ALLOW_OPEN_DEMO: "1" };
    const denied = await worker.fetch(chatReq(), env, {} as any);
    expect(denied.status).toBe(401);
    const allowed = await worker.fetch(
      chatReq({ Authorization: "Bearer s3cret" }), env, {} as any
    );
    expect(allowed.status).toBe(200);
  });

  test("health stays open for load balancers without auth", async () => {
    // Stateless assertion only: /ready reflects isolate engine state, which
    // co-scheduled engine-warming files may change (routes.test.ts owns the
    // ready transition with reset discipline).
    const health = await worker.fetch(
      new Request("http://localhost:8787/health"), { ...NO_ENGINE }, {} as any
    );
    expect(health.status).toBe(200);
  });
});

describe("explicit CORS allowlist (SEC-12)", () => {
  const LISTED = "https://app.example";
  const allowEnv = { ...NO_ENGINE, ALLOWED_ORIGINS: `${LISTED}, https://admin.example` };

  test("allowlisted Origin is echoed; unlisted gets no header", async () => {
    const ok = await worker.fetch(
      new Request("http://localhost:8787/health", { headers: { Origin: LISTED } }),
      allowEnv, {} as any
    );
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(LISTED);
    const evil = await worker.fetch(
      new Request("http://localhost:8787/health", { headers: { Origin: "https://evil.example" } }),
      allowEnv, {} as any
    );
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("legacy single ALLOWED_ORIGIN is honored", async () => {
    const res = await worker.fetch(
      new Request("http://localhost:8787/health", { headers: { Origin: LISTED } }),
      { ...NO_ENGINE, ALLOWED_ORIGIN: LISTED }, {} as any
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(LISTED);
  });

  test("preflight echoes allowlisted origins and omits otherwise", async () => {
    const preflight = (origin: string) =>
      new Request("http://localhost:8787/v1/chat/completions", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      });
    const ok = await worker.fetch(preflight(LISTED), allowEnv, {} as any);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(LISTED);
    const evil = await worker.fetch(preflight("https://evil.example"), allowEnv, {} as any);
    expect(evil.status).toBe(204);
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("no allowlist: '*' in demo posture, omitted when closed", async () => {
    const open = await worker.fetch(
      new Request("http://localhost:8787/health"),
      { ...NO_ENGINE, ALLOW_OPEN_DEMO: "1" }, {} as any
    );
    expect(open.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const closed = await worker.fetch(
      new Request("http://localhost:8787/health", { headers: { Origin: LISTED } }),
      { ...NO_ENGINE }, {} as any
    );
    expect(closed.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
