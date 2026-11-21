import { describe, expect, test } from "bun:test";
import {
  fetchWeightResponses,
  fillEngineFromResponses,
  loadWeightsIntoEngine,
} from "../src/lib/weights";

function fetcher(files: Record<string, Uint8Array>, calls: string[] = []) {
  return {
    fetch: async (req: Request) => {
      const name = new URL(req.url).pathname.split("/").pop() as string;
      calls.push(name);
      const bytes = files[name];
      if (!bytes) return new Response("nope", { status: 404 });
      return new Response(bytes as any, {
        headers: { "content-length": String(bytes.byteLength) },
      });
    },
    calls,
  };
}

/** No Content-Length: forces the accumulate fallback. */
function lengthlessFetcher(files: Record<string, Uint8Array>) {
  return {
    fetch: async (req: Request) => {
      const name = new URL(req.url).pathname.split("/").pop() as string;
      const bytes = files[name];
      if (!bytes) return new Response("nope", { status: 404 });
      return {
        ok: true,
        headers: { get: (_: string) => null },
        arrayBuffer: async () => bytes.buffer as ArrayBuffer,
      } as unknown as Response;
    },
  };
}

async function shaOf(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fakeEngine(rc = 0) {
  const calls: string[] = [];
  let mem = new Uint8Array(0);
  return {
    calls,
    mem: () => mem,
    allocWeights(total: number) { calls.push(`alloc:${total}`); mem = new Uint8Array(total); return 1000; },
    writeWeightsChunk(ptr: number, offset: number, chunk: Uint8Array) {
      calls.push(`write:${offset}:${chunk.length}`);
      mem.set(chunk, offset);
    },
    finishWeightsLoad(ptr: number, total: number) { calls.push(`finish:${ptr}:${total}`); return rc; },
    discardWeights(ptr: number) { calls.push(`discard:${ptr}`); },
  };
}

describe("loadWeightsIntoEngine", () => {
  test("streams chunks into one allocation at ascending offsets", async () => {
    const f = fetcher({ "a.aa": new Uint8Array([1, 2]), "a.ab": new Uint8Array([3]) });
    const eng = fakeEngine();
    const rc = await loadWeightsIntoEngine(eng, {
      chunks: ["/a.aa", "/a.ab"], baseUrl: "http://x/",
      assetsFetcher: f, expectedSha: await shaOf("\x01\x02\x03"),
    });
    expect(rc).toBe(0);
    expect(eng.calls).toEqual(["alloc:3", "write:0:2", "write:2:1", "finish:1000:3"]);
    expect([...eng.mem()]).toEqual([1, 2, 3]);
  });
  test("sha mismatch fails loudly and discards the allocation", async () => {
    const f = fetcher({ "a.aa": new Uint8Array([9]) });
    const eng = fakeEngine();
    await expect(loadWeightsIntoEngine(eng, {
      chunks: ["/a.aa"], baseUrl: "http://x/",
      assetsFetcher: f, expectedSha: "00".repeat(32),
    })).rejects.toThrow(/sha256 mismatch/);
    expect(eng.calls).toEqual(["alloc:1", "write:0:1", "discard:1000"]);
  });
  test("missing chunk names the chunk", async () => {
    const f = fetcher({});
    const eng = fakeEngine();
    await expect(loadWeightsIntoEngine(eng, {
      chunks: ["/gone.aa"], baseUrl: "http://x/", assetsFetcher: f,
    })).rejects.toThrow(/Static asset missing: \/gone\.aa \(404\)/);
    expect(eng.calls).toEqual([]);
  });
  test("servers without Content-Length fall back to accumulate-then-write", async () => {
    const f = lengthlessFetcher({ "a.aa": new Uint8Array([4, 5]) });
    const eng = fakeEngine();
    const rc = await loadWeightsIntoEngine(eng, {
      chunks: ["/a.aa"], baseUrl: "http://x/",
      assetsFetcher: f, expectedSha: await shaOf("\x04\x05"),
    });
    expect(rc).toBe(0);
    expect(eng.calls).toEqual(["alloc:2", "write:0:2", "finish:1000:2"]);
    expect([...eng.mem()]).toEqual([4, 5]);
  });
  test("engine rc passes through (index refuses nonzero)", async () => {
    const f = fetcher({ "a.aa": new Uint8Array([1]) });
    const eng = fakeEngine(7);
    const rc = await loadWeightsIntoEngine(eng, {
      chunks: ["/a.aa"], baseUrl: "http://x/", assetsFetcher: f,
    });
    expect(rc).toBe(7);
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
      await expect(loadWeightsIntoEngine(fakeEngine(), {
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
      await loadWeightsIntoEngine(fakeEngine(), {
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

describe("fetchWeightResponses + fillEngineFromResponses", () => {
  test("split phases compose to the one-shot load's byte sequence", async () => {
    const f = fetcher({ "a.aa": new Uint8Array([1, 2]), "a.ab": new Uint8Array([3]) });
    const fetched = await fetchWeightResponses({
      chunks: ["/a.aa", "/a.ab"], baseUrl: "http://x/", assetsFetcher: f,
    });
    expect(fetched.responses).toHaveLength(2);
    const eng = fakeEngine();
    const rc = await fillEngineFromResponses(eng, fetched, await shaOf("\x01\x02\x03"));
    expect(rc).toBe(0);
    expect(eng.calls).toEqual(["alloc:3", "write:0:2", "write:2:1", "finish:1000:3"]);
    expect([...eng.mem()]).toEqual([1, 2, 3]);
  });
  test("fetch needs no engine: it stays in flight while other work runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = fetcher({ "a.aa": new Uint8Array([7]) });
    const gated = { fetch: async (req: Request) => { await gate; return inner.fetch(req); } };
    const pending = fetchWeightResponses({
      chunks: ["/a.aa"], baseUrl: "http://x/", assetsFetcher: gated,
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    // Still parked on the gate: the caller was free to instantiate WASM meanwhile.
    expect(settled).toBe(false);
    release();
    const fetched = await pending;
    const eng = fakeEngine();
    const rc = await fillEngineFromResponses(eng, fetched, await shaOf("\x07"));
    expect(rc).toBe(0);
    expect([...eng.mem()]).toEqual([7]);
  });
  test("fill rejects a failed response before touching the engine", async () => {
    const f = fetcher({});
    const fetched = await fetchWeightResponses({
      chunks: ["/gone.aa"], baseUrl: "http://x/", assetsFetcher: f,
    });
    const eng = fakeEngine();
    await expect(fillEngineFromResponses(eng, fetched, null))
      .rejects.toThrow(/Static asset missing: \/gone\.aa \(404\)/);
    expect(eng.calls).toEqual([]);
  });
});
