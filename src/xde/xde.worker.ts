import init from "@taucad/opencascade.js";
import wasmUrl from "@taucad/opencascade.js/wasm?url";
import { XdeEngine } from "./engine.ts";

type RequestMessage = {
  id: number;
  op: "read" | "export" | "shift" | "release" | "stats" | "project";
  bytes?: Uint8Array;
  definitionName?: string;
  dz?: number;
  experimental?: boolean;
};

let ready: Promise<XdeEngine> | null = null;
let initMs = 0;

function engine() {
  if (!ready) {
    const started = performance.now();
    ready = init({ locateFile: () => wasmUrl })
      .then((oc) => {
        initMs = performance.now() - started;
        return new XdeEngine(oc);
      })
      .catch((error: unknown) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}

const scope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void; onmessage: ((event: MessageEvent<RequestMessage>) => void) | null };

scope.onmessage = (event) => {
  const message = event.data;
  void (async () => {
    try {
      const current = await engine();
      let result: unknown;
      if (message.op === "read") {
        const readStarted = performance.now();
        const read = current.read(message.bytes ?? new Uint8Array(), { experimental: message.experimental === true });
        result = {
          report: read.report,
          meshes: read.meshes,
          scene: read.scene,
          sceneError: read.sceneError,
          sceneNotes: read.sceneNotes,
          placement: read.placement,
          readMs: performance.now() - readStarted,
          initMs,
          heapBytes: current.heapBytes(),
          temporaryFiles: current.temporaryFiles(),
        };
      } else if (message.op === "export") {
        result = { ...current.exportStep(), temporaryFiles: current.temporaryFiles() };
      } else if (message.op === "project") {
        result = current.projectStep(message.bytes ?? new Uint8Array());
      } else if (message.op === "shift") {
        const shifted = current.shift(message.definitionName ?? "", message.dz ?? Number.NaN);
        result = { report: shifted.report, meshes: shifted.meshes, initMs, heapBytes: current.heapBytes(), temporaryFiles: current.temporaryFiles() };
      } else if (message.op === "release") {
        result = current.release();
      } else if (message.op === "stats") {
        result = { initMs, heapBytes: current.heapBytes(), temporaryFiles: current.temporaryFiles() };
      } else {
        throw new Error("Unknown XDE operation");
      }
      const transfer = meshTransfers(result);
      scope.postMessage({ id: message.id, ok: true, result }, transfer);
    } catch (error) {
      if (ready) {
        try {
          (await ready).release();
        } catch {
          // The failed read may already have closed the document.
        }
      }
      scope.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
};

function meshTransfers(result: unknown): Transferable[] {
  const transfer: Transferable[] = [];
  if (!result || typeof result !== "object") return transfer;
  const record = result as { bytes?: Uint8Array; meshes?: Array<{ positions?: Float32Array; normals?: Float32Array; indices?: Uint32Array }> };
  if (record.bytes instanceof Uint8Array && record.bytes.buffer.byteLength > 0) transfer.push(record.bytes.buffer as ArrayBuffer);
  for (const mesh of record.meshes ?? []) {
    for (const view of [mesh.positions, mesh.normals, mesh.indices]) {
      if (view && view.buffer.byteLength > 0) transfer.push(view.buffer as ArrayBuffer);
    }
  }
  return transfer;
}
