import { parentPort } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import init from "@taucad/opencascade.js";
import { XdeEngine } from "./engine.ts";

if (!parentPort) throw new Error("XDE node worker needs a parent port");

const wasmDir = dirname(fileURLToPath(import.meta.resolve("@taucad/opencascade.js/wasm")));
const started = performance.now();
const oc = await init({ locateFile: (name: string) => join(wasmDir, name) });
const engine = new XdeEngine(oc);
const initMs = performance.now() - started;

parentPort.on("message", (message: { id: number; op: string; bytes?: Uint8Array; definitionName?: string; dz?: number; experimental?: boolean }) => {
  try {
    let result: unknown;
    if (message.op === "read") {
      const readStarted = performance.now();
      const read = engine.read(message.bytes ?? new Uint8Array(), { experimental: message.experimental === true });
      result = {
        report: read.report,
        meshes: read.meshes,
        scene: read.scene,
        sceneError: read.sceneError,
        sceneNotes: read.sceneNotes,
        placement: read.placement,
        readMs: performance.now() - readStarted,
        initMs,
        heapBytes: engine.heapBytes(),
        temporaryFiles: engine.temporaryFiles(),
      };
    } else if (message.op === "export") result = { ...engine.exportStep(), temporaryFiles: engine.temporaryFiles() };
    else if (message.op === "project") result = engine.projectStep(message.bytes ?? new Uint8Array());
    else if (message.op === "plant") {
      engine.plantOwned(message.definitionName ?? "", message.bytes ?? new Uint8Array());
      result = { temporaryFiles: engine.temporaryFiles() };
    }
    else if (message.op === "shift") {
      const shifted = engine.shift(message.definitionName ?? "", message.dz ?? Number.NaN);
      result = { report: shifted.report, meshes: shifted.meshes, initMs, heapBytes: engine.heapBytes(), temporaryFiles: engine.temporaryFiles() };
    }
    else if (message.op === "release") result = engine.release();
    else if (message.op === "stats") result = { initMs, heapBytes: engine.heapBytes(), temporaryFiles: engine.temporaryFiles() };
    else throw new Error(`Unknown XDE operation ${message.op}`);
    parentPort!.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    try {
      engine.release();
    } catch {
      // Already closed.
    }
    parentPort!.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
