import { createHash } from "node:crypto";

export interface B2WeightsConfig {
  keyId: string;
  applicationKey: string;
  bucketName: string;
  /** Key prefix holding the chunk files, e.g. "needle". */
  prefix: string;
}

export interface AssetFetcher {
  fetch: (req: Request) => Promise<Response>;
}

export interface WeightsLoadOptions {
  /** Chunk URL paths in concat order, e.g. ["/needle3-20l-handoff.cact.aa", ...]. */
  chunks: string[];
  /** Origin used to resolve chunk paths for static-asset fetches. */
  baseUrl: string;
  assetsFetcher?: AssetFetcher | null;
  /** B2 fallback; null disables it. */
  b2?: B2WeightsConfig | null;
  /** Expected sha256 of the reassembled bytes; mismatch fails the load loudly. */
  expectedSha?: string | null;
}

/**
 * Sink the engine exposes for a chunked weights load (implemented by
 * NeedleEngine). Chunks stream straight into one heap allocation: at no
 * point do JS-side copies of the full archive exist, which is what keeps
 * a 63MB load inside the 128MB edge-isolate budget.
 */
export interface EngineWeightsSink {
  /** malloc(totalLength) heap bytes for the reassembled archive. */
  allocWeights(totalLength: number): number;
  /** Copy one chunk into the allocation at the byte offset. */
  writeWeightsChunk(ptr: number, offset: number, chunk: Uint8Array): void;
  /**
   * Run _needle_load over the filled allocation. Frees ptr unless rc is 0
   * (on success the engine owns the input buffer in place). Returns rc.
   */
  finishWeightsLoad(ptr: number, totalLength: number): number;
  /** Free a ptr whose load was abandoned before finish (fetch/sha failure). */
  discardWeights(ptr: number): void;
}

/** Per-fetch timeouts: authorize is small, chunks are tens of MB. */
export const AUTHORIZE_TIMEOUT_MS = 30_000;
export const CHUNK_TIMEOUT_MS = 120_000;

/** Max bytes drained from a chunk body per heap write. Bodies stream through
 * the running sha into their heap slot in pieces this big, so peak JS-side
 * cost is one piece, not one ~21MB chunk. Origin: COST-10; small vs the
 * 128MB edge-isolate budget while keeping write-call overhead negligible. */
export const WEIGHTS_STREAM_PIECE_BYTES = 65536;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/** B2 fallback config from env, or null when its secrets are absent. */
export function b2ConfigFromEnv(env: Env): B2WeightsConfig | null {
  const e = env as any;
  return e.BACKBLAZE_KEY_ID && e.BACKBLAZE_APPLICATION_KEY && e.BACKBLAZE_BUCKET_NAME
    ? { keyId: e.BACKBLAZE_KEY_ID, applicationKey: e.BACKBLAZE_APPLICATION_KEY, bucketName: e.BACKBLAZE_BUCKET_NAME, prefix: env.B2_WEIGHTS_PREFIX || "needle" }
    : null;
}

function assertShaHex(actual: string, expected?: string | null): void {
  if (!expected) return;
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `Weights sha256 mismatch: want ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}… — refusing to load`
    );
  }
}

/** Parsed Content-Length, or null when the server did not send a usable one. */
function responseLength(res: Response): number | null {
  const raw = res.headers.get("content-length");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function b2Authorize(
  config: B2WeightsConfig
): Promise<{ authorizationToken: string; downloadUrl: string }> {
  const credentials = btoa(`${config.keyId}:${config.applicationKey}`);
  const res = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`B2 authorize failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as any;
  const authorizationToken = data.authorizationToken as string | undefined;
  const downloadUrl = (data.apiInfo?.storageApi?.downloadUrl || data.downloadUrl) as string | undefined;
  if (!authorizationToken || !downloadUrl) {
    throw new Error("B2 authorize response missing token or downloadUrl");
  }
  return { authorizationToken, downloadUrl };
}

/**
 * Fetched chunk responses plus their error narrator. Fetching needs no
 * engine: callers overlap it with WASM instantiate and fill afterwards.
 */
export interface WeightFetch {
  responses: Response[];
  describe: (i: number) => string;
}

/**
 * Drain one chunk body through `sink` in capped pieces. Reader-backed bodies
 * stream (peak JS-side cost is one piece); bodies without a stream (test
 * doubles, non-streaming servers) fall back to a single buffered piece.
 */
async function drainResponse(res: Response, sink: (piece: Uint8Array) => void): Promise<void> {
  const body = (res as any).body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    sink(new Uint8Array(await res.arrayBuffer()));
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        for (let off = 0; off < value.byteLength; off += WEIGHTS_STREAM_PIECE_BYTES) {
          sink(value.subarray(off, Math.min(off + WEIGHTS_STREAM_PIECE_BYTES, value.byteLength)));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Fill the engine's heap allocation from fetched chunk responses: lengths
 * come from headers (no bodies held), then each body streams through the
 * running sha into its heap slot in capped pieces and is released. Peak
 * JS-side cost is one piece, not the archive — bodies drain sequentially on
 * purpose, so a Promise.all here would multiply peak memory against the
 * 128MB isolate budget. Servers without Content-Length fall back to the
 * buffer-then-write path below.
 */
export async function fillEngineFromResponses(
  engine: EngineWeightsSink,
  fetched: WeightFetch,
  expectedSha: string | null | undefined
): Promise<number> {
  const responses = fetched.responses;
  for (let i = 0; i < responses.length; i++) {
    if (!responses[i].ok) {
      const body = await responses[i].text().catch(() => "");
      throw new Error(`${fetched.describe(i)} (${responses[i].status}): ${body}`);
    }
  }
  const lengths = responses.map(responseLength);
  if (lengths.every((l): l is number => l !== null)) {
    const total = lengths.reduce((n, l) => n + l, 0);
    const ptr = engine.allocWeights(total);
    try {
      const hash = createHash("sha256");
      let offset = 0;
      for (const res of responses) {
        await drainResponse(res, (piece) => {
          hash.update(piece);
          engine.writeWeightsChunk(ptr, offset, piece);
          offset += piece.byteLength;
        });
      }
      // A short body against a lying Content-Length would leave uninitialized
      // heap bytes under _needle_load: refuse instead of loading garbage.
      if (offset !== total) {
        throw new Error(
          `Weights truncated: Content-Length promised ${total} bytes, body delivered ${offset}`
        );
      }
      assertShaHex(hash.digest("hex"), expectedSha);
      return engine.finishWeightsLoad(ptr, total);
    } catch (err) {
      engine.discardWeights(ptr);
      throw err;
    }
  }
  // No Content-Length: the total is unknowable until every body arrives, so
  // bodies buffer — but each part writes straight into the one allocation at
  // its offset. No second full-archive concat copy (the old path held parts
  // + concat + heap, ~3x the archive against the 128MB budget).
  const parts: Uint8Array[] = [];
  const hash = createHash("sha256");
  for (const res of responses) {
    const part = new Uint8Array(await res.arrayBuffer());
    hash.update(part);
    parts.push(part);
  }
  assertShaHex(hash.digest("hex"), expectedSha);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const ptr = engine.allocWeights(total);
  try {
    let offset = 0;
    for (const part of parts) {
      engine.writeWeightsChunk(ptr, offset, part);
      offset += part.byteLength;
    }
    return engine.finishWeightsLoad(ptr, total);
  } catch (err) {
    engine.discardWeights(ptr);
    throw err;
  }
}

/**
 * Fetch every chunk (static assets, else the same files in B2). Returns
 * raw responses: the ok check lives in the fill phase, so a failed fetch
 * never touches the engine. Engine-free by design — the cold path starts
 * this before WASM instantiate and fills once both are ready.
 */
export async function fetchWeightResponses(opts: WeightsLoadOptions): Promise<WeightFetch> {
  if (opts.chunks.length === 0) {
    throw new Error("No weights chunks configured (WEIGHTS_CHUNKS is empty)");
  }

  let assetsError: unknown = null;
  if (opts.assetsFetcher && typeof opts.assetsFetcher.fetch === "function") {
    try {
      const responses = await withTimeout(
        Promise.all(
          opts.chunks.map((c) =>
            opts.assetsFetcher!.fetch(new Request(new URL(c, opts.baseUrl).toString()))
          )
        ),
        CHUNK_TIMEOUT_MS,
        "Static asset chunk fetch"
      );
      return {
        responses,
        describe: (i) => `Static asset missing: ${opts.chunks[i]}`,
      };
    } catch (err) {
      assetsError = err;
    }
  } else {
    assetsError = new Error("Static assets binding (ASSETS) is unavailable");
  }

  if (opts.b2) {
    const b2 = opts.b2;
    const { authorizationToken, downloadUrl } = await withTimeout(
      b2Authorize(b2),
      AUTHORIZE_TIMEOUT_MS,
      "B2 authorize"
    );
    const prefix = b2.prefix.replace(/^\/+|\/+$/g, "");
    const urls = opts.chunks.map((c) => {
      const file = encodeURIComponent(`${prefix}/${c.split("/").pop()}`).replace(/%2F/g, "/");
      return `${downloadUrl.replace(/\/+$/, "")}/file/${b2.bucketName}/${file}`;
    });
    const responses = await withTimeout(
      Promise.all(
        urls.map((u) => fetch(u, { headers: { Authorization: authorizationToken } }))
      ),
      CHUNK_TIMEOUT_MS,
      "B2 chunk fetch"
    );
    // Basename only: full download URLs (bucket + signed host) must not echo to callers.
    return {
      responses,
      describe: (i) => `B2 chunk fetch failed: ${opts.chunks[i].split("/").pop()}`,
    };
  }

  throw assetsError instanceof Error
    ? assetsError
    : new Error("Weights unavailable: static assets failed and B2 fallback is not configured");
}

/**
 * Loads model weights from chunked static assets, falling back to the same
 * chunk files in B2 when assets fail and B2 is configured. No other source.
 * Bytes stream into the engine (see EngineWeightsSink); nothing is cached
 * in JS — a rebuild re-fetches, which the edge serves from its own cache.
 * One-shot composition of fetch + fill; latency-sensitive callers overlap
 * the fetch with WASM instantiate via the split phases instead.
 */
export async function loadWeightsIntoEngine(
  engine: EngineWeightsSink,
  opts: WeightsLoadOptions
): Promise<number> {
  const fetched = await fetchWeightResponses(opts);
  return fillEngineFromResponses(engine, fetched, opts.expectedSha);
}
