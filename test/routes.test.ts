/** Weights-backed route tests: /ready, auth, saturation. Slow (~40s).
 * Hermetic unit tests live in the other test files; this file needs
 * weights/ on disk and runs real inference. */
import { describe, expect, test } from "bun:test";
import worker, { __resetEngineForTests } from "../src/index";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

function env(extra: Record<string, any> = {}): any {
  return {
    NEEDLE_LAYERS: "20",
    WEIGHTS_CHUNKS: "/needle3-20l-handoff.cact.aa,/needle3-20l-handoff.cact.ab,/needle3-20l-handoff.cact.ac",
    ASSETS: {
      fetch: async (req: Request) => {
        const name = new URL(req.url).pathname.split("/").pop() as string;
        return new Response(fs.readFileSync(path.join(ROOT, "weights", name)));
      },
    },
    ...extra,
  };
}

const TOOLS = [
  { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
];

function chat(query: string, maxTokens = 128) {
  return worker.fetch(
    new Request("http://localhost:8787/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: query }], tools: TOOLS, max_tokens: maxTokens }),
    }),
    env(),
    {} as any
  );
}

describe("GET /ready", () => {
  test("503 before the engine loads, 200 after", async () => {
    __resetEngineForTests();
    const cold = await worker.fetch(new Request("http://localhost:8787/ready"), env(), {} as any);
    expect(cold.status).toBe(503);
    expect((await cold.json() as any).ready).toBe(false);
    const res = await chat("What is the weather in Oslo?");
    expect(res.status).toBe(200);
    const warm = await worker.fetch(new Request("http://localhost:8787/ready"), env(), {} as any);
    expect(warm.status).toBe(200);
    expect((await warm.json() as any).ready).toBe(true);
  }, 120000);
});

describe("fastpath", () => {
  const HANDOFF = [
    { name: "request_human_handoff", parameters: { type: "object", properties: {}, required: [] } },
  ];
  test("bare unambiguous ask answers instantly without the engine", async () => {
    const t0 = Date.now();
    const res = await worker.fetch(
      new Request("http://localhost:8787/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Please, get me a human." }],
          tools: HANDOFF,
        }),
      }),
      // No ASSETS binding: any engine touch would 500, proving the bypass.
      { NEEDLE_LAYERS: "20", WEIGHTS_CHUNKS: "/missing.aa" } as any,
      {} as any
    );
    expect(Date.now() - t0).toBeLessThan(500);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Needle-Fastpath")).toBe("1");
    const payload: any = await res.json();
    const calls = payload.choices[0].message.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("request_human_handoff");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ reason: "general" });
    expect(payload.choices[0].finish_reason).toBe("tool_calls");
  });
  test("no handoff tool declared means no fastpath", async () => {
    const res = await worker.fetch(
      new Request("http://localhost:8787/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Get me a human." }],
          tools: [{ name: "get_weather" }],
        }),
      }),
      env(),
      {} as any
    );
    // Falls through to the engine (200 here); the point is the header absence.
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Needle-Fastpath")).toBeNull();
  });
});

describe("auth", () => {
  test("401 without the bearer, 200 with it", async () => {
    const authed = (headers: Record<string, string>) =>
      worker.fetch(
        new Request("http://localhost:8787/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: TOOLS }),
        }),
        env({ AUTH_TOKEN: "s3cret" }),
        {} as any
      );
    const denied = await authed({});
    expect(denied.status).toBe(401);
    const allowed = await authed({ Authorization: "Bearer s3cret" });
    expect(allowed.status).toBe(200);
    const metricsDenied = await worker.fetch(
      new Request("http://localhost:8787/v1/metrics"),
      env({ AUTH_TOKEN: "s3cret" }),
      {} as any
    );
    expect(metricsDenied.status).toBe(401);
  }, 120000);
});


