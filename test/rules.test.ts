/** Engine unit tests (port of Needle4Humans tests/test_fastpath.py). */
import { describe, expect, test } from "bun:test";
import { applyRules, callsEqual, loadRules, runCases } from "../src/lib/rules";

describe("first match wins", () => {
  test("earlier rule shadows later", () => {
    const rules = loadRules({ rules: [
      { id: "a", pattern: "hi", calls: [{ name: "t", arguments: {} }] },
      { id: "b", pattern: "hi", calls: [] },
    ]});
    expect(applyRules(rules, "hi there")).toEqual([{ name: "t", arguments: {} }]);
  });

  test("no match returns null", () => {
    const rules = loadRules({ rules: [{ id: "a", pattern: "zzz", calls: [] }] });
    expect(applyRules(rules, "hi there")).toBeNull();
  });
});

describe("case handling", () => {
  test("insensitive by default, sensitive on request", () => {
    const rules = loadRules({ rules: [
      { id: "i", pattern: "stop", calls: [] },
      { id: "s", pattern: "Go", calls: [], case: "sensitive" },
    ]});
    expect(applyRules(rules, "STOP!")).toEqual([]);
    expect(applyRules(rules, "go now")).toBeNull();
    expect(applyRules(rules, "Go now")).toEqual([]);
  });
});

describe("unicode bridge", () => {
  test("\\w spans Latin diacritics like Python", () => {
    const rules = loadRules({ rules: [{ id: "a", pattern: "konsultant\\w*", calls: [] }] });
    expect(applyRules(rules, "konsultantką")).toEqual([]);
  });

  test("\\b respects non-ASCII word edges like Python", () => {
    const rules = loadRules({ rules: [{ id: "a", pattern: "\\bdañ\\w*\\b", calls: [] }] });
    expect(applyRules(rules, "conductor dañó mi valla")).toEqual([]);
    expect(applyRules(rules, "xdañóy")).toBeNull();
  });

  test("word char class does not leak across spaces", () => {
    const rules = loadRules({ rules: [{ id: "a", pattern: "\\bhumain\\b", calls: [] }] });
    expect(applyRules(rules, "un humain!")).toEqual([]);
    expect(applyRules(rules, "inhumains")).toBeNull();
  });
});

describe("verdict copies", () => {
  test("calls are copied, not aliased", () => {
    const rules = loadRules({ rules: [
      { id: "a", pattern: "x", calls: [{ name: "t", arguments: { r: 1 } }] },
    ]});
    const first = applyRules(rules, "x")!;
    (first[0].arguments as any).r = 999;
    expect(applyRules(rules, "x")).toEqual([{ name: "t", arguments: { r: 1 } }]);
  });
});

describe("spec validation", () => {
  const bad = [
    { rules: [] },
    { rules: [{ pattern: "x", calls: [] }] },
    { rules: [{ id: "a", calls: [] }] },
    { rules: [{ id: "a", pattern: "(", calls: [] }] },
    { rules: [{ id: "a", pattern: "x" }] },
    { rules: [{ id: "a", pattern: "x", calls: [] }, { id: "a", pattern: "y", calls: [] }] },
    { rules: [{ id: "a", pattern: "x", calls: [{ name: 5, arguments: {} }] }] },
    { rules: "nope" },
    {},
  ];
  for (const [i, spec] of bad.entries()) {
    test(`bad spec #${i} throws`, () => {
      expect(() => loadRules(spec)).toThrow();
    });
  }
});

describe("callsEqual", () => {
  test("ignores key order, respects values", () => {
    expect(callsEqual(
      [{ name: "t", arguments: { a: 1, b: 2 } }],
      [{ name: "t", arguments: { b: 2, a: 1 } }],
    )).toBe(true);
    expect(callsEqual(
      [{ name: "t", arguments: { a: 1 } }],
      [{ name: "t", arguments: { a: 2 } }],
    )).toBe(false);
    expect(callsEqual(null, [])).toBe(false);
    expect(callsEqual([], [])).toBe(true);
  });
});

describe("runCases", () => {
  test("empty failures on match, messages on mismatch", () => {
    const rules = loadRules({ rules: [{ id: "a", pattern: "hi", calls: [{ name: "t", arguments: {} }] }] });
    expect(runCases(rules, [
      { query: "hi", calls: [{ name: "t", arguments: {} }] },
      { query: "bye", calls: null },
    ])).toEqual([]);
    expect(runCases(rules, [
      { query: "bye", calls: [{ name: "t", arguments: {} }] },
      { query: "hi", calls: null },
    ])).toHaveLength(2);
  });
});
