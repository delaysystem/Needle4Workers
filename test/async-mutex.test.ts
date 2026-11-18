import { describe, expect, test } from "bun:test";
import { AsyncMutex, MAX_AFFINITY_SKIPS } from "../src/lib/async-mutex";

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("AsyncMutex", () => {
  test("runs unkeyed callers FIFO (backward compatible)", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    const g = gate();
    const p0 = mutex.runExclusive(async () => { order.push("a"); await g.promise; });
    const p1 = mutex.runExclusive(async () => { order.push("b"); });
    const p2 = mutex.runExclusive(async () => { order.push("c"); });
    expect(mutex.isLocked).toBe(true);
    expect(mutex.queueLength).toBe(2);
    g.resolve();
    await Promise.all([p0, p1, p2]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(mutex.isLocked).toBe(false);
    expect(mutex.queueLength).toBe(0);
  });

  test("prefers the waiter matching the last-served key (prefix-cache affinity)", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    const gx = gate();
    const ga = gate();
    // X holds the lock; B(other tools) arrives before A2(same tools as X).
    const px = mutex.runExclusive(async () => { order.push("x"); await gx.promise; }, "X");
    const pb = mutex.runExclusive(async () => { order.push("b"); }, "Y");
    const pa = mutex.runExclusive(async () => { order.push("a2"); await ga.promise; }, "X");
    expect(mutex.queueLength).toBe(2);
    gx.resolve();
    await px;
    // A2 must run before B despite arriving later: same tools, cache hit.
    ga.resolve();
    await Promise.all([pb, pa]);
    expect(order).toEqual(["x", "a2", "b"]);
  });

  test("starvation bound: the head runs after MAX_AFFINITY_SKIPS affinity picks", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    const gates = Array.from({ length: MAX_AFFINITY_SKIPS + 2 }, () => gate());
    const head = mutex.runExclusive(async () => { order.push("x0"); await gates[0].promise; }, "X");
    const py = mutex.runExclusive(async () => { order.push("y"); }, "Y");
    const rest = Array.from({ length: MAX_AFFINITY_SKIPS + 1 }, (_, i) =>
      mutex.runExclusive(async () => {
        order.push(`x${i + 1}`);
        await gates[i + 1].promise;
      }, "X")
    );
    // Drain in the order the mutex grants: X-run, then MAX skips, then the
    // forced FIFO head Y, then the remaining X.
    gates[0].resolve();
    await head;
    for (let i = 1; i <= MAX_AFFINITY_SKIPS; i++) {
      gates[i].resolve();
      await rest[i - 1];
    }
    await py;
    gates[MAX_AFFINITY_SKIPS + 1].resolve();
    await rest[MAX_AFFINITY_SKIPS];
    expect(order).toEqual([
      "x0",
      ...Array.from({ length: MAX_AFFINITY_SKIPS }, (_, i) => `x${i + 1}`),
      "y",
      `x${MAX_AFFINITY_SKIPS + 1}`,
    ]);
  });

  test("never overlaps bodies, including across the grant handoff", async () => {
    const mutex = new AsyncMutex();
    let inside = 0;
    let maxInside = 0;
    const worker = async (key: string) => {
      await mutex.runExclusive(async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 0));
        inside--;
      }, key);
    };
    // Newcomers arrive while grants are in flight: none may slip ahead.
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => worker(i % 2 === 0 ? "X" : "Y")),
      (async () => {
        await new Promise((r) => setTimeout(r, 1));
        await Promise.all(Array.from({ length: 10 }, () => worker("Z")));
      })(),
    ]);
    expect(maxInside).toBe(1);
    expect(mutex.isLocked).toBe(false);
  });

  test("releases the lock when the body throws", async () => {
    const mutex = new AsyncMutex();
    await expect(mutex.runExclusive(async () => { throw new Error("boom"); }, "X")).rejects.toThrow("boom");
    expect(mutex.isLocked).toBe(false);
    const out = await mutex.runExclusive(async () => "ok", "X");
    expect(out).toBe("ok");
  });
});
