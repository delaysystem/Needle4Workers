// @ts-ignore
import createNeedle from "./needle.js";

export interface NeedleFunctionCall {
  name: string;
  arguments: Record<string, any>;
}

export interface NeedleCompletionResult {
  type: string;
  success: boolean;
  function_calls: NeedleFunctionCall[];
  reasoning: string;
  confidence: number;
  prefill_tps: number;
  decode_tps: number;
  raw_output: string;
  error?: string | null;
  error_code?: string | null;
  reason?: string | null;
  suppressed_calls?: any[];
  peak_ram_mb?: number;
  validation?: {
    ungrounded?: any[];
    negation?: boolean;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface NeedleEngineOptions {
  wasmBinary?: ArrayBuffer | Uint8Array;
  wasmModule?: any;
}

export class NeedleEngine {
  private mod: any = null;
  private loaded: boolean = false;
  private weightsPtr: number | null = null;
  private encoder: TextEncoder = new TextEncoder();
  private decoder: TextDecoder = new TextDecoder();
  private initPromise: Promise<void> | null = null;

  constructor(optionsOrBinaryOrModule?: ArrayBuffer | Uint8Array | NeedleEngineOptions | any) {
    if (optionsOrBinaryOrModule) {
      if (typeof optionsOrBinaryOrModule._malloc === "function") {
        this.mod = optionsOrBinaryOrModule;
      } else if (
        optionsOrBinaryOrModule instanceof Uint8Array ||
        optionsOrBinaryOrModule instanceof ArrayBuffer
      ) {
        this.initPromise = this.initWasm(optionsOrBinaryOrModule).then(() => {});
      } else if (typeof optionsOrBinaryOrModule === "object") {
        if (optionsOrBinaryOrModule.wasmModule && typeof optionsOrBinaryOrModule.wasmModule._malloc === "function") {
          this.mod = optionsOrBinaryOrModule.wasmModule;
        } else if (optionsOrBinaryOrModule.wasmBinary) {
          this.initPromise = this.initWasm(optionsOrBinaryOrModule.wasmBinary).then(() => {});
        }
      }
    }
  }

  /**
   * Static factory to instantiate NeedleEngine asynchronously.
   */
  static async create(
    wasmBinaryOrOptions?: ArrayBuffer | Uint8Array | NeedleEngineOptions
  ): Promise<NeedleEngine> {
    const engine = new NeedleEngine();
    await engine.initWasm(wasmBinaryOrOptions);
    return engine;
  }

  /**
   * Initialize WASM module using needle.js factory.
   */
  async initWasm(
    wasmBinaryOrOptions?: ArrayBuffer | Uint8Array | NeedleEngineOptions
  ): Promise<this> {
    if (this.mod) {
      return this;
    }

    let wasmBinary: ArrayBuffer | Uint8Array | undefined;
    if (
      wasmBinaryOrOptions instanceof Uint8Array ||
      wasmBinaryOrOptions instanceof ArrayBuffer
    ) {
      wasmBinary = wasmBinaryOrOptions;
    } else if (wasmBinaryOrOptions && typeof wasmBinaryOrOptions === "object") {
      if (wasmBinaryOrOptions.wasmModule) {
        this.mod = wasmBinaryOrOptions.wasmModule;
        return this;
      }
      wasmBinary = wasmBinaryOrOptions.wasmBinary;
    }

    const factory =
      typeof createNeedle === "function"
        ? createNeedle
        : (createNeedle as any)?.default;

    if (!factory) {
      throw new Error("Unable to locate createNeedle factory from needle.js");
    }

    const moduleArg: Record<string, any> = {};
    if (wasmBinary) {
      moduleArg.wasmBinary = wasmBinary;
    }

    this.mod = await factory(moduleArg);
    return this;
  }

  /**
   * Linear memory buffer HEAPU8 view.
   * Accesses the active buffer dynamically in case memory was resized.
   */
  get HEAPU8(): Uint8Array {
    if (!this.mod) {
      throw new Error("Needle WASM module is not initialized");
    }
    return this.mod.HEAPU8;
  }

  /**
   * Low-level Emscripten Module instance.
   */
  get module(): any {
    return this.mod;
  }

  /**
   * Writes a null-terminated UTF-8 string to the WASM heap.
   */
  private writeCString(str: string): number {
    const bytes = this.encoder.encode(str + "\0");
    const ptr = this.mod._malloc(bytes.length);
    if (!ptr) {
      throw new Error(`Failed to allocate ${bytes.length} bytes in WASM heap`);
    }
    this.mod.HEAPU8.set(bytes, ptr);
    return ptr;
  }

  /**
   * Reads a null-terminated UTF-8 string from the WASM heap.
   */
  private readCString(ptr: number, maxBytes: number = 4096): string {
    const heap = this.mod.HEAPU8 as Uint8Array;
    let end = ptr;
    const limit = ptr + maxBytes;
    while (end < limit && heap[end] !== 0) {
      end++;
    }
    return this.decoder.decode(heap.subarray(ptr, end));
  }

  /**
   * Allocates memory with _malloc, copies weights, and calls _needle_load(ptr, BigInt(bytes.length)).
   * Returns 0 on success.
   */
  loadWeights(bytes: Uint8Array | ArrayBuffer): number {
    if (!this.mod) {
      throw new Error("Needle WASM module is not initialized. Await initWasm() or use NeedleEngine.create().");
    }
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const size = u8.byteLength;
    const ptr = this.mod._malloc(size);
    if (!ptr) {
      throw new Error(`Failed to allocate ${size} bytes for weights in WASM heap`);
    }

    this.mod.HEAPU8.set(u8, ptr);
    const ret = this.mod._needle_load(ptr, BigInt(size));

    if (ret === 0) {
      if (this.weightsPtr !== null && this.weightsPtr !== ptr) {
        try {
          this.mod._free(this.weightsPtr);
        } catch {
          // Ignore free errors on older buffers
        }
      }
      this.weightsPtr = ptr;
      this.loaded = true;
    } else {
      this.mod._free(ptr);
      this.loaded = false;
    }

    return ret;
  }

  /**
   * Writes null-terminated systemPrompt and toolsJson to heap with _malloc,
   * calls _needle_init(sysPtr, toolsPtr, 0).
   * Returns tokenized prefix length. Frees input strings with _free.
   */
  init(systemPrompt: string, toolsJson: string): number {
    if (!this.mod) {
      throw new Error("Needle WASM module is not initialized. Await initWasm() or use NeedleEngine.create().");
    }
    const sysPtr = this.writeCString(systemPrompt);
    const toolsPtr = this.writeCString(toolsJson);

    try {
      const prefixLen = this.mod._needle_init(sysPtr, toolsPtr, 0);
      return prefixLen;
    } finally {
      this.mod._free(sysPtr);
      this.mod._free(toolsPtr);
    }
  }

  /**
   * Writes input to heap, allocates out buffer, calls _needle_complete(inputPtr, maxTokens, outPtr, outCapacity).
   * Decodes output string via TextDecoder. Frees inputPtr and outPtr.
   * Calls reset() after completion to reset the KV cache ring and prevent context leakage.
   * Returns parsed result object: { type, success, function_calls, reasoning, confidence, prefill_tps, decode_tps, raw_output }.
   */
  complete(input: string, maxTokens: number = 128): NeedleCompletionResult {
    if (!this.mod) {
      throw new Error("Needle WASM module is not initialized. Await initWasm() or use NeedleEngine.create().");
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
        type: parsed.type ?? "call",
        success: parsed.success ?? true,
        function_calls: parsed.function_calls ?? [],
        reasoning: parsed.reasoning ?? "",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 1.0,
        prefill_tps: typeof parsed.prefill_tps === "number" ? parsed.prefill_tps : 0,
        decode_tps: typeof parsed.decode_tps === "number" ? parsed.decode_tps : 0,
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

  /**
   * Calls _needle_reset(). MUST be called after every completion to reset the KV cache ring
   * and prevent context leakage.
   */
  reset(): void {
    if (this.mod && typeof this.mod._needle_reset === "function") {
      this.mod._needle_reset();
    }
  }

  /**
   * Optional vector embedding call if supported.
   * Allocates buffer, calls _needle_embed, and returns Float32Array embedding or null.
   */
  embed(text: string): Float32Array | null {
    if (!this.mod || typeof this.mod._needle_embed !== "function") {
      return null;
    }
    const textPtr = this.writeCString(text);
    const outCapacity = 16384; // 4096 float32s
    const outPtr = this.mod._malloc(outCapacity);
    if (!outPtr) {
      this.mod._free(textPtr);
      return null;
    }

    try {
      const bytesWritten = this.mod._needle_embed(textPtr, outPtr, outCapacity);
      if (bytesWritten > 0) {
        const floatCount = bytesWritten / 4;
        return new Float32Array(this.mod.HEAPU8.buffer, outPtr, floatCount).slice();
      }
      return null;
    } finally {
      this.mod._free(textPtr);
      this.mod._free(outPtr);
    }
  }

  /**
   * Boolean indicating if weights are loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}

export default NeedleEngine;
