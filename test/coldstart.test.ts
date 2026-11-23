/** Cold-start saturation: the live 429 path. Weights-backed (~30s).
 *
 * Warm inference never yields the event loop, so a warm mutex queue is not
 * observably fillable in-process; cold weight fetch IS async, so ten
 * requests parked on one shared engineInitPromise is the deterministic
 * way to trip the guard. Own file: bun isolates module state per file,
 * so the engine starts cold here regardless of other test files. */
import { describe, expect, test } from "bun:test";
import worker, { __resetEngineForTests } from "../src/index";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TOOLS = [
  { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
];

function slowEnv(delayMs: number): any {
  return {
    NEEDLE_LAYERS: "20",
    // Explicit local posture: production default fails closed (see auth.test.ts).
    ALLOW_OPEN_DEMO: "1",
    WEIGHTS_CHUNKS: "/needle3-20l-handoff.cact.aa,/needle3-20l-handoff.cact.ab,/needle3-20l-handoff.cact.ac",
    ASSETS: {
      fetch: async (req: Request) => {
        await Bun.sleep(delayMs);
        const name = new URL(req.url).pathname.split("/").pop() as string;
        return new Response(fs.readFileSync(path.join(ROOT, "weights", name)));
      },
    },
  };
}

function chat(env: any, query: string) {
  return worker.fetch(
    new Request("http://localhost:8787/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: query }], tools: TOOLS, max_tokens: 32 }),
    }),
    env,
    {} as any
  );
}

describe("cold-start saturation", () => {
  test("429 with Retry-After while eight park on shared init", async () => {
    __resetEngineForTests();
    const env = slowEnv(2500);
    const pending = Array.from({ length: 8 }, (_, i) => chat(env, `weather query ${i} in Bergen?`));
    // All eight are parked on the one shared init (2.5s fetch); the 9th trips it.
    await Bun.sleep(800);
    const extra = await chat(env, "one too many in Oslo?");
    expect(extra.status).toBe(429);
    expect(extra.headers.get("Retry-After")).toBe("5");
    const settled = await Promise.all(pending);
    expect(settled.every((r) => r.status === 200)).toBe(true);
  }, 180000);
});
