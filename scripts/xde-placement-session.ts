/**
 * Experimental placement session. Not part of the default test:xde run.
 *
 * A new worker is a new WASM instance. The stored scene is compared only after
 * that worker reads the embedded STEP and installs placements again.
 * STEP export is a different file: differences are listed and are not an exact bind.
 *
 *   node --experimental-strip-types scripts/xde-placement-session.ts
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { EXPERIMENTAL_PLACEMENT_IMPORTER, writeImportedDocument } from "../src/occt/fcad-import.ts";
import { readEmbeddedStep } from "../src/occt/fcad-doc.ts";
import { bindImportedScene } from "../src/occt/fcad-scene.ts";
import { wrapSql } from "../src/occt/sql.ts";
import { hexOf } from "../src/xde/placement-math/f64.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outDir = join(root, "artifacts/xde/placement-session");
mkdirSync(outDir, { recursive: true });
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js") as (options: { wasmBinary: Uint8Array }) => Promise<{ Database: new (bytes?: Uint8Array) => { exec(sql: string): void; run(sql: string, params?: unknown[]): void; prepare(sql: string): { bind(values?: unknown[]): void; step(): boolean; get(): unknown[]; free(): void }; export(): Uint8Array; close(): void } }>;
const sqlWasm = readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm"));
const SQL = await initSqlJs({ wasmBinary: sqlWasm });

const sources = [
  ["01-single-part.step", "test-data/writer-goldens/sources/01-single-part.step"],
  ["02-flat-assembly.step", "test-data/writer-goldens/sources/02-flat-assembly.step"],
  ["02-pin-plus-5mm.step", "test-data/writer-goldens/sources/02-pin-plus-5mm.step"],
  ["03-nested-assembly.step", "test-data/writer-goldens/sources/03-nested-assembly.step"],
  ["04-instance-colours.step", "test-data/writer-goldens/sources/04-instance-colours.step"],
  ["05-inch-units.step", "test-data/writer-goldens/sources/05-inch-units.step"],
  ["06-unicode-names.step", "test-data/writer-goldens/sources/06-unicode-names.step"],
  ["07-bare-geometry.step", "test-data/writer-goldens/sources/07-bare-geometry.step"],
  ["08-rotated-nested.step", "test-data/writer-goldens/sources/08-rotated-nested.step"],
  ["complex.stp", "test-data/complex/c3d-ap203-complex-assembly.stp"],
];

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function startWorker() {
  const worker = new Worker(new URL("../src/xde/node-worker.ts", import.meta.url), { execArgv: ["--experimental-strip-types"] });
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

function stageMisses(placement: any) {
  const stages = ["candidate", "gpTrsf", "topLoc", "getLocation", "shapeLocation"];
  const misses: Record<string, number> = {};
  let elements = 0;
  let first: any = null;
  for (const row of placement?.rows ?? []) {
    elements += 12;
    const expected = row.candidate as string[];
    for (const stage of stages) {
      const got = (row[stage] ?? []) as string[];
      for (let element = 0; element < 12; element += 1) {
        if (got[element] !== expected[element]) {
          misses[stage] = (misses[stage] ?? 0) + 1;
          first ??= { stage, index: row.index, entry: row.entry, element, expected: expected[element], actual: got[element] };
        }
      }
    }
  }
  return { elements, misses, first };
}

function hexMatrix(values: number[]) {
  return values.map((value) => hexOf(value));
}

function matrixMisses(left: string[], right: string[]) {
  const found = [];
  for (let element = 0; element < 12; element += 1) {
    if (left[element] !== right[element]) found.push({ element, left: left[element], right: right[element] });
  }
  return found;
}

function semanticStep(source: any, exported: any) {
  const diffs: any[] = [];
  const push = (item: any) => {
    if (diffs.length < 40) diffs.push(item);
  };
  if (source.nodes.length !== exported.nodes.length) push({ kind: "node-count", source: source.nodes.length, exported: exported.nodes.length });
  if (source.leafVolumeMm3 !== exported.leafVolumeMm3) push({ kind: "leaf-volume", source: source.leafVolumeMm3, exported: exported.leafVolumeMm3 });
  const count = Math.min(source.nodes.length, exported.nodes.length);
  let localMisses = 0;
  let worldMisses = 0;
  let nameMisses = 0;
  let colourMisses = 0;
  let solidMisses = 0;
  let invalidMisses = 0;
  let volumeMisses = 0;
  for (let index = 0; index < count; index += 1) {
    const left = source.nodes[index];
    const right = exported.nodes[index];
    if (left.occurrenceName !== right.occurrenceName || left.definitionName !== right.definitionName) {
      nameMisses += 1;
      push({ kind: "name", index, source: [left.definitionName, left.occurrenceName], exported: [right.definitionName, right.occurrenceName] });
    }
    if (left.solids !== right.solids) {
      solidMisses += 1;
      push({ kind: "solids", index, source: left.solids, exported: right.solids });
    }
    if (left.invalidSolids !== right.invalidSolids) {
      invalidMisses += 1;
      push({ kind: "invalid-solids", index, path: left.path, source: left.invalidSolids, exported: right.invalidSolids });
    }
    if (left.volumeMm3 !== right.volumeMm3) {
      volumeMisses += 1;
      push({ kind: "volume", index, source: left.volumeMm3, exported: right.volumeMm3 });
    }
    if (JSON.stringify(left.color) !== JSON.stringify(right.color)) {
      colourMisses += 1;
      push({ kind: "colour", index, source: left.color, exported: right.color });
    }
    const local = matrixMisses(hexMatrix(left.local), hexMatrix(right.local));
    localMisses += local.length;
    if (local.length) push({ kind: "local", index, path: left.path, count: local.length, first: local[0] });
    const world = matrixMisses(hexMatrix(left.world), hexMatrix(right.world));
    worldMisses += world.length;
    if (world.length) push({ kind: "world", index, path: left.path, count: world.length, first: world[0] });
  }
  return { diffs, localMisses, worldMisses, nameMisses, colourMisses, solidMisses, invalidMisses, volumeMisses, exactBind: false };
}

function sceneKeyDiffs(stored: any, fresh: any) {
  const storedKeys = stored.definitions.map((item: { key: string }) => item.key);
  const freshKeys = fresh.definitions.map((item: { key: string }) => item.key);
  let mismatches = 0;
  const count = Math.min(storedKeys.length, freshKeys.length);
  for (let index = 0; index < count; index += 1) if (storedKeys[index] !== freshKeys[index]) mismatches += 1;
  mismatches += Math.abs(storedKeys.length - freshKeys.length);
  return { stored: storedKeys.length, fresh: freshKeys.length, mismatches, firstStored: storedKeys.find((key: string, index: number) => key !== freshKeys[index]) ?? null, firstFresh: freshKeys.find((key: string, index: number) => key !== storedKeys[index]) ?? null };
}

function invalidNodes(report: any) {
  return report.nodes
    .map((node: any, index: number) => ({ index, path: node.path, definitionName: node.definitionName, solids: node.solids, invalidSolids: node.invalidSolids, volumeMm3: node.volumeMm3 }))
    .filter((node: { invalidSolids: number }) => node.invalidSolids > 0);
}

function writeFcad(step: Uint8Array, sourceName: string, scene: any) {
  const db = wrapSql(new SQL.Database());
  try {
    return writeImportedDocument(db, { step, sourceName, objectName: sourceName.replace(/\.(step|stp)$/i, ""), scene, importer: EXPERIMENTAL_PLACEMENT_IMPORTER });
  } finally {
    db.close();
  }
}

function readFcad(bytes: Uint8Array) {
  const db = wrapSql(new SQL.Database(bytes));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    return readEmbeddedStep(db);
  } finally {
    db.close();
  }
}

const failures: string[] = [];
const files: any[] = [];
const wasmPath = fileURLToPath(import.meta.resolve("@taucad/opencascade.js/wasm"));
const wasmBytes = readFileSync(wasmPath);

for (const [name, relative] of sources) {
  const step = new Uint8Array(readFileSync(join(root, relative)));
  const first = startWorker();
  let read: any;
  let exported: Uint8Array;
  try {
    read = await first.call("read", { bytes: step, experimental: true });
    const out = await first.call("export");
    exported = out.bytes as Uint8Array;
  } finally {
    await first.stop();
  }
  const file: any = {
    file: relative,
    sourceSha256: sha256(step),
    sourceBytes: step.byteLength,
    placement: read.placement
      ? { mode: read.placement.mode, occurrences: read.placement.occurrences, labelsWritten: read.placement.labelsWritten, rawBoundaryDifferences: read.placement.rawBoundaryDifferences, ...stageMisses(read.placement) }
      : null,
    sceneError: read.sceneError,
    invalidSolids: invalidNodes(read.report),
    diagnostics: (read.scene?.diagnostics ?? []).filter((item: { entity?: string }) => String(item.entity).includes("2583") || /invalid/i.test(String(item.message))),
  };
  if (!read.placement) failures.push(`${name} experimental read returned no placement proof`);
  if (read.sceneError || !read.scene) failures.push(`${name} did not project: ${read.sceneError}`);
  if (file.placement?.first) failures.push(`${name} kernel readback mismatch ${JSON.stringify(file.placement.first)}`);
  const fcad = writeFcad(step, name, read.scene);
  writeFileSync(join(outDir, `${name}.experimental-import.fcad`), fcad);
  const extracted = readFcad(fcad);
  file.embeddedSha256 = sha256(extracted.step);
  file.embeddedEqualsSource = file.embeddedSha256 === file.sourceSha256;
  file.importerBuild = Buffer.from(fcad).includes(EXPERIMENTAL_PLACEMENT_IMPORTER.build) ? EXPERIMENTAL_PLACEMENT_IMPORTER.build : "missing";
  if (!file.embeddedEqualsSource) failures.push(`${name} FCAD replaced the STEP bytes`);
  if (file.importerBuild !== EXPERIMENTAL_PLACEMENT_IMPORTER.build) failures.push(`${name} importer build was not the experimental WASM label`);
  const second = startWorker();
  try {
    const again = await second.call("read", { bytes: extracted.step, experimental: true });
    const bound = bindImportedScene(extracted.scene, again.scene);
    file.reopen = { confirmed: bound.confirmed, error: bound.error, occurrences: again.placement?.occurrences ?? null, labelsWritten: again.placement?.labelsWritten ?? null };
    if (!bound.confirmed) failures.push(`${name} new session did not exact-bind: ${bound.error}`);
  } finally {
    await second.stop();
  }
  writeFileSync(join(outDir, `${name}.experimental-export.step`), exported);
  file.exportSha256 = sha256(exported);
  file.exportEqualsSource = file.exportSha256 === file.sourceSha256;
  const third = startWorker();
  try {
    const reread = await third.call("read", { bytes: exported, experimental: true });
    file.stepRoundTrip = semanticStep(read.report, reread.report);
    file.stepRoundTrip.definitionKeys = sceneKeyDiffs(read.scene, reread.scene);
    file.stepRoundTrip.note = "STEP product ids and representation rounding may differ. This is not an exact FCAD bind.";
  } finally {
    await third.stop();
  }
  files.push(file);
  console.log(`${name} labels ${file.placement?.labelsWritten} occurrences ${file.placement?.occurrences} reopen ${file.reopen?.confirmed} step-local-misses ${file.stepRoundTrip?.localMisses}`);
}

const nativeFcad = new Uint8Array(readFileSync(join(root, "test-data/complex/complex-native.fcad")));
const nativeExtract = readFcad(nativeFcad);
const standard = startWorker();
let standardBind: { confirmed: boolean; error: string | null };
try {
  const read = await standard.call("read", { bytes: nativeExtract.step, experimental: false });
  standardBind = bindImportedScene(nativeExtract.scene, read.scene);
} finally {
  await standard.stop();
}
const experimental = startWorker();
let experimentalBind: { confirmed: boolean; error: string | null };
let experimentalInvalid: any[] = [];
let experimentalDiagnostics: any[] = [];
try {
  const read = await experimental.call("read", { bytes: nativeExtract.step, experimental: true });
  experimentalBind = bindImportedScene(nativeExtract.scene, read.scene);
  experimentalInvalid = invalidNodes(read.report);
  experimentalDiagnostics = read.scene?.diagnostics ?? [];
} finally {
  await experimental.stop();
}
if (standardBind.confirmed) failures.push("standard mode confirmed complex-native.fcad");
if (!experimentalBind.confirmed) failures.push(`experimental mode did not exact-bind complex-native.fcad: ${experimentalBind.error}`);
const keptInvalid = experimentalDiagnostics.filter((item) => String(item.entity).includes("2583"));
if (!keptInvalid.length) failures.push("experimental complex reading dropped the product_definition#2583 invalid-solid diagnostic");

const report = {
  date: "2026-10-19",
  mode: "experimental-placement-compatibility",
  importer: EXPERIMENTAL_PLACEMENT_IMPORTER,
  wasm: { path: wasmPath.replace(root + "/", ""), sha256: sha256(wasmBytes), bytes: wasmBytes.byteLength },
  complexStepSha256: sha256(readFileSync(join(root, "test-data/complex/c3d-ap203-complex-assembly.stp"))),
  files,
  complexNative: {
    file: "test-data/complex/complex-native.fcad",
    sha256: sha256(nativeFcad),
    embeddedSha256: sha256(nativeExtract.step),
    standard: { confirmed: standardBind.confirmed, error: standardBind.error },
    experimental: { confirmed: experimentalBind.confirmed, error: experimentalBind.error, invalidSolids: experimentalInvalid, diagnostics: experimentalDiagnostics },
  },
  failures,
};
writeFileSync(join(outDir, "session.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(failures.length ? failures.join("\n") : "session ok");
if (failures.length) process.exit(1);
