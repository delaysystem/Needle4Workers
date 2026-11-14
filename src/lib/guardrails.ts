/** Runtime guardrails for the chat-completions path: pure and unit-testable.
 *
 * - `validateChatBody`: deterministic request validation (400s, never inference).
 * - `validateToolCalls`: model-output schema check against the caller-supplied
 *   tool schemas (unknown tool, non-object args, enum/maxLength/type violations).
 * - `IdempotencyCache`: bounded replay store keyed by client request id.
 * - `isTransientInferenceError`: retry policy input — only thrown engine
 *   errors retry (after a reset); `success:false` model outcomes do not.
 * - `EngineHealth`: consecutive-thrown-failure counter; callers drop and
 *   rebuild the engine singleton past the threshold.
 */

export interface ValidChatBody {
  query: string;
  tools: any[];
  maxTokens: number;
}

export const MAX_QUERY_CHARS = 4000;
export const MAX_TOKENS_CAP = 512;
export const MAX_QUEUE_LENGTH = 8;
export const IDEMPOTENCY_CAP = 200;
export const ENGINE_RELOAD_AFTER_THROWN = 3;

export function validateChatBody(body: unknown): ValidChatBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  const messages = (body as any).messages;
  if (!Array.isArray(messages)) {
    throw new HttpError(400, "'messages' must be an array");
  }
  const lastUser = [...messages].reverse().find(
    (m: any) => m && m.role === "user"
  );
  if (!lastUser || !("content" in lastUser)) {
    throw new HttpError(400, "No user message found");
  }
  const content = lastUser.content;
  const query =
    typeof content === "string" ? content : JSON.stringify(content ?? "");
  if (query.length === 0) {
    throw new HttpError(400, "User message is empty");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new HttpError(
      400,
      `User message exceeds ${MAX_QUERY_CHARS} characters`
    );
  }
  const tools = (body as any).tools;
  if (tools !== undefined && !Array.isArray(tools)) {
    throw new HttpError(400, "'tools' must be an array");
  }
  for (const tool of tools ?? []) {
    const fn = tool && typeof tool === "object" ? tool.function ?? tool : null;
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0) {
      throw new HttpError(400, "Every tool needs a function name");
    }
  }
  const rawMax = (body as any).max_tokens;
  let maxTokens = 48;
  if (rawMax !== undefined) {
    if (typeof rawMax !== "number" || !Number.isInteger(rawMax) || rawMax < 1) {
      throw new HttpError(400, "'max_tokens' must be a positive integer");
    }
    maxTokens = Math.min(rawMax, MAX_TOKENS_CAP);
  }
  return { query, tools: Array.isArray(tools) ? tools : [], maxTokens };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Schema name lookup: accepts OpenAI `{type,function}` and bare `{name}` tools. */
function toolSchemas(tools: any[]): Map<string, any> {
  const out = new Map<string, any>();
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (fn && typeof fn.name === "string") out.set(fn.name, fn.parameters ?? {});
  }
  return out;
}

function checkValue(schema: any, value: any, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "string" && typeof value !== "string") {
    errors.push(`${path}: want string, got ${typeof value}`);
    return;
  }
  if (typeof value === "string" && typeof schema.maxLength === "number" &&
      value.length > schema.maxLength) {
    errors.push(`${path}: length ${value.length} exceeds maxLength ${schema.maxLength}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
}

/** Deterministic model-output check. Returns error strings, empty when valid. */
export function validateToolCalls(calls: any[], tools: any[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(calls)) return ["function_calls is not an array"];
  const schemas = toolSchemas(tools);
  for (const call of calls) {
    if (!call || typeof call.name !== "string") {
      errors.push("tool call without a name");
      continue;
    }
    if (!schemas.has(call.name)) {
      errors.push(`unknown tool: ${call.name}`);
      continue;
    }
    const args = call.arguments;
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      errors.push(`${call.name}: arguments must be an object`);
      continue;
    }
    const props = schemas.get(call.name)?.properties ?? {};
    for (const [key, value] of Object.entries(args)) {
      checkValue(props[key], value, `${call.name}.${key}`, errors);
    }
  }
  return errors;
}

/** Bounded replay store: same request id returns the recorded response. */
export class IdempotencyCache {
  private store = new Map<string, { status: number; body: string }>();
  constructor(private cap: number = IDEMPOTENCY_CAP) {}
  get(id: string): { status: number; body: string } | undefined {
    return this.store.get(id);
  }
  set(id: string, status: number, body: string): void {
    if (this.store.has(id)) return;
    if (this.store.size >= this.cap) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(id, { status, body });
  }
  get size(): number {
    return this.store.size;
  }
}

/** Thrown engine errors (alloc/init/crash) may clear after a reset; model
 *  outcomes (`success:false`, e.g. truncated budget) are deterministic. */
export function isTransientInferenceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /allocat|heap|wasm|reset|memory|out of memory|terminated|abort/i.test(message);
}

/** Consecutive thrown-failure counter with a reload threshold. */
export class EngineHealth {
  private thrown = 0;
  constructor(private threshold: number = ENGINE_RELOAD_AFTER_THROWN) {}
  noteThrown(): boolean {
    this.thrown += 1;
    return this.thrown >= this.threshold;
  }
  noteSuccess(): void {
    this.thrown = 0;
  }
  get consecutiveThrown(): number {
    return this.thrown;
  }
}
