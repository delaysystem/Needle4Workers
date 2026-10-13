import worker from "./src/index";

async function main() {
  console.log("=== TuBot-Needle End-to-End Verification ===");
  
  const mockEnv: any = {
    NEEDLE_LAYERS: "16",
    MAX_PRUNED_TOOLS: "5",
    WEIGHTS_URL: "/weights/needle3-16l.cact",
  };
  
  const mockCtx: any = {
    waitUntil: (promise: Promise<any>) => {
      promise.catch((err) => console.error("ctx.waitUntil error:", err));
    },
  };

  // Test 1: Health check
  console.log("\n[Test 1] GET /health");
  const resHealth = await worker.fetch(new Request("http://localhost:8787/health"), mockEnv, mockCtx);
  const healthJson = await resHealth.json();
  console.log("Health Status:", resHealth.status, healthJson);
  if (healthJson.model !== "Needle 3 16L" || healthJson.layer_count !== 16 || healthJson.simd !== 128) {
    throw new Error("Invalid health check response");
  }

  // Test 2: Tool Pruning & Schema Minification
  console.log("\n[Test 2] POST /v1/tools/prune");
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a given city location",
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          title: "GetWeatherParameters",
          type: "object",
          properties: {
            city: { type: "string", description: "The name of the city, e.g. San Francisco or Tokyo" },
            units: { type: "string", default: "celsius", description: "Units of temperature measurement" }
          },
          required: ["city"],
          additionalProperties: false
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

  const resPrune = await worker.fetch(
    new Request("http://localhost:8787/v1/tools/prune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "What is the temperature in Tokyo right now?", tools, max_tools: 1 })
    }),
    mockEnv,
    mockCtx
  );
  const pruneJson = await resPrune.json();
  console.log("Prune Result:", pruneJson);
  if (pruneJson.selectedTools.length !== 1 || pruneJson.selectedTools[0].name !== "get_weather") {
    throw new Error("Tool pruning failed to prioritize get_weather");
  }

  // Test 3: OpenAI-compatible Chat Completion (Inference turn 1)
  console.log("\n[Test 3] POST /v1/chat/completions (Deterministic Cache MISS)");
  const chatPayload = {
    messages: [
      { role: "user", content: "What is the weather in Tokyo?" }
    ],
    tools,
    temperature: 0.0
  };

  const t0 = performance.now();
  const resChat1 = await worker.fetch(
    new Request("http://localhost:8787/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatPayload)
    }),
    mockEnv,
    mockCtx
  );
  const latency1 = performance.now() - t0;
  const chatJson1 = await resChat1.json();
  console.log(`Chat Turn 1 Response (${latency1.toFixed(2)}ms):`, JSON.stringify(chatJson1, null, 2));
  console.log("Headers:", {
    "X-Needle-Cache": resChat1.headers.get("X-Needle-Cache"),
    "X-Needle-Layers": resChat1.headers.get("X-Needle-Layers"),
    "X-Needle-SIMD": resChat1.headers.get("X-Needle-SIMD"),
    "X-Prefill-Tokens-Saved": resChat1.headers.get("X-Prefill-Tokens-Saved"),
  });
  if (resChat1.headers.get("X-Needle-Cache") !== "MISS") {
    throw new Error("Expected cache MISS on first turn");
  }
  const toolCall1 = chatJson1.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall1 || toolCall1.function.name !== "get_weather") {
    throw new Error("Expected get_weather tool call in response");
  }

  // Test 4: Deterministic Edge Cache Instant Return (Inference turn 2)
  console.log("\n[Test 4] POST /v1/chat/completions (Deterministic Cache HIT)");
  const t1 = performance.now();
  const resChat2 = await worker.fetch(
    new Request("http://localhost:8787/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatPayload)
    }),
    mockEnv,
    mockCtx
  );
  const latency2 = performance.now() - t1;
  const chatJson2 = await resChat2.json();
  console.log(`Chat Turn 2 Instant Return (${latency2.toFixed(2)}ms):`);
  console.log("X-Needle-Cache:", resChat2.headers.get("X-Needle-Cache"));
  console.log("Latency header:", resChat2.headers.get("X-Needle-Latency-Ms"));
  if (resChat2.headers.get("X-Needle-Cache") !== "HIT") {
    throw new Error("Expected cache HIT on repeated turn");
  }
  if (latency2 > 50) {
    console.warn("Latency was higher than expected for edge cache hit:", latency2);
  }

  // Test 5: Direct Needle Completion with different tool (Verifying KV Cache was reset cleanly)
  console.log("\n[Test 5] POST /v1/tools/complete (Direct Needle endpoint with clean KV cache)");
  const directPayload = {
    input: "Turn on the lights in the living room",
    tools,
    temperature: 0.0
  };
  const resDirect = await worker.fetch(
    new Request("http://localhost:8787/v1/tools/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(directPayload)
    }),
    mockEnv,
    mockCtx
  );
  const directJson = await resDirect.json();
  const directCalls = directJson.needle_output?.function_calls || directJson.function_calls;
  if (!directCalls || directCalls[0]?.name !== "control_smart_home") {
    throw new Error("Expected control_smart_home tool call; check KV cache reset isolation");
  }

  // Test 6: Async Mutex Serialization (3 parallel concurrent requests)
  console.log("\n[Test 6] Concurrent request handling with Async Mutex");
  const queries = [
    "What is the weather in Paris?",
    "Book a flight to London",
    "Turn off bedroom lights"
  ];
  const promises = queries.map((q) =>
    worker.fetch(
      new Request("http://localhost:8787/v1/tools/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: q, tools, temperature: 0.5 })
      }),
      mockEnv,
      mockCtx
    )
  );
  const results = await Promise.all(promises);
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const data = await res.json();
    const calls = data.function_calls || data.needle_output?.function_calls;
    console.log(`Concurrent request ${i + 1} status:`, res.status, "selected:", calls?.[0]?.name);
    if (res.status !== 200) throw new Error(`Concurrent request ${i + 1} failed`);
  }

  console.log("\n✅ ALL 6 END-TO-END VERIFICATION TESTS PASSED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("❌ Test verification failed:", err);
  process.exit(1);
});
