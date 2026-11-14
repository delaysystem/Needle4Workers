import { AsyncMutex } from "./lib/async-mutex";
import {
  EngineHealth,
  HttpError,
  IDEMPOTENCY_CAP,
  IdempotencyCache,
  MAX_QUEUE_LENGTH,
  isTransientInferenceError,
  validateChatBody,
  validateToolCalls,
} from "./lib/guardrails";
import { Metrics, logRequest } from "./lib/metrics";
import { b2ConfigFromEnv, getOrFetchWeights } from "./lib/weights";
import { NeedleEngine } from "./wasm/needle-engine";

// In-isolate engine singleton and linear memory mutex
let engineInstance: NeedleEngine | null = null;
let engineInitPromise: Promise<NeedleEngine> | null = null;
const mutex = new AsyncMutex();
const idempotency = new IdempotencyCache(IDEMPOTENCY_CAP);
const engineHealth = new EngineHealth();
const metrics = new Metrics();

/** Drop a possibly poisoned engine so the next request rebuilds it. */
function dropEngine(): void {
  engineInstance = null;
  engineInitPromise = null;
}

/** Rejects tools payloads big enough to stall prefill (measured: 2KB ≈ 2.7s init). */
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
  await fresh.initWasm();
  fresh.loadWeights(
    await getOrFetchWeights({
      chunks,
      baseUrl,
      assetsFetcher: env.ASSETS ?? null,
      b2: b2ConfigFromEnv(env),
    })
  );
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
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // 2. GET /v1/metrics: isolate-local counters and latency quantiles.
    if (request.method === "GET" && url.pathname === "/v1/metrics") {
      return new Response(JSON.stringify(metrics.snapshot()), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // 3. POST /v1/chat/completions: OpenAI compatible tool calling endpoint.
    // Full caller-supplied tools are passed to the engine unpruned.
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
        outcome: { retried?: boolean; replayed?: boolean; saturated?: boolean } = {}
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
        if (mutex.queueLength >= MAX_QUEUE_LENGTH) {
          return finish(
            429,
            JSON.stringify({ error: "Server busy, retry later" }),
            {},
            { saturated: true }
          );
        }

        // Run inside mutex.runExclusive, with one reset-and-retry on thrown errors.
        const engine = await getOrInitEngine(env, request.url);
        let retried = false;
        const runOnce = () =>
          mutex.runExclusive(async () => {
            engine.init("", toolsJson);
            try {
              return engine.complete(query, maxTokens);
            } finally {
              // CRITICAL: ALWAYS reset KV cache in finally block!
              engine.reset();
            }
          });
        let rawResult;
        try {
          rawResult = await runOnce();
        } catch (err) {
          if (!isTransientInferenceError(err)) throw err;
          retried = true;
          engine.reset();
          rawResult = await runOnce();
        }
        engineHealth.noteSuccess();

        if (rawResult.success === false) {
          const message =
            rawResult.error || (rawResult as any).error_code || "Inference failed";
          return finish(500, JSON.stringify({ error: message }), {}, { retried });
        }
        const callErrors = validateToolCalls(rawResult.function_calls || [], tools);
        if (callErrors.length > 0) {
          return finish(
            502,
            JSON.stringify({ error: "Model output failed schema validation", details: callErrors }),
            {},
            { retried }
          );
        }

        // Format OpenAI-compatible response
        const toolCalls = (rawResult.function_calls || []).map((fc: any) => ({
          id: `call_${crypto.randomUUID().slice(0, 9)}`,
          type: "function",
          function: {
            name: fc.name,
            arguments: typeof fc.arguments === "string" ? fc.arguments : JSON.stringify(fc.arguments || {}),
          },
        }));

        const hasToolCalls = toolCalls.length > 0;
        const chatResponse = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "needle-3-20l",
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
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        const responseBody = JSON.stringify(chatResponse);
        if (requestId) idempotency.set(requestId, 200, responseBody);
        return finish(
          200,
          responseBody,
          {
            "Access-Control-Allow-Origin": "*",
            "X-Needle-Layers": env.NEEDLE_LAYERS || "20",
            "X-Needle-SIMD": "128",
            ...(retried ? { "X-Needle-Retried": "1" } : {}),
          },
          { retried }
        );
      } catch (err: any) {
        if (err instanceof HttpError) {
          return finish(err.status, JSON.stringify({ error: err.message }));
        }
        if (engineHealth.noteThrown()) dropEngine();
        return finish(500, JSON.stringify({ error: err?.message || "Inference error" }));
      }
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
