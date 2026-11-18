/** Hermetic router tests: stubbed global fetch, no weights, no network. */
import { afterEach, describe, expect, test } from "bun:test";
import router, { routeDepth } from "../router/index";

const ORIG_FETCH = globalThis.fetch;

afterEach(() => {
  (globalThis as any).fetch = ORIG_FETCH;
});

function stubFetch(handler: (url: string, init: any) => Response | Promise<Response>): string[] {
  const seen: string[] = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    seen.push(String(url));
    return handler(String(url), init);
  };
  return seen;
}

const ENV: any = {
  ROUTE_POLICY: "depth-split",
  BACKEND_4L_URL: "https://w4.example",
  BACKEND_16L_URL: "https://w16.example",
  BACKEND_20L_URL: "https://w20.example",
};

const TOOLS = [{ name: "request_human_handoff" }];

function chatReq(nUser: number, headers: Record<string, string> = {}, query = "Some query here please?") {
  const messages = [];
  for (let i = 0; i < nUser; i++) {
    messages.push({ role: "user", content: `${query} (${i})` });
    if (i < nUser - 1) messages.push({ role: "assistant", content: "ok" });
  }
  return new Request("http://router/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ messages, tools: TOOLS }),
  });
}

const okBackend = (model: string) =>
  new Response(JSON.stringify({ choices: [{ message: { tool_calls: [] } }], model }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("routeDepth", () => {
  test("single-20 always, depth-split by turns", () => {
    expect(routeDepth(1, "single-20")).toBe(20);
    expect(routeDepth(9, "single-20")).toBe(20);
    expect(routeDepth(1, "depth-split")).toBe(4);
    expect(routeDepth(2, "depth-split")).toBe(16);
    expect(routeDepth(3, "depth-split")).toBe(20);
    expect(routeDepth(0, "depth-split")).toBe(4);
  });
});

describe("router policy", () => {
  test("depth-split proxies 1/2/3+ turns to 4/16/20", async () => {
    for (const [turns, host] of [[1, "w4"], [2, "w16"], [5, "w20"]] as const) {
      const seen = stubFetch(async () => okBackend(`m-${host}`));
      const res = await router.fetch(chatReq(turns), ENV, {} as any);
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(`https://${host}.example/v1/chat/completions`);
      expect(res.headers.get("X-Served-By-Depth")).toBe(host === "w4" ? "4" : host === "w16" ? "16" : "20");
    }
  });
  test("single-20 sends everything to 20L", async () => {
    const seen = stubFetch(async () => okBackend("m"));
    const env = { ...ENV, ROUTE_POLICY: "single-20" };
    for (const turns of [1, 2, 7]) {
      const res = await router.fetch(chatReq(turns), env, {} as any);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Served-By-Depth")).toBe("20");
    }
    expect(seen.every((u) => u.includes("w20.example"))).toBe(true);
  });
  test("X-Needle-Depth override wins and validates", async () => {
    const seen = stubFetch(async () => okBackend("m"));
    const res = await router.fetch(chatReq(5, { "X-Needle-Depth": "4" }), ENV, {} as any);
    expect(res.status).toBe(200);
    expect(seen[0]).toContain("w4.example");
    const bad = await router.fetch(chatReq(1, { "X-Needle-Depth": "8" }), ENV, {} as any);
    expect(bad.status).toBe(400);
  });
  test("missing backend URL is a loud 500", async () => {
    stubFetch(async () => okBackend("m"));
    const res = await router.fetch(chatReq(1), { ...ENV, BACKEND_4L_URL: undefined }, {} as any);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("no backend for depth 4");
  });
});

describe("router fallback", () => {
  test("4L 500 falls back to 20L with header", async () => {
    const seen = stubFetch(async (url) =>
      url.includes("w4.example") ? new Response("bad", { status: 500 }) : okBackend("m20"));
    const res = await router.fetch(chatReq(1), ENV, {} as any);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(res.headers.get("X-Served-By-Depth")).toBe("20");
    expect(res.headers.get("X-Needle-Fell-Back")).toBe("1");
  });
  test("20L status passes through, unreachable 20L is a 502", async () => {
    const seen = stubFetch(async () => new Response("bad", { status: 500 }));
    const res = await router.fetch(chatReq(9), ENV, {} as any);
    expect(res.status).toBe(500);
    expect(seen).toHaveLength(1);
    expect(res.headers.get("X-Served-By-Depth")).toBe("20");
    stubFetch(async () => {
      throw new Error("connect refused");
    });
    const down = await router.fetch(chatReq(9), ENV, {} as any);
    expect(down.status).toBe(502);
  });
});

describe("router fastpath", () => {
  test("unambiguous ask answered without any fetch", async () => {
    const seen = stubFetch(async () => okBackend("m"));
    const res = await router.fetch(
      new Request("http://router/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Please, get me a human." }],
          tools: [{ name: "request_human_handoff" }],
        }),
      }),
      ENV,
      {} as any
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
    expect(res.headers.get("X-Served-By-Depth")).toBe("fastpath");
    const payload: any = await res.json();
    expect(payload.choices[0].message.tool_calls[0].function.name).toBe("request_human_handoff");
  });
});

describe("router misc routes", () => {
  test("401 with AUTH_TOKEN set, /ready reflects 20L", async () => {
    const authed = { ...ENV, AUTH_TOKEN: "tok" };
    const denied = await router.fetch(chatReq(1), authed, {} as any);
    expect(denied.status).toBe(401);
    stubFetch(async (url) =>
      url.includes("w20.example") ? new Response("{}") : new Response("x", { status: 500 }));
    const ready = await router.fetch(new Request("http://router/ready"), ENV, {} as any);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as any).ready).toBe(true);
    const health: any = await (
      await router.fetch(new Request("http://router/health"), ENV, {} as any)
    ).json();
    expect(health.service).toBe("needle-router");
  });
});
