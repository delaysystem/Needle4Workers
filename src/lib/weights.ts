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
}

/** B2 fallback config from env, or null when its secrets are absent. */
export function b2ConfigFromEnv(env: Env): B2WeightsConfig | null {
  const e = env as any;
  return e.BACKBLAZE_KEY_ID && e.BACKBLAZE_APPLICATION_KEY && e.BACKBLAZE_BUCKET_NAME
    ? { keyId: e.BACKBLAZE_KEY_ID, applicationKey: e.BACKBLAZE_APPLICATION_KEY, bucketName: e.BACKBLAZE_BUCKET_NAME, prefix: env.B2_WEIGHTS_PREFIX || "needle" }
    : null;
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

async function readOkResponses(
  responses: Response[],
  describe: (i: number) => string
): Promise<Uint8Array> {
  for (let i = 0; i < responses.length; i++) {
    if (!responses[i].ok) {
      const body = await responses[i].text().catch(() => "");
      throw new Error(`${describe(i)} (${responses[i].status}): ${body}`);
    }
  }
  const buffers = await Promise.all(responses.map((r) => r.arrayBuffer()));
  return concatParts(buffers.map((b) => new Uint8Array(b)));
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
 * Loads model weights from chunked static assets, falling back to the same
 * chunk files in B2 when assets fail and B2 is configured. No other source.
 */
export async function getOrFetchWeights(
  opts: WeightsLoadOptions
): Promise<Uint8Array> {
  if (opts.chunks.length === 0) {
    throw new Error("No weights chunks configured (WEIGHTS_CHUNKS is empty)");
  }

  let assetsError: unknown = null;
  if (opts.assetsFetcher && typeof opts.assetsFetcher.fetch === "function") {
    try {
      const responses = await Promise.all(
        opts.chunks.map((c) =>
          opts.assetsFetcher!.fetch(new Request(new URL(c, opts.baseUrl).toString()))
        )
      );
      return await readOkResponses(responses, (i) => `Static asset missing: ${opts.chunks[i]}`);
    } catch (err) {
      assetsError = err;
    }
  } else {
    assetsError = new Error("Static assets binding (ASSETS) is unavailable");
  }

  if (opts.b2) {
    const b2 = opts.b2;
    const { authorizationToken, downloadUrl } = await b2Authorize(b2);
    const prefix = b2.prefix.replace(/^\/+|\/+$/g, "");
    const urls = opts.chunks.map((c) => {
      const file = encodeURIComponent(`${prefix}/${c.split("/").pop()}`).replace(/%2F/g, "/");
      return `${downloadUrl.replace(/\/+$/, "")}/file/${b2.bucketName}/${file}`;
    });
    const responses = await Promise.all(
      urls.map((u) => fetch(u, { headers: { Authorization: authorizationToken } }))
    );
    return await readOkResponses(responses, (i) => `B2 chunk fetch failed: ${urls[i]}`);
  }

  throw assetsError instanceof Error
    ? assetsError
    : new Error("Weights unavailable: static assets failed and B2 fallback is not configured");
}
