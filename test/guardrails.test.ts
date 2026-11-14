import { describe, expect, test } from "bun:test";
import {
  EngineHealth,
  IdempotencyCache,
  isTransientInferenceError,
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
      maxTokens: 48,
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
    expect(health.noteThrown()).toBe(false);
    expect(health.noteThrown()).toBe(true);
    health.noteSuccess();
    expect(health.consecutiveThrown).toBe(0);
    expect(health.noteThrown()).toBe(false);
  });
});
