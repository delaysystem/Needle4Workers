import worker from "./src/index";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EXPECTED_WEIGHTS_SHA256 = "18b13c30905b925392fd83c7774c4013344f42d6ca113cfd2bf9dc4996a212db";

function resolveRepoFile(basename: string): string {
  const candidates = [
    path.resolve(process.cwd(), "weights", basename),
    path.resolve(process.cwd(), "Needle4Workers", "weights", basename),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error(`Missing weights file: ${basename}`);
}

async function main() {
  console.log("=== TuBot-Needle End-to-End Verification (chunked weights, OpenAI-only) ===");

  const mockEnv: any = {
    NEEDLE_LAYERS: "20",
    WEIGHTS_CHUNKS: "/needle3-20l-handoff.cact.aa,/needle3-20l-handoff.cact.ab,/needle3-20l-handoff.cact.ac",
  };

  const mockCtx = {} as any; // worker.fetch ignores ctx

  // ASSETS-style fetcher serving real chunk bytes from disk (stands in for the platform pipeline).
  const assetsEnv: any = {
    ...mockEnv,
    ASSETS: {
      fetch: async (req: Request) => {
        const basename = new URL(req.url).pathname.split("/").pop() as string;
        return new Response(fs.readFileSync(resolveRepoFile(basename)), { headers: { "Content-Type": "application/octet-stream" } });
      },
    },
  };

  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a given city location",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" },
            units: { type: "string" }
          },
          required: ["city"]
        }
      }
    },
    {
      name: "book_flight",
      description: "Book an airline flight ticket to destination",
      parameters: {
        type: "object",
        properties: { destination: { type: "string" } },
        required: ["destination"]
      }
    },
    {
      name: "control_smart_home",
      description: "Turn lights or thermostats on or off in a room",
      parameters: {
        type: "object",
        properties: { room: { type: "string" }, action: { type: "string" } },
        required: ["room", "action"]
      }
    }
  ];

  const chatPayload = (content: string, temperature = 0.0) => ({
    messages: [{ role: "user", content }],
    tools,
    temperature,
  });

  async function callWorker(env: any, pathname: string, method = "GET", body?: unknown): Promise<{ res: Response; json: any }> {
    const res = await worker.fetch(
      new Request(`http://localhost:8787${pathname}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      mockCtx
    );
    return { res, json: ((await res.json().catch(() => null)) as any) };
  }

  const postChat = (env: any, payload: unknown) => callWorker(env, "/v1/chat/completions", "POST", payload);

  const firstCall = (json: any) => json.choices?.[0]?.message?.tool_calls?.[0];
  const callName = (json: any) => firstCall(json)?.function?.name;

  // Test 1: Health check
  console.log("\n[Test 1] GET /health");
  const { res: resHealth, json: healthJson } = await callWorker(mockEnv, "/health");
  console.log("Health Status:", resHealth.status, healthJson);
  if (healthJson.model !== "Needle 3 20L" || healthJson.layer_count !== 20 || healthJson.simd !== 128) {
    throw new Error("Invalid health check response");
  }
  if (healthJson.b2_fallback !== false) {
    throw new Error("Health must report b2_fallback=false without B2 secrets configured");
  }

  // Test 2: Chunk files on disk reassemble to the exact original weights
  console.log("\n[Test 2] Chunk integrity (sha256 of concatenated chunks)");
  const chunkPaths = mockEnv.WEIGHTS_CHUNKS.split(",").map((p: string) => resolveRepoFile(path.basename(p)));
  const chunkSizes = chunkPaths.map((p: string) => fs.statSync(p).size);
  console.log("Chunk sizes:", chunkSizes);
  for (const size of chunkSizes) {
    if (size > 25 * 1024 * 1024) {
      throw new Error(`Chunk exceeds 25 MiB static asset limit: ${size} bytes`);
    }
  }
  const hash = crypto.createHash("sha256");
  for (const p of chunkPaths) hash.update(fs.readFileSync(p));
  const digest = hash.digest("hex");
  console.log("Reassembled sha256:", digest);
  if (digest !== EXPECTED_WEIGHTS_SHA256) {
    throw new Error("Chunk files do not reassemble to the original weights");
  }

  // Test 3: Loader failure modes, before the first successful load.
  console.log("\n[Test 3] Loader failure modes (no source, then bogus B2 creds)");
  const failPayload = chatPayload("What is the weather in Tokyo?");
  const noSource = await postChat(mockEnv, failPayload);
  console.log("No-source status:", noSource.res.status, "error:", noSource.json.error);
  if (noSource.res.status !== 500 || !/static assets/i.test(noSource.json.error || "")) {
    throw new Error("Expected 500 naming static assets when no weights source exists");
  }
  const bogus = await postChat({ ...mockEnv, BACKBLAZE_KEY_ID: "bogus", BACKBLAZE_APPLICATION_KEY: "bogus", BACKBLAZE_BUCKET_NAME: "bogus" }, failPayload);
  console.log("Bogus-B2 status:", bogus.res.status, "error:", String(bogus.json.error).slice(0, 100));
  if (bogus.res.status !== 500 || !/B2 authorize failed \(401\)/.test(bogus.json.error || "")) {
    throw new Error("Expected 500 surfacing the real B2 401 for bogus credentials");
  }

  // Test 4: First successful load, through the ASSETS chunk branch.
  console.log("\n[Test 4] POST /v1/chat/completions via ASSETS chunks");
  const t0 = performance.now();
  const turn1 = await postChat(assetsEnv, chatPayload("What is the weather in Tokyo?"));
  console.log(`Chat Turn 1 (${(performance.now() - t0).toFixed(2)}ms):`, turn1.res.status, "selected:", callName(turn1.json));
  for (const h of ["X-Needle-Cache", "X-Prefill-Tokens-Saved", "X-Needle-Runtime"]) {
    if (turn1.res.headers.get(h) !== null) {
      throw new Error(`${h} header must be gone: its system was removed`);
    }
  }
  if (callName(turn1.json) !== "get_weather") {
    throw new Error("Expected get_weather tool call in response");
  }

  // Test 5: Repeat identical request re-runs inference (no HIT possible)
  console.log("\n[Test 5] POST /v1/chat/completions (repeat: still 200, still no cache headers)");
  const turn2 = await postChat(assetsEnv, chatPayload("What is the weather in Tokyo?"));
  console.log("Repeat status:", turn2.res.status, "X-Needle-Cache:", turn2.res.headers.get("X-Needle-Cache"));
  if (turn2.res.status !== 200) {
    throw new Error(`Expected 200 on repeated turn, got ${turn2.res.status}`);
  }
  if (turn2.res.headers.get("X-Needle-Cache") !== null) {
    throw new Error("Repeat must not return X-Needle-Cache: KV cache was removed");
  }
  if (callName(turn2.json) !== "get_weather") {
    throw new Error("Expected get_weather tool call on repeated turn");
  }

  // Test 6: Chat completion with different tool (WASM state reset isolation)
  console.log("\n[Test 6] POST /v1/chat/completions (different tool, clean WASM state)");
  const direct = await postChat(assetsEnv, chatPayload("Turn on the lights in the living room"));
  if (callName(direct.json) !== "control_smart_home") {
    throw new Error("Expected control_smart_home tool call; check WASM cache reset isolation");
  }

  // Test 7: Async Mutex Serialization (3 parallel concurrent requests)
  console.log("\n[Test 7] Concurrent request handling with Async Mutex");
  const queries = [
    "What is the weather in Paris?",
    "Book a flight to London",
    "Turn off bedroom lights"
  ];
  const expected = ["get_weather", "book_flight", "control_smart_home"];
  const results = await Promise.all(
    queries.map((q) => postChat(assetsEnv, chatPayload(q, 0.5)))
  );
  for (let i = 0; i < results.length; i++) {
    const { res, json } = results[i];
    console.log(`Concurrent request ${i + 1} status:`, res.status, "selected:", callName(json));
    if (res.status !== 200) throw new Error(`Concurrent request ${i + 1} failed`);
    if (callName(json) !== expected[i]) throw new Error(`Expected ${expected[i]}, got ${callName(json)}`);
  }

  // Test 8: Token-budget truncation surfaces as 500, never as fake content
  console.log("\n[Test 8] Truncated inference -> 500 with engine error");
  const trunc = await postChat(assetsEnv, { ...chatPayload("What is the weather in Tokyo?"), max_tokens: 8 });
  console.log("Truncate status:", trunc.res.status, "error:", trunc.json.error);
  if (trunc.res.status !== 500 || !/truncated/i.test(trunc.json.error || "")) {
    throw new Error("Expected 500 naming truncation for exhausted token budget");
  }

  console.log("\n✅ ALL 8 END-TO-END VERIFICATION TESTS PASSED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("❌ Test verification failed:", err);
  process.exit(1);
});
