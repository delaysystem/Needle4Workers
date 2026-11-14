import { describe, expect, test } from "bun:test";
import worker from "../src/index";
import { Metrics, logRequest, percentile } from "../src/lib/metrics";

describe("percentile", () => {
  test("empty, edges, and interior ranks", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.95)).toBe(7);
    const sorted = [10, 20, 30, 40];
    expect(percentile(sorted, 0.5)).toBe(20);
    expect(percentile(sorted, 0.95)).toBe(40);
  });
});

describe("Metrics", () => {
  test("counters split by class plus flags", () => {
    const m = new Metrics();
    m.record({ status: 200, latencyMs: 10 });
    m.record({ status: 200, latencyMs: 20, retried: true });
    m.record({ status: 400, latencyMs: 1 });
    m.record({ status: 429, latencyMs: 1, saturated: true });
    m.record({ status: 502, latencyMs: 5 });
    m.record({ status: 500, latencyMs: 5 });
    m.record({ status: 200, latencyMs: 0, replayed: true });
    const snap: any = m.snapshot();
    expect(snap.requests).toBe(7);
    expect(snap.ok).toBe(3);
    expect(snap.client_error).toBe(1);
    expect(snap.saturated).toBe(1);
    expect(snap.bad_gateway).toBe(1);
    expect(snap.server_error).toBe(1);
    expect(snap.retried).toBe(1);
    expect(snap.replayed).toBe(1);
    expect(snap.scope).toBe("isolate");
    expect(snap.latency_ms.count).toBe(7);
    expect(snap.latency_ms.p50).toBe(5);
  });
  test("latency ring caps memory", () => {
    const m = new Metrics();
    for (let i = 0; i < 600; i++) m.record({ status: 200, latencyMs: i });
    expect((m.snapshot() as any).latency_ms.count).toBe(512);
  });
});

describe("logRequest", () => {
  test("emits one JSON line with the needle type", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      logRequest({ status: 200, latency_ms: 3 });
    } finally {
      console.log = orig;
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ type: "needle.request", status: 200 });
  });
});

describe("GET /v1/metrics", () => {
  test("serves the snapshot without touching the engine", async () => {
    const res = await worker.fetch(
      new Request("http://localhost:8787/v1/metrics"),
      {} as any,
      {} as any
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.scope).toBe("isolate");
    expect(typeof json.requests).toBe("number");
    expect(typeof json.latency_ms.p95).toBe("number");
  });
});
