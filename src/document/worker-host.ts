/**
 * The Worker's request handler, separate from `self` so tests can run the real
 * thing without a Worker. Every request produces exactly one reply; a failure
 * to load the module or to frame a reply is reported as `transportError`, never
 * thrown, and never disguised as a Rust refusal.
 */
import type { AbiResult, DocumentAbi } from "./abi.ts";
import type { WorkerReply, WorkerRequest } from "./protocol.ts";

export interface HandledRequest {
  readonly reply: WorkerReply;
  readonly transfer: ArrayBuffer[];
}

export type DocumentRequestHandler = (request: WorkerRequest) => Promise<HandledRequest>;

export function createRequestHandler(load: () => Promise<DocumentAbi>): DocumentRequestHandler {
  let kernel: Promise<DocumentAbi> | undefined;
  return async (request) => {
    try {
      kernel ??= load();
      let abi: DocumentAbi;
      try {
        abi = await kernel;
      } catch (error) {
        kernel = undefined;
        throw error;
      }
      const started = performance.now();
      const bytes = new Uint8Array(request.bytes);
      let result: AbiResult;
      if (request.operation === "open") result = abi.open(bytes);
      else if (request.operation === "set_expression") result = abi.setExpression(bytes, request.request);
      else throw new Error("Unknown document operation");
      return {
        reply: {
          id: request.id,
          json: result.json,
          bytes: result.bytes.buffer,
          initMs: abi.initMs,
          operationMs: performance.now() - started,
        },
        transfer: [result.bytes.buffer],
      };
    } catch (error) {
      return { reply: { id: request.id, transportError: String(error) }, transfer: [] };
    }
  };
}
