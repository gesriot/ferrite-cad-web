// Byte framing only. The pinned Rust library owns the FCAD contract.
export async function createDocumentModule(options = {}) {
  const started = performance.now();
  const { default: create } = await import("./kernel/document.mjs");
  const module = await create({
    locateFile: () => new URL("./kernel/document.wasm", import.meta.url).href,
    ...options,
  });
  function call(bytes, request) {
    const allocations = [];
    let output = 0;
    const allocate = (data) => {
      const pointer = module._malloc(Math.max(data.length, 1));
      if (!pointer) throw new Error("WASM allocation failed");
      allocations.push(pointer);
      module.HEAPU8.set(data, pointer);
      return pointer;
    };
    try {
      const input = allocate(bytes);
      const length = allocate(new Uint8Array(4));
      if (request === undefined) output = module._fcad_open(input, bytes.length, length);
      else {
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
        ),
        bytes: frame.slice(4 + jsonSize),
      };
    } finally {
      if (output) module._free(output);
      for (const pointer of allocations) module._free(pointer);
    }
  }
  return {
    initMs: performance.now() - started,
    open: (bytes) => call(bytes),
    setExpression: (bytes, request) => call(bytes, request),
  };
}
