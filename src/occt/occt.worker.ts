import { assertCadFileSize, openFcadBytes } from "./file-limits.ts";
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { setOC, type Shape3D } from "replicad";
import { buildTube, cutRadialHole, extrudeProfile, fuseSlab, inspect, inspectSolids, meshOf, shapeFromStep, stepBytes, type Inspect } from "./brep.ts";
import { readFcad, saveHeight } from "./fcad-doc.ts";
import { wrapSql, type SqlDb } from "./sql.ts";

type Curve = { kind: string; start: [number, number]; end: [number, number] };

type Request =
  | { id: number; revision?: number; op: "init" }
  | { id: number; revision?: number; op: "build-tube" }
  | { id: number; revision?: number; op: "import-step"; step: ArrayBuffer; stage?: boolean }
  | { id: number; revision?: number; op: "extrude-profile"; curves: Curve[]; height: number }
  | { id: number; revision?: number; op: "export-step" }
  | { id: number; revision?: number; op: "commit-staged" }
  | { id: number; revision?: number; op: "ack-commit" }
  | { id: number; revision?: number; op: "rollback-commit" }
  | { id: number; revision?: number; op: "discard-staged" }
  | { id: number; revision?: number; op: "fuse-slab"; min: [number, number, number]; max: [number, number, number] }
  | { id: number; revision?: number; op: "modify-radial" }
  | { id: number; revision?: number; op: "release" }
  | { id: number; revision?: number; op: "read-fcad"; bytes: ArrayBuffer }
  | { id: number; revision?: number; op: "save-height"; bytes: ArrayBuffer; source: string }
  | { id: number; revision?: number; op: "debug-crash" }
  | { id: number; revision?: number; op: "debug-fail-sql" }
  | { id: number; revision?: number; op: "debug-fail-extrude" }
  | { id: number; revision?: number; op: "debug-fail-import" };

type Ok = { id: number; revision?: number; ok: true; result: unknown };
type Fail = { id: number; revision?: number; ok: false; error: string };

let sqlReady: Promise<void> | null = null;
let sql: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let failSql = false;
let failExtrude = false;
let failImport = false;

async function ensureSql() {
  if (failSql) {
    failSql = false;
    throw new Error("SQLite WASM did not load");
  }
  if (!sqlReady) {
    sqlReady = initSqlJs({ locateFile: () => sqlWasmUrl })
      .then((loaded) => {
        sql = loaded;
      })
      .catch((error) => {
        sqlReady = null;
        throw error;
      });
  }
  await sqlReady;
}

function openDb(bytes: Uint8Array): SqlDb {
  if (!sql) throw new Error("SQLite is not loaded yet");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const db = openFcadBytes(copy, input => wrapSql(new sql!.Database(input)));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = DELETE");
  return db;
}

function withinLimit(bytes: ArrayBuffer) {
  assertCadFileSize(bytes.byteLength);
  if (bytes.byteLength < 16) throw new Error("file is too small to be a document");
}

let current: Shape3D | null = null;
let staged: Shape3D | null = null;
/** Shape replaced by the latest commit, kept until ack or rollback. */
let held: Shape3D | null = null;
let holding = false;
let ready: Promise<void> | null = null;
let wasmHref = "";
let queue: Promise<unknown> = Promise.resolve();

function dropHeld() {
  held?.delete();
  held = null;
  holding = false;
}

function dropCurrent() {
  current?.delete();
  current = null;
}

function dropStaged() {
  staged?.delete();
  staged = null;
}

async function ensure() {
  if (!ready) {
    const started = performance.now();
    ready = (async () => {
      wasmHref = new URL(wasmUrl, self.location.href).href;
      const oc = await initOpenCascade({ locateFile: () => wasmUrl });
      setOC(oc);
      (self as unknown as { __oc: typeof oc; __initMs: number }).__oc = oc;
      (self as unknown as { __initMs: number }).__initMs = performance.now() - started;
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  await ready;
}

const scope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  location: { href: string };
};

scope.onmessage = (event: MessageEvent<Request>) => {
  const message = event.data;
  queue = queue.then(() => settle(message), () => settle(message));
};

function settle(message: Request) {
  return handle(message).then(
    (payload) => {
      const transfer: Transferable[] = [];
      if (payload && typeof payload === "object") {
        const bag = payload as { positions?: Float32Array; normals?: Float32Array; indices?: Uint32Array; step?: Uint8Array; bytes?: Uint8Array };
        for (const key of ["positions", "normals", "indices", "step", "bytes"] as const) {
          const value = bag[key];
          if (value?.buffer) transfer.push(value.buffer);
        }
      }
      const response: Ok = { id: message.id, revision: message.revision, ok: true, result: payload };
      scope.postMessage(response, transfer);
    },
    (error: unknown) => {
      const response: Fail = {
        id: message.id,
        revision: message.revision,
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
      scope.postMessage(response);
    },
  );
}

async function stageShape(shape: Shape3D) {
  const info = inspect(shape);
  if (!info.valid || !info.solidValid || !(info.volume > 0)) {
    throw new Error(`solid is not usable: volume ${info.volume}`);
  }
  const solids = inspectSolids(shape);
  const mesh = meshOf(shape);
  const step = await stepBytes(shape);
  dropStaged();
  staged = shape;
  return { info, solids, ...mesh, step };
}

async function handle(message: Request): Promise<unknown> {
  if (message.op === "debug-crash") {
    setTimeout(() => {
      throw new Error("injected worker crash");
    }, 0);
    return { crashed: true };
  }
  if (message.op === "debug-fail-sql") {
    failSql = true;
    return { armed: true };
  }
  if (message.op === "debug-fail-extrude") {
    failExtrude = true;
    return { armed: true };
  }
  if (message.op === "debug-fail-import") {
    failImport = true;
    return { armed: true };
  }
  if (message.op === "read-fcad") {
    try {
      withinLimit(message.bytes);
      await ensureSql();
      const db = openDb(new Uint8Array(message.bytes));
      try {
        return readFcad(db);
      } finally {
        db.close();
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (/not a database/i.test(messageText)) {
        return { ok: false, status: "invalid" as const, error: "file is not a SQLite database" };
      }
      throw error;
    }
  }
  if (message.op === "save-height") {
    withinLimit(message.bytes);
    await ensureSql();
    const bytes = saveHeight(new Uint8Array(message.bytes), message.source, openDb);
    return { bytes };
  }
  if (message.op === "init") {
    const started = performance.now();
    await ensure();
    const oc = (self as unknown as { __oc: { wasmMemory: WebAssembly.Memory } }).__oc;
    return {
      initMs: (self as unknown as { __initMs: number }).__initMs,
      wasmUrl: wasmHref,
      wasmMemoryBytes: oc.wasmMemory.buffer.byteLength,
      thread: "single",
      locateMs: performance.now() - started,
    };
  }
  await ensure();
  if (message.op === "release") {
    dropCurrent();
    dropStaged();
    dropHeld();
    return { released: true };
  }
  if (message.op === "discard-staged") {
    dropStaged();
    return { discarded: true };
  }
  if (message.op === "commit-staged") {
    if (!staged) throw new Error("no staged solid");
    if (holding) dropHeld();
    held = current;
    holding = true;
    current = staged;
    staged = null;
    return { committed: true };
  }
  if (message.op === "ack-commit") {
    dropHeld();
    return { acked: true };
  }
  if (message.op === "rollback-commit") {
    if (holding) {
      current?.delete();
      current = held;
      held = null;
      holding = false;
    }
    dropStaged();
    return { rolled: true };
  }
  if (message.op === "build-tube") {
    dropCurrent();
    const shape = buildTube();
    current = shape;
    const info: Inspect = inspect(shape);
    const mesh = meshOf(shape);
    const step = await stepBytes(shape);
    return { info, ...mesh, step };
  }
  if (message.op === "import-step") {
    if (failImport) {
      failImport = false;
      throw new Error("STEP did not restore");
    }
    const shape = await shapeFromStep(new Uint8Array(message.step));
    try {
      if (message.stage) return await stageShape(shape);
      const info = inspect(shape);
      const solids = inspectSolids(shape);
      const previous = current;
      current = shape;
      previous?.delete();
      return { info, solids };
    } catch (error) {
      shape.delete();
      throw error;
    }
  }
  if (message.op === "extrude-profile") {
    if (failExtrude) {
      failExtrude = false;
      throw new Error("OCCT WASM did not load");
    }
    const shape = extrudeProfile(message.curves, message.height);
    try {
      return await stageShape(shape);
    } catch (error) {
      if (staged !== shape) shape.delete();
      throw error;
    }
  }
  if (message.op === "export-step") {
    if (!current) throw new Error("no solid for STEP");
    const info = inspect(current);
    const solids = inspectSolids(current);
    const step = await stepBytes(current);
    return { info, solids, step };
  }
  if (message.op === "modify-radial") {
    if (!current) throw new Error("no B-rep in this session");
    const shape = cutRadialHole(current);
    current = shape;
    const info = inspect(shape);
    const mesh = meshOf(shape);
    const step = await stepBytes(shape);
    return { info, ...mesh, step };
  }
  if (message.op === "fuse-slab") {
    if (!current) throw new Error("no B-rep in this session");
    const shape = fuseSlab(current, message.min, message.max);
    current = shape;
    const info = inspect(shape);
    const mesh = meshOf(shape);
    const step = await stepBytes(shape);
    return { info, solids: inspectSolids(shape), ...mesh, step };
  }
  throw new Error(`unknown op ${(message as { op: string }).op}`);
}
