import { afterEach, describe, expect, test } from "bun:test";
import { clearWeightsCache, getOrFetchWeights } from "../src/lib/weights";

afterEach(clearWeightsCache);

function fetcher(files: Record<string, Uint8Array>, calls: string[] = []) {
  return {
    fetch: async (req: Request) => {
      const name = new URL(req.url).pathname.split("/").pop() as string;
      calls.push(name);
      const bytes = files[name];
      if (!bytes) return new Response("nope", { status: 404 });
      return new Response(bytes as any);
    },
    calls,
  };
}

async function shaOf(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("getOrFetchWeights", () => {
  test("concatenates chunks and verifies sha", async () => {
    const f = fetcher({ "a.aa": new Uint8Array([1, 2]), "a.ab": new Uint8Array([3]) });
    const bytes = await getOrFetchWeights({
      chunks: ["/a.aa", "/a.ab"], baseUrl: "http://x/",
      assetsFetcher: f, expectedSha: await shaOf("\x01\x02\x03"),
    });
    expect([...bytes]).toEqual([1, 2, 3]);
  });
  test("sha mismatch fails loudly", async () => {
    const f = fetcher({ "a.aa": new Uint8Array([9]) });
    await expect(getOrFetchWeights({
      chunks: ["/a.aa"], baseUrl: "http://x/",
      assetsFetcher: f, expectedSha: "00".repeat(32),
    })).rejects.toThrow(/sha256 mismatch/);
  });
  test("second load serves the cache without refetching", async () => {
    const f = fetcher({ "a.aa": new Uint8Array([1]) });
    await getOrFetchWeights({ chunks: ["/a.aa"], baseUrl: "http://x/", assetsFetcher: f });
    await getOrFetchWeights({ chunks: ["/a.aa"], baseUrl: "http://x/", assetsFetcher: f });
    expect(f.calls).toEqual(["a.aa"]);
  });
  test("B2 errors name the chunk, not the signed URL", async () => {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
      const u = String(url.url ?? url);
      if (u.includes("b2_authorize_account")) {
        return new Response(JSON.stringify({
          authorizationToken: "tok", downloadUrl: "https://secret.host:443",
        }));
      }
      return new Response("denied", { status: 403 });
    };
    try {
      await expect(getOrFetchWeights({
        chunks: ["/w.aa"], baseUrl: "http://x/", assetsFetcher: null,
        b2: { keyId: "k", applicationKey: "s", bucketName: "bkt", prefix: "p" },
      })).rejects.toThrow(/B2 chunk fetch failed: w\.aa/);
    } finally {
      (globalThis as any).fetch = orig;
    }
    // And the thrown message carries no host or bucket.
    (globalThis as any).fetch = async (url: any) => {
      const u = String(url.url ?? url);
      if (u.includes("b2_authorize_account")) {
        return new Response(JSON.stringify({
          authorizationToken: "tok", downloadUrl: "https://secret.host:443",
        }));
      }
      return new Response("denied", { status: 403 });
    };
    try {
      await getOrFetchWeights({
        chunks: ["/w.aa"], baseUrl: "http://x/", assetsFetcher: null,
        b2: { keyId: "k", applicationKey: "s", bucketName: "bkt", prefix: "p" },
      });
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).not.toContain("secret.host");
      expect(err.message).not.toContain("bkt");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
});
