import { describe, expect, test } from "bun:test";
import { classifyMiss, summarizeFailures } from "../eval/failures";

const call = (name: string, args: any) => ({ name, arguments: args });
const H = "request_human_handoff";

describe("classifyMiss", () => {
  test("presence errors", () => {
    expect(classifyMiss({ id: "1", expected: [], actual: [call(H, {})] }))
      .toEqual(["false-positive"]);
    expect(classifyMiss({ id: "2", expected: [call(H, {})], actual: [] }))
      .toEqual(["false-negative"]);
  });
  test("arity and wrong tool", () => {
    expect(classifyMiss({ id: "3", expected: [call(H, {})], actual: [call(H, {}), call(H, {})] }))
      .toEqual(["arity"]);
    expect(classifyMiss({ id: "4", expected: [call(H, {})], actual: [call("other", {})] }))
      .toEqual(["wrong-tool"]);
  });
  test("reason tags", () => {
    const exp = [call(H, { details: "Late." })];
    expect(classifyMiss({ id: "5", expected: exp, actual: [call(H, { details: "Late.", reason: "billing" })] }))
      .toEqual(["spurious-reason"]);
    expect(classifyMiss({ id: "6", expected: [call(H, { details: "Late.", reason: "billing" })], actual: exp }))
      .toEqual(["missing-reason"]);
    expect(classifyMiss({
      id: "7",
      expected: [call(H, { reason: "billing" })],
      actual: [call(H, { reason: "technical" })],
    })).toEqual(["wrong-reason"]);
  });
  test("details tags", () => {
    expect(classifyMiss({ id: "8", expected: [call(H, {})], actual: [call(H, { details: "X." })] }))
      .toEqual(["extra-details"]);
    expect(classifyMiss({ id: "9", expected: [call(H, { details: "X." })], actual: [call(H, {})] }))
      .toEqual(["missing-details"]);
    expect(classifyMiss({
      id: "10",
      expected: [call(H, { details: "First." })],
      actual: [call(H, { details: "Second." })],
    })).toEqual(["span-pick"]);
  });
  test("one miss can carry several tags", () => {
    expect(classifyMiss({
      id: "11",
      expected: [call(H, { details: "First." })],
      actual: [call(H, { details: "Second.", reason: "billing" })],
    })).toEqual(["spurious-reason", "span-pick"]);
  });
  test("exact matches carry no tags", () => {
    expect(classifyMiss({ id: "12", expected: [call(H, { details: "X." })], actual: [call(H, { details: "X." })] }))
      .toEqual([]);
  });
});

describe("summarizeFailures", () => {
  test("counts tags across misses", () => {
    const report = summarizeFailures([
      { id: "a", expected: [], actual: [call(H, {})] },
      { id: "b", expected: [call(H, {})], actual: [] },
      { id: "c", expected: [], actual: [call(H, {})] },
    ]);
    expect(report.misses).toBe(3);
    expect(report.tags).toEqual({ "false-positive": 2, "false-negative": 1 });
    expect(report.cases.a).toEqual(["false-positive"]);
  });
});
