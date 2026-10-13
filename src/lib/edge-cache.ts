interface MemoryCacheEntry {
  data: any;
  expiresAt: number;
}

const toolCallMemoryCache = new Map<string, MemoryCacheEntry>();
const weightsMemoryCache = new Map<string, Uint8Array>();

/**
 * Sorts object keys recursively to guarantee deterministic JSON serialization.
 */
function sortKeys(value: any): any {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Generates a deterministic SHA-256 cache key from query, tools schema, and temperature.
 */
export async function getDeterministicCacheKey(
  query: string,
  toolsJson: string,
  temperature: number = 0
): Promise<string> {
  let normalizedTools = toolsJson.trim();
  try {
    const parsed = JSON.parse(toolsJson);
    normalizedTools = JSON.stringify(sortKeys(parsed));
  } catch {
    // Keep trimmed string if not valid JSON
  }

  const normalizedQuery = query.trim();
  const normalizedTemp = Number(temperature || 0).toFixed(4);
  const combined = `needle-cache:v1:${normalizedQuery}:::${normalizedTools}:::${normalizedTemp}`;

  const data = new TextEncoder().encode(combined);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Slashes cold starts by caching weights via the Cloudflare Edge Cache API (caches.default).
 * In non-Worker environments (e.g. Node/Bun tests), falls back to an in-memory cache and standard fetch.
 */
export async function getOrFetchWeights(
  url: string,
  ctx?: ExecutionContext,
  r2Bucket?: any
): Promise<Uint8Array> {
  const cache = typeof caches !== "undefined" ? (caches as any).default : null;
  const cacheKey = new Request(url);

  // 1. Check Edge Cache first
  if (cache) {
    const cachedRes = await cache.match(cacheKey);
    if (cachedRes) {
      return new Uint8Array(await cachedRes.arrayBuffer());
    }
  }

  // 2. Check R2 Bucket binding if provided
  if (r2Bucket && typeof r2Bucket.get === "function") {
    const filename = url.split("/").pop() || "needle3-16l.cact";
    const object = await r2Bucket.get(filename);
    if (object) {
      const buffer = await object.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (cache) {
        const edgeRes = new Response(bytes, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(cache.put(cacheKey, edgeRes));
        } else {
          await cache.put(cacheKey, edgeRes).catch(() => {});
        }
      }
      return bytes;
    }
  }

  if (cache) {
    const fetchOptions: RequestInit = {
      // @ts-ignore
      cf: { cacheEverything: true, cacheTtl: 31536000 },
    };

    const res = await fetch(cacheKey, fetchOptions);
    if (!res.ok) {
      throw new Error(`Failed to fetch weights from ${url}: ${res.status} ${res.statusText}`);
    }

    const clone = res.clone();
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(cache.put(req, clone));
    } else {
      await cache.put(req, clone).catch(() => {});
    }

    return new Uint8Array(await res.arrayBuffer());
  }

  // Fallback for Node.js / testing environments without caches.default
  if (weightsMemoryCache.has(url)) {
    return weightsMemoryCache.get(url)!;
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch weights from ${url}: ${res.status} ${res.statusText}`);
  }

  const buffer = new Uint8Array(await res.arrayBuffer());
  weightsMemoryCache.set(url, buffer);
  return buffer;
}

/**
 * Retrieves a cached tool call response from Cloudflare KV or in-memory LRU cache.
 */
export async function getCachedToolCall(
  key: string,
  kv?: KVNamespace
): Promise<any | null> {
  if (kv) {
    try {
      const cached = await kv.get(key, "json");
      if (cached !== null && cached !== undefined) {
        return cached;
      }
    } catch {
      // Fallback to in-memory cache on KV read error
    }
  }

  const memEntry = toolCallMemoryCache.get(key);
  if (memEntry) {
    if (memEntry.expiresAt > Date.now()) {
      return memEntry.data;
    }
    toolCallMemoryCache.delete(key);
  }

  return null;
}

/**
 * Stores a tool call result in Cloudflare KV or in-memory LRU cache.
 */
export async function setCachedToolCall(
  key: string,
  data: any,
  kv?: KVNamespace,
  ttlSeconds: number = 86400,
  ctx?: ExecutionContext
): Promise<void> {
  // Store in memory cache
  toolCallMemoryCache.set(key, {
    data,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });

  // Limit memory cache to 1000 entries
  if (toolCallMemoryCache.size > 1000) {
    const oldestKey = toolCallMemoryCache.keys().next().value;
    if (oldestKey) {
      toolCallMemoryCache.delete(oldestKey);
    }
  }

  // Store in KV if available
  if (kv) {
    const putPromise = kv.put(key, JSON.stringify(data), {
      expirationTtl: ttlSeconds,
    });

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(putPromise);
    } else {
      await putPromise;
    }
  }
}

/**
 * Helper to clear in-memory caches (useful for testing).
 */
export function clearEdgeCacheMemory(): void {
  toolCallMemoryCache.clear();
  weightsMemoryCache.clear();
}

export default {
  getDeterministicCacheKey,
  getOrFetchWeights,
  getCachedToolCall,
  setCachedToolCall,
  clearEdgeCacheMemory,
};
