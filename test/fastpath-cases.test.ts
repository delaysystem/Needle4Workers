/** Ported adversarial cases: every Needle4Humans fastpath case runs here.
 *
 * The fixture is a verbatim copy of tasks/human_handoff/fastpath_cases.jsonl
 * plus the spec; if any case diverges, the Python/TS engines disagree and
 * the port (not the case) is wrong. Provenance: see SYNC note below.
 *
 * SYNC: refresh both files from Needle4Humans when the Python side changes:
 *   cp ../../Needle4Humans/tasks/human_handoff/fastpath.json src/lib/fastpath.json
 *   cp ../../Needle4Humans/tasks/human_handoff/fastpath_cases.jsonl test/fixtures/fastpath_cases.jsonl
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import spec from "../src/lib/fastpath.json";
import { applyRules, callsEqual, loadRules } from "../src/lib/rules";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const rules = loadRules(spec);
const cases = fs.readFileSync(path.join(ROOT, "test/fixtures/fastpath_cases.jsonl"), "utf-8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

describe("ported fastpath cases", () => {
  test("fixture is non-empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const [index, c] of cases.entries()) {
    const label = `${String(index).padStart(3, "0")}-${c.calls === null ? "fallthrough" : "fire"}`;
    test(label, () => {
      const got = applyRules(rules, c.query);
      if (c.calls === null || c.calls === undefined) {
        expect(got).toBeNull();
      } else {
        expect(callsEqual(got, c.calls)).toBe(true);
      }
    });
  }
});

describe("golden static gate", () => {
  test("every rule fire equals its gold exactly — all 252 cases", () => {
    const rows = fs.readFileSync(path.join(ROOT, "eval/goldens/eval.jsonl"), "utf-8")
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.length).toBe(252);
    const violations: string[] = [];
    let hits = 0;
    for (const row of rows) {
      const got = applyRules(rules, row.query);
      if (got === null) continue;
      hits++;
      const want = (row.answers ?? []).map((c: any) => ({ name: c.name, arguments: c.arguments ?? {} }));
      if (!callsEqual(got, want)) violations.push(`${row.id}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
    expect(violations).toEqual([]);
    console.log(`rules fire on ${hits}/252 goldens, 0 violations`);
  });
});
