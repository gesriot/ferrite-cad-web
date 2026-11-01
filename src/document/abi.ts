/**
 * Byte framing of the synchronous C ABI in `wasm/document/src/abi.rs`.
 *
 * Browser Worker and Node parity harness both load the module through this
 * file, so there is one implementation of the frame. It copies bytes in and
 * out and parses the JSON frame; it does not interpret the document.
 */
import type { ExpressionChange } from "./protocol.ts";

/** The Emscripten module surface exported by the document facade. */
export interface DocumentWasmModule {
  /** A getter: the view is replaced whenever the module's memory grows. */
  readonly HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _fcad_open(bytes: number, size: number, length: number): number;
  _fcad_set_expression(
    bytes: number,
    size: number,
    request: number,
    requestSize: number,
    length: number,
  ): number;
}

/** What one ABI call returned: the JSON half untouched, and optional FCAD bytes. */
export interface AbiResult {
  readonly json: unknown;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface DocumentAbi {
  /** Time spent loading and instantiating the module. */
  readonly initMs: number;
  open(bytes: Uint8Array): AbiResult;
  setExpression(bytes: Uint8Array, request: ExpressionChange): AbiResult;
}

/** Loads and instantiates the module; the caller chooses where the files come from. */
export type DocumentWasmLoader = () => Promise<DocumentWasmModule>;

export async function createDocumentAbi(load: DocumentWasmLoader): Promise<DocumentAbi> {
  const started = performance.now();
  const module = await load();
  const initMs = performance.now() - started;

  function call(bytes: Uint8Array, request?: ExpressionChange): AbiResult {
    const allocations: number[] = [];
    let output = 0;
    const allocate = (data: Uint8Array): number => {
      const pointer = module._malloc(Math.max(data.length, 1));
      if (!pointer) throw new Error("WASM allocation failed");
      allocations.push(pointer);
      module.HEAPU8.set(data, pointer);
      return pointer;
    };
    try {
      const input = allocate(bytes);
      const length = allocate(new Uint8Array(4));
      if (request === undefined) {
        output = module._fcad_open(input, bytes.length, length);
      } else {
        const json = new TextEncoder().encode(JSON.stringify(request));
        const pointer = allocate(json);
        output = module._fcad_set_expression(input, bytes.length, pointer, json.length, length);
      }
      if (!output) throw new Error("WASM response allocation failed");
      const size = new DataView(module.HEAPU8.buffer).getUint32(length, true);
      const frame = module.HEAPU8.slice(output, output + size);
      const jsonSize = new DataView(frame.buffer).getUint32(0, true);
      if (4 + jsonSize > frame.length) throw new Error("Invalid response frame");
      return {
        json: JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4, 4 + jsonSize)),
        ) as unknown,
        bytes: frame.slice(4 + jsonSize),
      };
    } finally {
      if (output) module._free(output);
      for (const pointer of allocations) module._free(pointer);
    }
  }

  return {
    initMs,
    open: (bytes) => call(bytes),
    setExpression: (bytes, request) => call(bytes, request),
  };
}
