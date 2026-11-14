import { describe, expect, test } from "bun:test";
import { compareReports } from "../eval/compare";
import { callsMatch, routingMatch, summarize } from "../eval/scoring";

describe("callsMatch", () => {
  test("exact name, args, and order", () => {
    const call = (name: string, args: any) => ({ name, arguments: args });
    expect(callsMatch([], [])).toBe(true);
    expect(callsMatch([call("a", {})], [call("a", {})])).toBe(true);
    expect(callsMatch([call("a", { x: "1" })], [call("a", { x: "1" })])).toBe(true);
    // Key order does not matter (dict equality like the Python original).
    expect(callsMatch(
      [call("a", { x: "1", y: "2" })], [call("a", { y: "2", x: "1" })])).toBe(true);
    expect(callsMatch([call("a", {})], [call("b", {})])).toBe(false);
    expect(callsMatch([call("a", { x: "1" })], [call("a", {})])).toBe(false);
    expect(callsMatch([call("a", {})], [])).toBe(false);
    expect(callsMatch(
      [call("a", {}), call("b", {})], [call("b", {}), call("a", {})])).toBe(false);
  });
});

describe("routingMatch", () => {
  test("names and order only", () => {
    const call = (name: string, args: any) => ({ name, arguments: args });
    expect(routingMatch([call("a", { x: "1" })], [call("a", {})])).toBe(true);
    expect(routingMatch([call("a", {})], [call("b", {})])).toBe(false);
    expect(routingMatch([], [])).toBe(true);
  });
});

describe("summarize", () => {
  test("overall, per-bucket, and negative splits", () => {
    const s = summarize([
      { id: "1", lang: "en", category: "explicit", hit: true, routingHit: true, expected: [{ name: "a", arguments: {} }], actual: [], latencyMs: 1, timedOut: false },
      { id: "2", lang: "en", category: "negative", hit: false, routingHit: false, expected: [], actual: [{ name: "a", arguments: {} }], latencyMs: 1, timedOut: false },
      { id: "3", lang: "de", category: "negative", hit: true, routingHit: true, expected: [], actual: [], latencyMs: 1, timedOut: false },
    ]);
    expect(s.total).toBe(3);
    expect(s.hits).toBe(2);
    expect(s.routingHits).toBe(2);
    expect(s.byLanguage.en).toEqual({ total: 2, hits: 1 });
    expect(s.byCategory.negative).toEqual({ total: 2, hits: 1 });
    expect(s.negatives).toBe(2);
    expect(s.negativeHits).toBe(1);
  });
});

describe("compareReports", () => {
  const rep = (sha: string, cases: [string, boolean][]) => ({
    goldenSha: sha,
    hits: cases.filter(([, h]) => h).length,
    total: cases.length,
    cases: cases.map(([id, hit]) => ({ id, hit })),
  });
  test("finds regressions and fixes", () => {
    const r = compareReports(
      rep("g", [["a", true], ["b", false], ["c", true]]),
      rep("g", [["a", false], ["b", true], ["c", true]])
    );
    expect(r.regressions).toEqual(["a"]);
    expect(r.fixes).toEqual(["b"]);
    expect(r.hitDelta).toBe(0);
  });
  test("refuses cross-golden and missing-case diffs", () => {
    expect(() => compareReports(rep("g1", [["a", true]]), rep("g2", [["a", true]]))).toThrow(/golden mismatch/);
    expect(() => compareReports(rep("g", [["a", true]]), rep("g", [["z", true]]))).toThrow(/missing from baseline/);
  });
});
