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

  test("\\w spans Cyrillic like Python", () => {
    const rules = loadRules({ rules: [{ id: "a", pattern: "\\bчеловек\\w*", calls: [] }] });
    expect(applyRules(rules, "с человеком")).toEqual([]);
    expect(applyRules(rules, "xчеловекy")).toBeNull();
  });

  test("\\b respects Cyrillic edges and case like Python", () => {
    const rules = loadRules({ rules: [{ id: "a", pattern: "\\bспасибо\\b", calls: [] }] });
    expect(applyRules(rules, "СПАСИБО!")).toEqual([]);
    expect(applyRules(rules, "неспасибо")).toBeNull();
    const uk = loadRules({ rules: [{ id: "a", pattern: "\\bлюдин\\w*\\b", calls: [] }] });
    expect(applyRules(uk, "з людиною")).toEqual([]);
    expect(applyRules(uk, "xлюдиною")).toBeNull();
  });

  test("shipped spec stays inside the bridge class", async () => {
    const { WORD_CH } = await import("../src/lib/rules");
    const spec = await Bun.file(
      new URL("../src/lib/fastpath.json", import.meta.url).pathname
    ).json();
    const wordChar = new RegExp(`[${WORD_CH}]`);
    const bad: string[] = [];
    for (const rule of spec.rules) {
      for (const ch of rule.pattern as string) {
        const code = ch.codePointAt(0) as number;
        if (code === 0xbf || code === 0xa1) continue; // ¿ ¡ match themselves
        // ASCII, escapes, and regex syntax pass; every other literal
        // must be a bridge word char or Python/JS diverge on it.
        if (code > 0x7e && !wordChar.test(ch)) bad.push(`${rule.id}: U+${code.toString(16)}`);
      }
      // \w and \b must not appear inside [...] classes (the transform
      // rewrites bare tokens only).
      const classes = (rule.pattern as string).match(/\[(?:\\.|[^\]\\])*\]/g) ?? [];
      for (const cls of classes) {
        if (/\\[wb]/.test(cls)) bad.push(`${rule.id}: \\w/\\b inside ${cls.slice(0, 20)}`);
      }
    }
    expect(bad).toEqual([]);
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
