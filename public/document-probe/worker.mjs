import { createDocumentModule } from "./transport.mjs";

let kernel;
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      kernel ??= await createDocumentModule();
      const started = performance.now();
      const result =
        data.operation === "open"
          ? kernel.open(new Uint8Array(data.bytes))
          : data.operation === "set_expression"
            ? kernel.setExpression(new Uint8Array(data.bytes), data.request)
            : (() => {
                throw new Error("Unknown probe operation");
              })();
      self.postMessage(
        { id: data.id, ...result, initMs: kernel.initMs, operationMs: performance.now() - started },
        [result.bytes.buffer],
      );
    } catch (error) {
      self.postMessage({ id: data.id, transportError: String(error) });
    }
  });
};
