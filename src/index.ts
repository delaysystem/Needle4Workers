import { AsyncMutex } from "./lib/async-mutex";
import { prepareToolsForNeedle } from "./lib/tool-pruner";
import {
  getOrFetchWeights,
  getDeterministicCacheKey,
  getCachedToolCall,
  setCachedToolCall,
} from "./lib/edge-cache";
import { NeedleEngine } from "./wasm/needle-engine";

// In-isolate engine singleton and linear memory mutex
let engineInstance: NeedleEngine | null = null;
const mutex = new AsyncMutex();

/**
 * Initializes NeedleEngine singleton and loads 16L weights if not already loaded.
 */
async function getOrInitEngine(
  env: Env,
  ctx: ExecutionContext,
  baseUrl: string
): Promise<NeedleEngine> {
  if (!engineInstance) {
    engineInstance = new NeedleEngine();
    await engineInstance.initWasm();
  }

  if (!engineInstance.isLoaded()) {
    const rawWeightsUrl = env.WEIGHTS_URL || "/weights/needle3-16l.cact";
    const weightsUrl = rawWeightsUrl.startsWith("http")
      ? rawWeightsUrl
      : new URL(rawWeightsUrl, baseUrl).toString();

    let weightsBytes: Uint8Array;
    try {
      weightsBytes = await getOrFetchWeights(weightsUrl, ctx, (env as any).WEIGHTS_BUCKET);
    } catch (fetchErr) {
      // In local dev or node environment, fallback to reading weights from local filesystem
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const candidates = [
          path.resolve(process.cwd(), "weights/needle3-16l.cact"),
          path.resolve(process.cwd(), "tubot-needle/weights/needle3-16l.cact"),
          "/tmp/test-wasm-16l/needle3.cact",
        ];
        let foundBuffer: Buffer | null = null;
        for (const cand of candidates) {
          if (fs.existsSync(cand)) {
            foundBuffer = fs.readFileSync(cand);
            break;
          }
        }
        if (foundBuffer) {
          weightsBytes = new Uint8Array(foundBuffer);
        } else {
          throw fetchErr;
        }
      } catch {
        throw fetchErr;
      }
    }

    engineInstance.loadWeights(weightsBytes);
  }

  return engineInstance;
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
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Needle-Layers",
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
          model: "Needle 3 16L",
          simd: 128,
          layer_count: parseInt(env.NEEDLE_LAYERS || "16", 10),
          engine_loaded: engineInstance ? engineInstance.isLoaded() : false,
          cache_stats: {
            deterministic_cache: "KVNamespace (tubot-needle-cache)",
            edge_cache: "caches.default",
          },
          mutex: {
            locked: mutex.isLocked,
            queue_length: mutex.queueLength,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // 2. GET /weights/needle3-16l.cact: Serve local weights if requested
    if (request.method === "GET" && url.pathname === "/weights/needle3-16l.cact") {
      // Check R2 bucket binding if available
      if ((env as any).WEIGHTS_BUCKET) {
        try {
          const r2Obj = await (env as any).WEIGHTS_BUCKET.get("needle3-16l.cact");
          if (r2Obj) {
            return new Response(r2Obj.body, {
              status: 200,
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": r2Obj.size.toString(),
                "Cache-Control": "public, max-age=31536000, immutable",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
        } catch {}
      }

      // Check static assets binding if available
      if ((env as any).ASSETS) {
        const assetRes = await (env as any).ASSETS.fetch(request);
        if (assetRes.status === 200) {
          return assetRes;
        }
      }

      // Fallback to local file in dev / node environment
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const candidates = [
          path.resolve(process.cwd(), "weights/needle3-16l.cact"),
          path.resolve(process.cwd(), "tubot-needle/weights/needle3-16l.cact"),
          "/tmp/test-wasm-16l/needle3.cact",
        ];
        for (const cand of candidates) {
          if (fs.existsSync(cand)) {
            const data = fs.readFileSync(cand);
            return new Response(data, {
              status: 200,
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": data.byteLength.toString(),
                "Cache-Control": "public, max-age=31536000, immutable",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
        }
      } catch {}

      return new Response("Weights file not found", { status: 404 });
    }

    // 3. POST /v1/tools/prune: Debug tool pruning & schema minification
    if (request.method === "POST" && url.pathname === "/v1/tools/prune") {
      try {
        const body: any = await request.json().catch(() => ({}));
        const query: string = body.query || "";
        const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
        const maxTools: number =
          typeof body.max_tools === "number"
            ? body.max_tools
            : parseInt(env.MAX_PRUNED_TOOLS || "5", 10) || 5;

        const prunerResult = prepareToolsForNeedle(tools, query, maxTools);

        return new Response(JSON.stringify(prunerResult), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Prefill-Tokens-Saved": `${prunerResult.savedTokensEstimate}`,
          },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err?.message || "Failed to prune tools" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // 4. POST /v1/tools/complete: Direct raw Needle endpoint
    if (request.method === "POST" && url.pathname === "/v1/tools/complete") {
      try {
        const body: any = await request.json().catch(() => ({}));
        const query: string = body.query || body.input || "";
        const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
        const maxTokens: number =
          typeof body.max_tokens === "number" ? body.max_tokens : 128;
        const temperature: number =
          typeof body.temperature === "number" ? body.temperature : 0;

        // Deterministic cache check for temperature === 0
        const cacheKey = await getDeterministicCacheKey(
          query,
          JSON.stringify(tools),
          temperature
        );
        const rawCacheKey = `${cacheKey}:raw`;

        if (temperature === 0) {
          const cached = await getCachedToolCall(
            rawCacheKey,
            env.DETERMINISTIC_CACHE
          );
          if (cached) {
            return new Response(JSON.stringify(cached), {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "X-Needle-Cache": "HIT",
                "X-Needle-Layers": env.NEEDLE_LAYERS || "16",
                "X-Needle-SIMD": "128",
                "X-Prefill-Tokens-Saved": "0",
              },
            });
          }
        }

        // Prune and minify
        const maxPrunedTools =
          parseInt(env.MAX_PRUNED_TOOLS || "5", 10) || 5;
        const prunerResult = prepareToolsForNeedle(
          tools,
          query,
          maxPrunedTools
        );

        // Exclusive execution in mutex
        const engine = await getOrInitEngine(env, ctx, request.url);
        const rawResult = await mutex.runExclusive(async () => {
          engine.init("", prunerResult.minifiedJson);
          try {
            return engine.complete(query, maxTokens);
          } finally {
            // CRITICAL: ALWAYS reset KV cache in finally block!
            engine.reset();
          }
        });

        // Async write to deterministic cache
        if (temperature === 0) {
          const cachePromise = setCachedToolCall(
            rawCacheKey,
            rawResult,
            env.DETERMINISTIC_CACHE,
            86400,
            ctx
          );
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(cachePromise);
          }
        }

        return new Response(JSON.stringify(rawResult), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Needle-Cache": "MISS",
            "X-Needle-Layers": env.NEEDLE_LAYERS || "16",
            "X-Needle-SIMD": "128",
            "X-Prefill-Tokens-Saved": `${prunerResult.savedTokensEstimate}`,
          },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err?.message || "Tool execution failed" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // 5. POST /v1/chat/completions: OpenAI compatible tool calling endpoint
    if (
      request.method === "POST" &&
      url.pathname === "/v1/chat/completions"
    ) {
      try {
        const body: any = await request.json().catch(() => ({}));

        // Extract latest user query and tools list
        let query = "";
        if (Array.isArray(body.messages)) {
          for (let i = body.messages.length - 1; i >= 0; i--) {
            const msg = body.messages[i];
            if (msg && msg.role === "user") {
              query =
                typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content);
              break;
            }
          }
        }
        const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
        const temperature: number =
          typeof body.temperature === "number" ? body.temperature : 0;
        const maxTokens: number =
          typeof body.max_tokens === "number" ? body.max_tokens : 128;

        // Deterministic cache check for temperature === 0
        const cacheKey = await getDeterministicCacheKey(
          query,
          JSON.stringify(tools),
          temperature
        );

        if (temperature === 0) {
          const cached = await getCachedToolCall(
            cacheKey,
            env.DETERMINISTIC_CACHE
          );
          if (cached) {
            const cachedPayload = cached.response || cached;
            return new Response(JSON.stringify(cachedPayload), {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "X-Needle-Cache": "HIT",
                "X-Needle-Layers": env.NEEDLE_LAYERS || "16",
                "X-Needle-SIMD": "128",
                "X-Prefill-Tokens-Saved": `${cached.savedTokens || "0"}`,
              },
            });
          }
        }

        // Prune tools & minify schemas with prepareToolsForNeedle to cut token prefill
        const maxPrunedTools =
          parseInt(env.MAX_PRUNED_TOOLS || "5", 10) || 5;
        const prunerResult = prepareToolsForNeedle(
          tools,
          query,
          maxPrunedTools
        );

        // Run inside mutex.runExclusive
        const engine = await getOrInitEngine(env, ctx, request.url);
        const rawResult = await mutex.runExclusive(async () => {
          engine.init("", prunerResult.minifiedJson);
          try {
            return engine.complete(query, maxTokens);
          } finally {
            // CRITICAL: ALWAYS reset KV cache in finally block!
            engine.reset();
          }
        });

        // Format OpenAI-compatible response
        const toolCalls = (rawResult.function_calls || []).map(
          (fc: any) => ({
            id: `call_${crypto.randomUUID().slice(0, 9)}`,
            type: "function",
            function: {
              name: fc.name,
              arguments:
                typeof fc.arguments === "string"
                  ? fc.arguments
                  : JSON.stringify(fc.arguments || {}),
            },
          })
        );

        const hasToolCalls = toolCalls.length > 0;
        const chatResponse = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "needle-3-16l",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: hasToolCalls ? null : (rawResult.raw_output || ""),
                ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
                ...(rawResult.reasoning
                  ? { reasoning_content: rawResult.reasoning }
                  : {}),
              },
              finish_reason: hasToolCalls ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        };

        // If temperature === 0, store in deterministic cache asynchronously
        if (temperature === 0) {
          const cacheData = {
            response: chatResponse,
            savedTokens: prunerResult.savedTokensEstimate,
          };
          const cachePromise = setCachedToolCall(
            cacheKey,
            cacheData,
            env.DETERMINISTIC_CACHE,
            86400,
            ctx
          );
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(cachePromise);
          }
        }

        return new Response(JSON.stringify(chatResponse), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Needle-Cache": "MISS",
            "X-Needle-Layers": env.NEEDLE_LAYERS || "16",
            "X-Needle-SIMD": "128",
            "X-Prefill-Tokens-Saved": `${prunerResult.savedTokensEstimate}`,
          },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err?.message || "Inference error" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // 6. Default GET / falls back to serving static assets from ./public/index.html
    if (request.method === "GET") {
      if ((env as any).ASSETS) {
        const assetRes = await (env as any).ASSETS.fetch(request);
        if (assetRes.status === 200) {
          return assetRes;
        }
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const candidates = [
            path.resolve(process.cwd(), "public/index.html"),
            path.resolve(process.cwd(), "tubot-needle/public/index.html"),
          ];
          for (const cand of candidates) {
            if (fs.existsSync(cand)) {
              return new Response(fs.readFileSync(cand), {
                status: 200,
                headers: {
                  "Content-Type": "text/html; charset=utf-8",
                  "Access-Control-Allow-Origin": "*",
                },
              });
            }
          }
        } catch {}
      }
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
