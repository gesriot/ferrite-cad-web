// Worker entry. The kernel is requested only when the first operation arrives.
import { createDocumentAbi, type DocumentWasmModule } from "./abi.ts";
import type { WorkerRequest } from "./protocol.ts";
import { createRequestHandler } from "./worker-host.ts";

/** Stable, revalidated URLs of the committed artifact; they are not bundled. */
const KERNEL_GLUE = "/document-probe/kernel/document.mjs";
const KERNEL_WASM = "/document-probe/kernel/document.wasm";

type Factory = (options: { locateFile: () => string }) => Promise<DocumentWasmModule>;

const handle = createRequestHandler(() =>
  createDocumentAbi(async () => {
    const glue = new URL(KERNEL_GLUE, self.location.origin).href;
    const { default: create } = (await import(/* @vite-ignore */ glue)) as { default: Factory };
    return create({ locateFile: () => new URL(KERNEL_WASM, self.location.origin).href });
  }),
);

const scope = self as unknown as {
  postMessage: (message: unknown, transfer: Transferable[]) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

// The ABI call is synchronous and its module is single-threaded: one request at a time.
let queue: Promise<void> = Promise.resolve();
scope.onmessage = (event) => {
  queue = queue.then(async () => {
    const { reply, transfer } = await handle(event.data);
    scope.postMessage(reply, transfer);
  });
};
