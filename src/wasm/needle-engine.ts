// Pre-compiled via CompiledWasm in prod (instantiate-only); a file path in bun dev.
// @ts-ignore
import needleWasmModule from "./needle.wasm";

// Workerd exposes process.versions.node, which makes the Emscripten glue take
// its Node branch (require/node:fs/__dirname) and crash. The glue detects the
// environment once at module evaluation, so this must run before needle.js is
// first imported.
function hideNodeFromEmscripten(): void {
  const proc = (globalThis as any).process;
  if (!proc?.versions || typeof proc.versions !== "object" || !("node" in proc.versions)) {
    return;
  }
  try {
    const versions = { ...(proc.versions as Record<string, string>) };
    delete versions.node;
    Object.defineProperty(proc, "versions", { value: versions, configurable: true, writable: true });
  } catch {
    // versions is immutable; the glue keeps its (broken here) Node branch.
  }
}

export interface NeedleFunctionCall {
  name: string;
  arguments: Record<string, any>;
}

export interface NeedleCompletionResult {
  type: string;
  success: boolean;
  function_calls: NeedleFunctionCall[];
  reasoning: string | null;
  confidence: number;
  prefill_tps: number;
  decode_tps: number;
  raw_output: string;
  error?: string | null;
  [key: string]: any;
}

export class NeedleEngine {
  private mod: any = null;
  private loaded: boolean = false;
  private encoder: TextEncoder = new TextEncoder();
  private decoder: TextDecoder = new TextDecoder();

  /** Initialize the WASM module using the needle.js factory. */
  async initWasm(): Promise<this> {
    if (this.mod) {
      return this;
    }

    hideNodeFromEmscripten();
    // @ts-ignore
    const needleModule = await import("./needle.js");
    const factory = typeof needleModule === "function" ? needleModule : (needleModule as any)?.default;
    if (!factory) {
      throw new Error("Unable to locate createNeedle factory from needle.js");
    }

    const moduleArg: Record<string, any> = {};
    if (needleWasmModule instanceof WebAssembly.Module) {
      const compiled = needleWasmModule as WebAssembly.Module;
      moduleArg.instantiateWasm = (imports: WebAssembly.Imports) => new WebAssembly.Instance(compiled, imports);
    } else if (typeof needleWasmModule === "string") {
      // Bun/dev: the import is the file path; runtime compile is allowed here.
      const fs = await import("node:fs");
      moduleArg.wasmBinary = new Uint8Array(fs.readFileSync(needleWasmModule));
    } else {
      throw new Error("Needle WASM import is neither a pre-compiled Module nor a file path");
    }

    this.mod = await factory(moduleArg);
    return this;
  }

  /** Writes a null-terminated UTF-8 string to the WASM heap. */
  private writeCString(str: string): number {
    const bytes = this.encoder.encode(str + "\0");
    const ptr = this.mod._malloc(bytes.length);
    if (!ptr) {
      throw new Error(`Failed to allocate ${bytes.length} bytes in WASM heap`);
    }
    this.mod.HEAPU8.set(bytes, ptr);
    return ptr;
  }

  /** Reads a null-terminated UTF-8 string from the WASM heap. */
  private readCString(ptr: number, maxBytes: number = 4096): string {
    const heap = this.mod.HEAPU8 as Uint8Array;
    if (!Number.isInteger(ptr) || ptr < 0 || ptr >= heap.length) {
      throw new Error(
        `readCString: ptr ${ptr} outside heap (len ${heap.length}, ` +
        `detached=${heap.buffer.detached}, resizable=${heap.buffer.resizable})`
      );
    }
    const limit = Math.min(ptr + maxBytes, heap.length);
    let end = ptr;
    while (end < limit && heap[end] !== 0) {
      end++;
    }
    return this.decoder.decode(heap.subarray(ptr, end));
  }

  /**
   * Streaming weights load (see EngineWeightsSink): the caller mallocs one
   * heap allocation, writes each chunk at its offset, then finishes. Single
   * load only; chunks stream so no JS-side copy of the archive exists.
   */
  allocWeights(totalLength: number): number {
    if (!this.mod) {
      throw new Error("Needle WASM module is not initialized. Await initWasm().");
    }
    if (this.loaded) {
      throw new Error("Weights already loaded.");
    }
    const ptr = this.mod._malloc(totalLength);
    if (!ptr) {
      throw new Error(`Failed to allocate ${totalLength} bytes for weights in WASM heap`);
    }
    return ptr;
  }

  /** Copies one chunk into the allocation. Reads HEAPU8 fresh: the alloc
   *  above may have grown wasm memory and detached older views. */
  writeWeightsChunk(ptr: number, offset: number, chunk: Uint8Array): void {
    if (!this.mod) {
      throw new Error("Needle WASM module is not initialized. Await initWasm().");
    }
    this.mod.HEAPU8.set(chunk, ptr + offset);
  }

  /** Runs _needle_load over the filled allocation. Frees ptr unless rc is 0
   *  (on success the engine owns the input buffer in place). Returns rc. */
  finishWeightsLoad(ptr: number, totalLength: number): number {
    if (!this.mod) {
      throw new Error("Needle WASM module is not initialized. Await initWasm().");
    }
    const ret = this.mod._needle_load(ptr, BigInt(totalLength));
    if (ret === 0) {
      this.loaded = true;
    } else {
      this.mod._free(ptr);
      this.loaded = false;
    }
    return ret;
  }

  /** Frees an allocation whose load was abandoned before finish. */
  discardWeights(ptr: number): void {
    if (this.mod) {
      this.mod._free(ptr);
    }
  }

  /** Initializes a turn with the system prompt and tools JSON. Returns tokenized prefix length. */
  init(systemPrompt: string, toolsJson: string): number {
    if (!this.mod) {
      throw new Error("Needle WASM module is not initialized. Await initWasm().");
    }
    const sysPtr = this.writeCString(systemPrompt);
    const toolsPtr = this.writeCString(toolsJson);

    try {
      return this.mod._needle_init(sysPtr, toolsPtr, 0);
    } finally {
      this.mod._free(sysPtr);
      this.mod._free(toolsPtr);
    }
  }

  /** Runs one completion, resets the KV cache ring, and returns the parsed result. */
  complete(input: string, maxTokens: number = 128): NeedleCompletionResult {
    if (!this.mod) {
      throw new Error("Needle WASM module is not initialized. Await initWasm().");
    }
    const outCapacity = 4096;
    const outPtr = this.mod._malloc(outCapacity);
    if (!outPtr) {
      throw new Error(`Failed to allocate ${outCapacity} bytes for output buffer in WASM heap`);
    }

    const inputPtr = this.writeCString(input);
    let outStr = "";

    try {
      this.mod.HEAPU8.fill(0, outPtr, outPtr + outCapacity);
      this.mod._needle_complete(inputPtr, maxTokens, outPtr, outCapacity);
      outStr = this.readCString(outPtr, outCapacity);
    } finally {
      this.mod._free(inputPtr);
      this.mod._free(outPtr);
      this.reset();
    }

    try {
      const parsed = JSON.parse(outStr);
      return {
        type: "call",
        success: true,
        function_calls: [],
        reasoning: "",
        confidence: 1,
        prefill_tps: 0,
        decode_tps: 0,
        ...parsed,
        raw_output: outStr,
      };
    } catch (e: any) {
      return {
        type: "error",
        success: false,
        function_calls: [],
        reasoning: "",
        confidence: 0,
        prefill_tps: 0,
        decode_tps: 0,
        raw_output: outStr,
        error: e?.message || "Failed to parse JSON output",
      };
    }
  }

  /** Resets the KV cache ring. MUST run after every completion to prevent context leakage. */
  reset(): void {
    if (this.mod && typeof this.mod._needle_reset === "function") {
      this.mod._needle_reset();
    }
  }

  /** Boolean indicating if weights are loaded. */
  isLoaded(): boolean {
    return this.loaded;
  }
}

export default NeedleEngine;
