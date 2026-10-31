import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { readEmbeddedStep } from "../src/occt/fcad-doc.ts";
import { wrapSql } from "../src/occt/sql.ts";
import { compareReports, expectRead, expectRotation, expectShift } from "./xde-check.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outDir = join(root, "artifacts/xde/node");
mkdirSync(outDir, { recursive: true });

const files = [
  "01-single-part.step",
  "02-flat-assembly.step",
  "03-nested-assembly.step",
  "04-instance-colours.step",
  "05-inch-units.step",
  "06-unicode-names.step",
  "07-bare-geometry.step",
];

const errors: string[] = [];
const fail = (message: string) => errors.push(message);

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundsOf(positions: ArrayLike<number>) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = Number(positions[index + axis]);
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return [...min, ...max];
}

function assertMeshFrame(name: string, report: { nodes: any[]; partDefinitions: number }, meshes: any[]) {
  if (!Array.isArray(meshes) || meshes.length !== report.partDefinitions) {
    fail(`${name} mesh count ${meshes?.length} != ${report.partDefinitions} part definitions`);
    return;
  }
  const byId = new Map(meshes.map((mesh) => [mesh.definitionId, mesh]));
  for (const node of report.nodes) {
    if (node.isAssembly) continue;
    const mesh = byId.get(node.definitionId);
    if (!mesh) {
      fail(`${name} missing mesh for definition ${node.definitionId}`);
      continue;
    }
    const box = boundsOf(mesh.positions);
    const center = [(box[0]! + box[3]!) / 2, (box[1]! + box[4]!) / 2, (box[2]! + box[5]!) / 2];
    const local = node.localBox as number[] | null;
    const world = node.worldBox as number[] | null;
    if (!local) {
      fail(`${name} ${node.path} has a mesh but no definition box`);
      continue;
    }
    const localCenter = [(local[0]! + local[3]!) / 2, (local[1]! + local[4]!) / 2, (local[2]! + local[5]!) / 2];
    const worldCenter = world ? [(world[0]! + world[3]!) / 2, (world[1]! + world[4]!) / 2, (world[2]! + world[5]!) / 2] : localCenter;
    const localDist = Math.hypot(center[0]! - localCenter[0]!, center[1]! - localCenter[1]!, center[2]! - localCenter[2]!);
    const worldDist = Math.hypot(center[0]! - worldCenter[0]!, center[1]! - worldCenter[1]!, center[2]! - worldCenter[2]!);
    const separated = Math.hypot(localCenter[0]! - worldCenter[0]!, localCenter[1]! - worldCenter[1]!, localCenter[2]! - worldCenter[2]!);
    if (localDist > 1) fail(`${name} ${node.path} mesh is ${localDist.toFixed(3)} mm from the definition box`);
    if (separated > 1 && worldDist + 0.5 < localDist) fail(`${name} ${node.path} mesh was baked into the world frame`);
  }
}

function startWorker() {
  const worker = new Worker(new URL("../src/xde/node-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
  });
  let seq = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  worker.on("message", (message: { id: number; ok: boolean; result?: any; error?: string }) => {
    const found = pending.get(message.id);
    if (!found) return;
    pending.delete(message.id);
    clearTimeout(found.timer);
    if (message.ok) found.resolve(message.result);
    else found.reject(new Error(message.error));
  });
  worker.on("error", (error) => {
    for (const found of pending.values()) found.reject(error);
    pending.clear();
  });
  return {
    call(op: string, payload: Record<string, unknown> = {}) {
      const id = ++seq;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout ${op}`)), 180000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, op, ...payload });
      });
    },
    stop: () => worker.terminate(),
  };
}

const originalBytes = new Map<string, Uint8Array>();
const originalReports = new Map<string, any>();
const exports = new Map<string, Uint8Array>();
let firstStats: { initMs: number; heapBytes: number | null } | null = null;

const writer = startWorker();
for (const name of files) {
  const bytes = new Uint8Array(readFileSync(join(root, "fixtures/step/canonical", name)));
  originalBytes.set(name, bytes);
  const result = await writer.call("read", { bytes });
  if (!firstStats) firstStats = { initMs: result.initMs, heapBytes: result.heapBytes };
  if (result.temporaryFiles?.length) fail(`${name} left ${result.temporaryFiles.join(", ")}`);
  originalReports.set(name, result.report);
  for (const message of expectRead(name, result.report)) fail(`read ${name}: ${message}`);
  assertMeshFrame(name, result.report, result.meshes);
  const exported = await writer.call("export");
  const step = exported.bytes as Uint8Array;
  if (exported.temporaryFiles?.length) fail(`${name} export left ${exported.temporaryFiles.join(", ")}`);
  exports.set(name, step);
  writeFileSync(join(outDir, name), step);
  if (sha256(step) === sha256(bytes)) fail(`${name} export is the original byte array`);
  if (step.byteLength === bytes.byteLength && sha256(step) === sha256(bytes)) fail(`${name} export was not rewritten`);
}

const plate = originalBytes.get("02-flat-assembly.step")!;
const shiftedRead = await writer.call("read", { bytes: plate });
const shifted = await writer.call("shift", { definitionName: "Pin", dz: 5 });
for (const message of expectShift(shifted.report)) fail(`shift in session: ${message}`);
const shiftedExport = await writer.call("export");
const shiftedBytes = shiftedExport.bytes as Uint8Array;
exports.set("02-pin-plus-5mm.step", shiftedBytes);
writeFileSync(join(outDir, "02-pin-plus-5mm.step"), shiftedBytes);
if (sha256(shiftedBytes) === sha256(plate)) fail("shifted export matches the original bytes");
void shiftedRead;

const damaged = new TextEncoder().encode("this is not a STEP file");
let damagedMessage = "";
try {
  await writer.call("read", { bytes: damaged });
  fail("damaged STEP was accepted");
} catch (error) {
  damagedMessage = error instanceof Error ? error.message : String(error);
}
const scrubbed = await writer.call("release");
if (!Array.isArray(scrubbed.temporaryFiles) || scrubbed.temporaryFiles.length !== 0) {
  fail(`damaged STEP left temporary files ${JSON.stringify(scrubbed.temporaryFiles)}`);
}
const recovered = await writer.call("read", { bytes: originalBytes.get("01-single-part.step") });
for (const message of expectRead("01-single-part.step", recovered.report)) fail(`recover after damaged: ${message}`);
if (recovered.temporaryFiles?.length) fail(`recover left ${recovered.temporaryFiles.join(", ")}`);
for (let cycle = 1; cycle <= 20; cycle += 1) {
  await writer.call("read", { bytes: plate });
  await writer.call("export");
  const released = await writer.call("release");
  if (!Array.isArray(released.temporaryFiles) || released.temporaryFiles.length !== 0) {
    fail(`cycle ${cycle} left ${JSON.stringify(released.temporaryFiles)}`);
  }
}
await writer.call("release");
await writer.stop();

const reader = startWorker();
const rereadReports = new Map<string, any>();
let rereadStats: { initMs: number; heapBytes: number | null } | null = null;
for (const name of files) {
  const result = await reader.call("read", { bytes: exports.get(name) });
  if (!rereadStats) rereadStats = { initMs: result.initMs, heapBytes: result.heapBytes };
  rereadReports.set(name, result.report);
  const label = name.startsWith("05") ? "05-reread.step" : name;
  for (const message of expectRead(label, result.report)) fail(`reread ${name}: ${message}`);
  for (const message of compareReports(originalReports.get(name), result.report, name)) fail(message);
}
const shiftedReread = await reader.call("read", { bytes: shiftedBytes });
for (const message of expectShift(shiftedReread.report)) fail(`shifted reread: ${message}`);
for (const message of compareReports(shifted.report, shiftedReread.report, "02 shift")) fail(message);

const fcadPath = join(root, "fixtures/original-assembly.fcad");
const require = createRequire(import.meta.url);
const initSql = require("sql.js") as (opts: { wasmBinary: Uint8Array }) => Promise<{ Database: new (data?: Uint8Array) => Parameters<typeof wrapSql>[0] }>;
const SQL = await initSql({ wasmBinary: readFileSync(new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url)) });
const fcadDb = wrapSql(new SQL.Database(readFileSync(fcadPath)));
fcadDb.exec("PRAGMA foreign_keys = ON");
const extracted = readEmbeddedStep(fcadDb);
fcadDb.close();
const meta = extracted.meta;
const embedded = extracted.step;
if (meta.blobBytes !== 23528 || meta.byteLen !== 23528 || meta.sourceByteLen !== 23528) fail(`fcad length ${meta.blobBytes}`);
if (!meta.hashOk || !meta.sourceLinkOk) fail("fcad source link was not confirmed");
if (meta.sourceName !== "02-flat-assembly.step") fail(`source_name ${meta.sourceName}`);
if (meta.format !== "exchange.step") fail(`fcad format ${meta.format}`);
if (sha256(embedded) !== sha256(originalBytes.get("02-flat-assembly.step")!)) fail("embedded bytes differ from 02");
const fcadRead = await reader.call("read", { bytes: embedded });
for (const message of expectRead("02-flat-assembly.step", fcadRead.report)) fail(`fcad xde: ${message}`);
for (const message of compareReports(originalReports.get("02-flat-assembly.step"), fcadRead.report, "fcad vs 02")) fail(message);
assertMeshFrame("fcad", fcadRead.report, fcadRead.meshes);

const rotatedBytes = new Uint8Array(readFileSync(join(root, "test-data/rotated-assembly/08-rotated-nested.step")));
const rotatedExpected = JSON.parse(readFileSync(join(root, "test-data/rotated-assembly/EXPECTED.json"), "utf8"));
const rotated = await reader.call("read", { bytes: rotatedBytes });
for (const message of expectRotation(rotated.report, rotatedExpected)) fail(`08: ${message}`);
assertMeshFrame("08-rotated-nested.step", rotated.report, rotated.meshes);
const rotatedExport = await reader.call("export");
const rotatedStep = rotatedExport.bytes as Uint8Array;
if (rotatedExport.temporaryFiles?.length) fail(`08 export left ${rotatedExport.temporaryFiles.join(", ")}`);
writeFileSync(join(outDir, "08-rotated-nested.step"), rotatedStep);
const rotatedAgain = await reader.call("read", { bytes: rotatedStep });
for (const message of expectRotation(rotatedAgain.report, rotatedExpected)) fail(`08 reread: ${message}`);
for (const message of compareReports(rotated.report, rotatedAgain.report, "08")) fail(message);
assertMeshFrame("08 reread", rotatedAgain.report, rotatedAgain.meshes);
await reader.stop();

async function assertOwnership() {
  const init = (await import("@taucad/opencascade.js")).default;
  const wasmDir = dirname(fileURLToPath(import.meta.resolve("@taucad/opencascade.js/wasm")));
  const oc = await init({ locateFile: (name: string) => join(wasmDir, name) });
  const { XdeEngine } = await import("../src/xde/engine.ts");
  const text = (path: string) => new TextDecoder().decode(oc.FS.readFile(path) as Uint8Array);
  oc.FS.writeFile("/pre-existing-sentinel.txt", "owned by another component");
  const engine = new XdeEngine(oc);
  const owned = originalBytes.get("02-flat-assembly.step")!;
  for (let cycle = 1; cycle <= 20; cycle += 1) {
    engine.read(owned);
    engine.exportStep();
    const released = engine.release();
    if (released.temporaryFiles.length !== 0) fail(`in-process cycle ${cycle} listed ${released.temporaryFiles.join(", ")}`);
    const entries = (oc.FS.readdir("/") as string[]).filter((entry) => entry.startsWith("xde-"));
    if (entries.length) fail(`in-process cycle ${cycle} left ${entries.join(", ")}`);
  }
  if (text("/pre-existing-sentinel.txt") !== "owned by another component") fail("pre-existing sentinel content changed");
  oc.FS.writeFile("/foreign-after-construction.txt", "not created by the XDE engine");
  engine.release();
  if (text("/pre-existing-sentinel.txt") !== "owned by another component") fail("release removed the pre-existing sentinel");
  if (text("/foreign-after-construction.txt") !== "not created by the XDE engine") fail("release removed the foreign file created after construction");
  oc.FS.mkdir("/foreign-owned-dir");
  oc.FS.writeFile("/foreign-owned-dir/keep.txt", "foreign directory");
  engine.read(owned);
  engine.plantOwned("nested/residue.txt", new TextEncoder().encode("owned residue"));
  engine.plantOwned("nested/deeper/left.bin", new Uint8Array([1, 2, 3]));
  const planted = engine.temporaryFiles();
  if (!planted.includes("nested/residue.txt") || !planted.includes("nested/deeper/left.bin")) {
    fail(`planted files were not listed (${planted.join(", ")})`);
  }
  const cleaned = engine.release();
  if (cleaned.temporaryFiles.length !== 0) fail(`nested release listed ${cleaned.temporaryFiles.join(", ")}`);
  const afterNested = (oc.FS.readdir("/") as string[]).filter((entry) => String(entry).startsWith("xde-"));
  if (afterNested.length) fail(`nested release left ${afterNested.join(", ")}`);
  engine.read(owned);
  engine.plantOwned("nested/residue.txt", new TextEncoder().encode("owned residue"));
  const ownedName = (oc.FS.readdir("/") as string[]).find((entry) => String(entry).startsWith("xde-own-"));
  if (!ownedName) fail("the session directory was not created");
  const rootPath = `/${ownedName}`;
  const originalRmdir = oc.FS.rmdir.bind(oc.FS);
  oc.FS.rmdir = (path: string) => {
    if (path === rootPath) throw new Error("root rmdir refused");
    return originalRmdir(path);
  };
  let failedCleanup: string[] = [];
  try {
    failedCleanup = engine.release().temporaryFiles;
  } finally {
    oc.FS.rmdir = originalRmdir;
  }
  if (failedCleanup.length === 0) fail("failed cleanup reported an empty list");
  if (text("/pre-existing-sentinel.txt") !== "owned by another component") fail("failed cleanup changed the pre-existing sentinel");
  if (text("/foreign-after-construction.txt") !== "not created by the XDE engine") fail("failed cleanup changed the foreign file");
  if (text("/foreign-owned-dir/keep.txt") !== "foreign directory") fail("failed cleanup changed a foreign directory");
  const restored = engine.release();
  if (restored.temporaryFiles.length !== 0) fail(`cleanup after restoring rmdir listed ${restored.temporaryFiles.join(", ")}`);
  const afterRestore = (oc.FS.readdir("/") as string[]).filter((entry) => String(entry).startsWith("xde-"));
  if (afterRestore.length) fail(`restored cleanup left ${afterRestore.join(", ")}`);
  if (text("/foreign-owned-dir/keep.txt") !== "foreign directory") fail("restored cleanup changed a foreign directory");
  try {
    engine.read(new TextEncoder().encode("this is not a STEP file"));
    fail("in-process damaged STEP was accepted");
  } catch {
    // The reader must reject it and still drop only its own files.
  }
  const left = (oc.FS.readdir("/") as string[]).filter((entry) => entry.startsWith("xde-"));
  if (left.length) fail(`damaged read left ${left.join(", ")}`);
  if (text("/foreign-after-construction.txt") !== "not created by the XDE engine") fail("damaged read changed a foreign file");
  if (text("/pre-existing-sentinel.txt") !== "owned by another component") fail("damaged read changed the pre-existing sentinel");
  try {
    engine.exportStep();
    fail("export without a document succeeded");
  } catch {
    // No document is open. Nothing of ours should remain.
  }
  if (text("/foreign-after-construction.txt") !== "not created by the XDE engine") fail("failed export changed a foreign file");
  if (engine.heapBytes() !== null) fail(`heap was reported as ${engine.heapBytes()} instead of n/a`);
  engine.release();
  return { cycles: 20, heapBytes: engine.heapBytes(), preExistingPreserved: true, foreignAfterConstructionPreserved: true, nestedRemoved: true, failedCleanupReported: true };
}

const ownership = await assertOwnership();

const wasmPath = fileURLToPath(import.meta.resolve("@taucad/opencascade.js/wasm"));
const jsPath = fileURLToPath(import.meta.resolve("@taucad/opencascade.js"));
const provenance = JSON.parse(readFileSync(join(dirname(wasmPath), "opencascade_full.provenance.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "node_modules/@taucad/opencascade.js/package.json"), "utf8"));
const report = {
  ok: errors.length === 0,
  errors,
  damagedMessage,
  timings: { writer: firstStats, reader: rereadStats },
  counts: {
    originals: files.length,
    exports: exports.size,
    resourceCycles: 20,
    temporaryFilesAfterRelease: 0,
    rotatedFixture: "08-rotated-nested.step",
  },
  filesystem: ownership,
  fcad: meta,
  module: {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    entry: "dist/opencascade_full.js",
    wasm: "dist/opencascade_full.wasm",
    multiThreadEntryNotUsed: true,
    sha256: { js: sha256(readFileSync(jsPath)), wasm: sha256(readFileSync(wasmPath)) },
    bytes: { js: readFileSync(jsPath).byteLength, wasm: readFileSync(wasmPath).byteLength },
    provenance: {
      buildId: provenance.buildId,
      occtCommit: provenance.source.occtCommit,
      occtVersion: provenance.source.pinnedDeps.occt.version,
      opencascadejsCommit: provenance.source.opencascadejsCommit,
      emscripten: provenance.toolchain.emscripten,
      threadingField: provenance.compilation.threading,
      note: "The loaded artifact is the single-thread dist/opencascade_full pair. The provenance file's threading field says multi-threaded; that field is not the file that was instantiated.",
    },
  },
  ownership: "Node checks use worker_threads. Each Worker constructs its own WASM instance. Export bytes are re-read only after the writing worker has terminated. Handles never cross workers. Temporary virtual-FS files are removed on success and on failure. The product replicad worker is not involved. Heap size is n/a because this glue does not export HEAPU8.",
};
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, "original-reports.json"), JSON.stringify(Object.fromEntries(originalReports), null, 2));
writeFileSync(join(outDir, "reread-reports.json"), JSON.stringify({ ...Object.fromEntries(rereadReports), "02-pin-plus-5mm.step": shiftedReread.report, "original-assembly.fcad": fcadRead.report }, null, 2));
console.log(JSON.stringify({ ok: report.ok, errors: report.errors, damagedMessage, initMs: firstStats?.initMs, heapBytes: firstStats?.heapBytes }, null, 2));
if (!report.ok) process.exit(1);
