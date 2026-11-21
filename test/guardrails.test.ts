import { describe, expect, test } from "bun:test";
import {
  EngineHealth,
  IdempotencyCache,
  isTransientInferenceError,
  preparePinnedTools,
  resolveEngineToolsJson,
  stableToolsKey,
  stripRequiredKeys,
  validateChatBody,
  validateToolCalls,
} from "../src/lib/guardrails";

const HANDOFF = [
  {
    name: "request_human_handoff",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["billing", "technical", "account", "complaint"] },
        details: { type: "string", maxLength: 200 },
      },
      required: [],
    },
  },
];

const msg = (content: string) => ({ messages: [{ role: "user", content }] });

describe("validateChatBody", () => {
  test("accepts a minimal chat body", () => {
    expect(validateChatBody({ ...msg("hi"), tools: HANDOFF })).toEqual({
      query: "hi",
      tools: HANDOFF,
      maxTokens: 128,
    });
  });
  test("uses the latest user message and caps max_tokens", () => {
    const out = validateChatBody({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
      max_tokens: 9999,
    });
    expect(out.query).toBe("second");
    expect(out.maxTokens).toBe(512);
  });
  test("rejects non-object, missing messages, empty and huge queries", () => {
    for (const bad of [null, [], "x", {}, { messages: "x" }, { messages: [] },
        { messages: [{ role: "user" }] }, msg(""),
        msg("x".repeat(4001)), { ...msg("hi"), tools: {} },
        { ...msg("hi"), tools: [{ function: {} }] },
        { ...msg("hi"), max_tokens: 0 }]) {
      expect(() => validateChatBody(bad)).toThrow();
    }
  });
  test("stringifies non-string content", () => {
    const out = validateChatBody({ messages: [{ role: "user", content: [{ t: 1 }] }] });
    expect(out.query).toBe(JSON.stringify([{ t: 1 }]));
  });
});

describe("validateToolCalls", () => {
  test("accepts valid handoff calls and empty lists", () => {
    expect(validateToolCalls([], HANDOFF)).toEqual([]);
    expect(validateToolCalls(
      [{ name: "request_human_handoff", arguments: { reason: "billing", details: "Paid twice." } }],
      HANDOFF)).toEqual([]);
    expect(validateToolCalls(
      [{ name: "request_human_handoff", arguments: {} }], HANDOFF)).toEqual([]);
  });
  test("rejects unknown tools, bad args, enum and length violations", () => {
    expect(validateToolCalls([{ name: "nope", arguments: {} }], HANDOFF)).toHaveLength(1);
    expect(validateToolCalls([{ name: "request_human_handoff", arguments: [] }], HANDOFF)).toHaveLength(1);
    expect(validateToolCalls(
      [{ name: "request_human_handoff", arguments: { reason: "bogus" } }], HANDOFF)).toHaveLength(1);
    expect(validateToolCalls(
      [{ name: "request_human_handoff", arguments: { details: "x".repeat(201) } }], HANDOFF)).toHaveLength(1);
    expect(validateToolCalls(
      [{ name: "request_human_handoff", arguments: { reason: 7 } }], HANDOFF)).toHaveLength(1);
    expect(validateToolCalls("nope" as any, HANDOFF)).toHaveLength(1);
  });
});

describe("IdempotencyCache", () => {
  test("replays and evicts oldest past capacity", () => {
    const cache = new IdempotencyCache(2);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", 200, "A");
    cache.set("b", 200, "B");
    expect(cache.get("a")).toEqual({ status: 200, body: "A" });
    cache.set("c", 200, "C");
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toEqual({ status: 200, body: "C" });
  });
  test("first write wins", () => {
    const cache = new IdempotencyCache();
    cache.set("a", 200, "A");
    cache.set("a", 500, "E");
    expect(cache.get("a")).toEqual({ status: 200, body: "A" });
  });
});

describe("isTransientInferenceError", () => {
  test("heap/wasm crashes retry, budget errors do not", () => {
    expect(isTransientInferenceError(new Error("Failed to allocate 99 bytes in WASM heap"))).toBe(true);
    expect(isTransientInferenceError(new Error("out of memory"))).toBe(true);
    expect(isTransientInferenceError(new Error("tool call truncated: token budget exhausted"))).toBe(false);
    expect(isTransientInferenceError(new Error("Weights already loaded."))).toBe(false);
  });
});

describe("EngineHealth", () => {
  test("trips at the threshold, resets on success", () => {
    const health = new EngineHealth(2);
    expect(health.isHealthy()).toBe(true);
    expect(health.noteThrown()).toBe(false);
    expect(health.noteThrown()).toBe(true);
    expect(health.isHealthy()).toBe(false);
    health.noteSuccess();
    expect(health.consecutiveThrown).toBe(0);
    expect(health.isHealthy()).toBe(true);
  });
});

describe("isSaturated", () => {
  test("either counter at the cap trips", async () => {
    const { isSaturated } = await import("../src/lib/guardrails");
    expect(isSaturated(0, 0)).toBe(false);
    expect(isSaturated(7, 0)).toBe(false);
    expect(isSaturated(8, 0)).toBe(true);
    expect(isSaturated(0, 8)).toBe(true);
    expect(isSaturated(3, 12)).toBe(true);
  });
});

describe("validateToolCalls types and required", () => {
  const typed = [
    {
      name: "book",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          seats: { type: "integer" },
          price: { type: "number" },
          round: { type: "boolean" },
        },
        required: ["city"],
      },
    },
  ];
  test("accepts matching types, rejects mismatches and missing required", () => {
    expect(validateToolCalls(
      [{ name: "book", arguments: { city: "Oslo", seats: 2, price: 9.5, round: true } }],
      typed)).toEqual([]);
    expect(validateToolCalls([{ name: "book", arguments: { city: "Oslo", seats: 2.5 } }], typed))
      .toHaveLength(1);
    expect(validateToolCalls([{ name: "book", arguments: { city: 7 } }], typed))
      .toHaveLength(1);
    expect(validateToolCalls([{ name: "book", arguments: { seats: 2 } }], typed))
      .toEqual(["book: missing required argument city"]);
  });
});

describe("stableToolsKey", () => {
  test("ignores object key order, honors content and array order", () => {
    const a = [{ name: "t", parameters: { b: 1, a: [1, 2] } }];
    const b = [{ parameters: { a: [1, 2], b: 1 }, name: "t" }];
    expect(stableToolsKey(a)).toBe(stableToolsKey(b));
    expect(stableToolsKey([{ name: "t2" }])).not.toBe(stableToolsKey(a));
    expect(stableToolsKey([{ name: "t" }, { name: "u" }])).not.toBe(
      stableToolsKey([{ name: "u" }, { name: "t" }])
    );
  });
});

describe("resolveEngineToolsJson", () => {
  const PINNED = preparePinnedTools(HANDOFF);
  const reordered = [
    {
      parameters: {
        required: [],
        properties: {
          details: { maxLength: 200, type: "string" },
          reason: { enum: ["billing", "technical", "account", "complaint"], type: "string" },
        },
        type: "object",
      },
      name: "request_human_handoff",
    },
  ];
  test("unpinned deployments send the caller bytes, required-stripped", () => {
    const got = resolveEngineToolsJson(HANDOFF, null);
    expect(got.pinned).toBe(false);
    expect(got.json).toBe(JSON.stringify(stripRequiredKeys(HANDOFF)));
    expect(got.json).not.toContain("required");
  });
  test("key-reordered but identical tools collapse to the pinned bytes", () => {
    const got = resolveEngineToolsJson(reordered, PINNED);
    expect(got.pinned).toBe(true);
    expect(got.json).toBe(PINNED.json);
  });
  test("pinned bytes preserve the proven serialization, not sorted keys", () => {
    expect(PINNED.json.startsWith('[{"name":')).toBe(true);
  });
  test("different content flows through untouched", () => {
    const other = [{ name: "get_weather", parameters: { type: "object" } }];
    const got = resolveEngineToolsJson(other, PINNED);
    expect(got.pinned).toBe(false);
    expect(got.json).toBe(JSON.stringify(stripRequiredKeys(other)));
  });
  test("different tool order flows through untouched", () => {
    const two = preparePinnedTools([{ name: "a" }, { name: "b" }]);
    const got = resolveEngineToolsJson([{ name: "b" }, { name: "a" }], two);
    expect(got.pinned).toBe(false);
  });
  test("different required flows through: it changes output validation", () => {
    const strict = structuredClone(HANDOFF);
    (strict[0] as any).parameters.required = ["reason"];
    const got = resolveEngineToolsJson(strict, PINNED);
    expect(got.pinned).toBe(false);
  });
});

describe("stripRequiredKeys", () => {
  test("removes required at every depth, keeps the rest", () => {
    expect(stripRequiredKeys({
      type: "object",
      properties: { reason: { enum: ["a"], required: ["x"] } },
      required: ["reason"],
    })).toEqual({
      type: "object",
      properties: { reason: { enum: ["a"] } },
    });
  });

  test("walks arrays and copies (input untouched)", () => {
    const input = [{ required: ["a"], keep: 1 }, { nested: [{ required: 1, v: 2 }] }];
    const out = stripRequiredKeys(input);
    expect(out).toEqual([{ keep: 1 }, { nested: [{ v: 2 }] }]);
    expect(input[0]).toHaveProperty("required");
  });

  test("scalars pass through", () => {
    expect(stripRequiredKeys(null)).toBeNull();
    expect(stripRequiredKeys(5)).toBe(5);
    expect(stripRequiredKeys("s")).toBe("s");
  });
});
