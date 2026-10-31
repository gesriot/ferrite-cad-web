/**
 * Deterministic controller/worker races. The real OCCT worker runs; only the
 * browser Worker transport and the DOM store are adapted. A reply is held
 * after the worker has executed the op, then released. Sleeps are not used
 * as the stopping point.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { Worker as NodeWorker } from "node:worker_threads";
import initOpenCascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { inspect, shapeFromStep } from "./brep.ts";
import { readFcad } from "./fcad-doc.ts";
import { wrapSql } from "./sql.ts";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ts = require("typescript") as typeof import("typescript");
const scratch = mkdtempSync(resolve(tmpdir(), "fcad-race-"));

function compile(file: string, rewrites: [string, string][]) {
  let source = readFileSync(resolve(root, "src/occt", file), "utf8");
  for (const [from, to] of rewrites) source = source.replaceAll(from, to);
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

const mod = (name: string) => pathToFileURL(resolve(root, "src/occt", name)).href;
const pkg = (name: string) => pathToFileURL(require.resolve(name)).href;
const occtWasm = require.resolve("replicad-opencascadejs/wasm");
const workerSource = compile("occt.worker.ts", [
  ['"./file-limits.ts"', JSON.stringify(mod("file-limits.ts"))],
  ['"replicad-opencascadejs"', JSON.stringify(pkg("replicad-opencascadejs"))],
  ['import wasmUrl from "replicad-opencascadejs/wasm?url";', `const wasmUrl=${JSON.stringify(occtWasm)};`],
  ['"sql.js"', JSON.stringify(pkg("sql.js"))],
  ['import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";', `const sqlWasmUrl=${JSON.stringify(require.resolve("sql.js/dist/sql-wasm.wasm"))};`],
  ['"replicad"', JSON.stringify(pathToFileURL(resolve(dirname(require.resolve("replicad")), "replicad.js")).href)],
  ['"./brep.ts"', JSON.stringify(mod("brep.ts"))],
  ['"./fcad-doc.ts"', JSON.stringify(mod("fcad-doc.ts"))],
  ['"./sql.ts"', JSON.stringify(mod("sql.ts"))],
]);
writeFileSync(resolve(scratch, "worker.mjs"), `import {parentPort} from 'node:worker_threads';
globalThis.self=globalThis;
globalThis.location={href:import.meta.url};
globalThis.postMessage=(data,transfer)=>parentPort.postMessage(data,transfer);
parentPort.on('message',data=>globalThis.onmessage({data}));
${workerSource}`);
writeFileSync(resolve(scratch, "ui.mjs"), `
export const state={exchange:null,transition:null,messages:[],mesh:null,
 flash(text){this.messages.push(text)},setExchange(v){this.exchange=v},setTransition(v){this.transition=v},
 setOcct(mesh,status){this.mesh=mesh;this.status=status},setTool(){},frame(){}};
export const useCad={getState:()=>state};
export const downloads=[];
export function download(name,bytes,mime){downloads.push({name,bytes,mime})}
export const safeName=(name)=>name;
`);
writeFileSync(
  resolve(scratch, "exchange.mjs"),
  compile("exchange.ts", [
    ['"./file-limits.ts"', JSON.stringify(mod("file-limits.ts"))],
    ['"@/lib/cad/stl.ts"', '"./ui.mjs"'],
    ['"@/lib/cad/store"', '"./ui.mjs"'],
    ['"./client.ts"', JSON.stringify(mod("client.ts"))],
    ['"./fcad.ts"', JSON.stringify(mod("fcad.ts"))],
    ['"./fcad-doc.ts"', JSON.stringify(mod("fcad-doc.ts"))],
  ]),
);

type Held = { op: string | null; release: (() => void) | null; ready: (() => void) | null };
const held: Held = { op: null, release: null, ready: null };
const bridges: { terminate: () => void; exited: Promise<number> }[] = [];

class BridgeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
  private ops = new Map<number, string>();
  private worker: NodeWorker;
  exited: Promise<number>;
  constructor() {
    this.worker = new NodeWorker(pathToFileURL(resolve(scratch, "worker.mjs")), { execArgv: ["--experimental-strip-types"], stdout: true, stderr: true });
    this.worker.stdout?.on("data", () => undefined);
    this.worker.stderr?.on("data", () => undefined);
    this.exited = new Promise((resolveExit) => this.worker.on("exit", (code) => resolveExit(code ?? 0)));
    this.worker.on("message", (data: { id: number }) => {
      if (held.op && this.ops.get(data.id) === held.op) {
        held.op = null;
        held.release = () => this.onmessage?.({ data });
        held.ready?.();
        return;
      }
      this.onmessage?.({ data });
    });
    this.worker.on("error", (error) => {
      try {
        this.onerror?.({ message: error.message, preventDefault() {} });
      } catch (caught) {
        console.error("worker onerror threw", caught);
      }
    });
    this.worker.on("messageerror", () => undefined);
    bridges.push(this);
  }
  postMessage(message: { id: number; op: string }, transfer?: readonly unknown[]) {
    this.ops.set(message.id, message.op);
    this.worker.postMessage(message, transfer as never);
  }
  terminate() {
    this.worker.terminate();
  }
}

globalThis.Worker = BridgeWorker as unknown as typeof Worker;

type ExchangeApi = {
  openExchangeFcad: (file: File) => Promise<unknown>;
  openExchangeStep: (file: File) => Promise<unknown>;
  commitExchangeHeight: (source: string) => Promise<unknown>;
  downloadExchangeFcad: () => Promise<unknown>;
  downloadExchangeStep: () => Promise<unknown>;
  closeExchange: () => Promise<unknown>;
  leaveExchangeForLegacy: (action: () => void) => Promise<unknown>;
  chooseDocumentGate: (id: string) => void;
  debugCrashWorker: () => Promise<unknown>;
  debugFailImport: () => Promise<unknown>;
};
type UiModule = {
  state: { exchange: { volume: number | null; fileName: string; busy: boolean; model?: { distanceMm: number } | null } | null; messages: string[]; transition: { actions: { id: string }[] } | null };
  downloads: { name: string; bytes: Uint8Array }[];
};

const api = (await import(pathToFileURL(resolve(scratch, "exchange.mjs")).href)) as ExchangeApi;
const ui = (await import(pathToFileURL(resolve(scratch, "ui.mjs")).href)) as UiModule;
const plate = new Uint8Array(readFileSync(resolve(root, "fixtures/original-plate.fcad")));
const profile = new Uint8Array(readFileSync(resolve(root, "fixtures/additional/offset-l-profile.fcad")));
const assembly = new Uint8Array(readFileSync(resolve(root, "fixtures/original-assembly.fcad")));
const step01 = new Uint8Array(readFileSync(resolve(root, "fixtures/step/canonical/01-single-part.step")));
const file = (bytes: Uint8Array, name: string) => new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], name);

function arm(op: string) {
  held.op = op;
  held.release = null;
  return new Promise<void>((resolveReady) => {
    held.ready = resolveReady;
  });
}

async function heightOf(bytes: Uint8Array) {
  const SQL = await require("sql.js")();
  const db = wrapSql(new SQL.Database(bytes));
  const doc = readFcad(db);
  db.close();
  if (!doc.ok || !doc.editable) throw new Error(doc.ok ? doc.reason : doc.error);
  return doc.model.distanceMm;
}

async function stepVolume(bytes: Uint8Array) {
  const shape = await shapeFromStep(bytes);
  const info = inspect(shape);
  shape.delete();
  return info.volume;
}

function waitGate() {
  return new Promise<void>((resolveGate, rejectGate) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (ui.state.transition) {
        clearInterval(timer);
        resolveGate();
      } else if (Date.now() - start > 20000) {
        clearInterval(timer);
        rejectGate(new Error(`no document gate; messages=${ui.state.messages.join(" | ")}`));
      }
    }, 10);
  });
}

async function closeDirty() {
  const closing = api.closeExchange();
  if (ui.state.exchange?.model) {
    await waitGate();
    api.chooseDocumentGate("discard");
  }
  await closing;
}

function exchangeNow() {
  return ui.state.exchange;
}

function near(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) <= 0.001, `${label}: ${actual} !~ ${expected}`);
}

test("file bytes, mesh and both exports stay one revision across commit boundaries", async () => {
  const oc = await initOpenCascade();
  setOC(oc);
  try {
    await api.openExchangeFcad(file(plate, "plate.fcad"));
    assert.equal(Math.round(ui.state.exchange?.volume ?? 0), 24000);

    const commitHeld = arm("commit-staged");
    const edit = api.commitExchangeHeight("16");
    await commitHeld;
    const opening = api.openExchangeFcad(file(new TextEncoder().encode("This is intentionally not SQLite."), "bad.fcad"));
    held.release?.();
    await Promise.all([edit, opening]);
    ui.downloads.length = 0;
    await api.downloadExchangeFcad();
    await api.downloadExchangeStep();
    const exported = ui.downloads.splice(0);
    const fcad = exported.find((item) => item.name.endsWith(".fcad"));
    const step = exported.find((item) => item.name.endsWith(".step"));
    assert.ok(fcad && step);
    near(ui.state.exchange?.volume ?? 0, 38400, "ui after late commit");
    assert.equal(ui.state.exchange?.model?.distanceMm, 16);
    assert.equal(await heightOf(fcad.bytes), 16);
    near(await stepVolume(step.bytes), 38400, "step after late commit");
    assert.ok(ui.state.messages.some((message) => /SQLite/.test(message)));

    await closeDirty();
    await api.openExchangeFcad(file(plate, "plate.fcad"));
    const stageHeld = arm("extrude-profile");
    const early = api.commitExchangeHeight("16");
    await stageHeld;
    const rejected = api.openExchangeFcad(file(new TextEncoder().encode("still not sqlite"), "bad-early.fcad"));
    held.release?.();
    await Promise.all([early, rejected]);
    ui.downloads.length = 0;
    await api.downloadExchangeFcad();
    await api.downloadExchangeStep();
    const kept = ui.downloads.splice(0);
    const keptFcad = kept.find((item) => item.name.endsWith(".fcad"))!;
    const keptStep = kept.find((item) => item.name.endsWith(".step"))!;
    near(ui.state.exchange?.volume ?? 0, 24000, "ui before commit");
    assert.equal(await heightOf(keptFcad.bytes), 10);
    near(await stepVolume(keptStep.bytes), 24000, "step before commit");

    await api.commitExchangeHeight("16");
    await api.commitExchangeHeight("9");
    ui.downloads.length = 0;
    await api.downloadExchangeFcad();
    await api.downloadExchangeStep();
    const sequential = ui.downloads.splice(0);
    assert.equal(await heightOf(sequential.find((item) => item.name.endsWith(".fcad"))!.bytes), 9);
    near(await stepVolume(sequential.find((item) => item.name.endsWith(".step"))!.bytes), 21600, "second height");
    near(ui.state.exchange?.volume ?? 0, 21600, "ui second height");

    ui.state.messages.length = 0;
    const cancelling = api.leaveExchangeForLegacy(() => undefined);
    await waitGate();
    api.chooseDocumentGate("cancel");
    await cancelling;
    near(ui.state.exchange?.volume ?? 0, 21600, "cancel keeps the edit");
    assert.equal(ui.state.exchange?.model?.distanceMm, 9);

    await closeDirty();
    let legacy = false;
    let releaseRead: () => void = () => undefined;
    const heldFile = {
      size: plate.byteLength,
      name: "late.fcad",
      arrayBuffer: () => new Promise<ArrayBuffer>((resolveBuffer) => {
        releaseRead = () => resolveBuffer(plate.buffer.slice(plate.byteOffset, plate.byteOffset + plate.byteLength));
      }),
    };
    const lateOpen = api.openExchangeFcad(heldFile as File);
    await api.leaveExchangeForLegacy(() => {
      legacy = true;
    });
    releaseRead();
    await lateOpen;
    assert.equal(legacy, true);
    assert.equal(exchangeNow(), null);

    await api.openExchangeStep(file(step01, "single.step"));
    const stepView = () => {
      const view = ui.state.exchange;
      if (!view) throw new Error("STEP view is gone");
      return view;
    };
    near(stepView().volume ?? 0, 24000, "step open");
    const dead = bridges.at(-1)!.exited;
    await api.debugCrashWorker().catch(() => undefined);
    await dead;
    ui.downloads.length = 0;
    ui.state.messages.length = 0;
    await api.downloadExchangeStep();
    assert.equal(ui.state.messages.length, 0);
    near(stepView().volume ?? 0, 24000, "step revived");
    assert.equal(stepView().busy, false);
    near(await stepVolume(ui.downloads[0]!.bytes), 24000, "revived step bytes");

    const deadAgain = bridges.at(-1)!.exited;
    await api.debugCrashWorker().catch(() => undefined);
    await deadAgain;
    await api.debugFailImport();
    ui.state.messages.length = 0;
    await api.downloadExchangeStep();
    assert.ok(ui.state.messages.some((message) => /STEP did not restore/.test(message)));
    near(stepView().volume ?? 0, 24000, "failed revive keeps the summary");
    assert.equal(stepView().busy, false);
    ui.state.messages.length = 0;
    ui.downloads.length = 0;
    await api.downloadExchangeStep();
    assert.equal(ui.state.messages.length, 0);
    near(await stepVolume(ui.downloads[0]!.bytes), 24000, "retry after failed revive");

    await api.closeExchange();
    await api.openExchangeFcad(file(plate, "plate.fcad"));
    const replaceHeld = arm("commit-staged");
    const replacing = api.openExchangeFcad(file(profile, "other.fcad"));
    await replaceHeld;
    let replaced = false;
    const leaving = api.leaveExchangeForLegacy(() => {
      replaced = true;
    });
    held.release?.();
    await Promise.all([replacing, leaving]);
    assert.equal(replaced, true);
    assert.equal(exchangeNow(), null);
    const notSql = (name: string) => file(new TextEncoder().encode("Intentionally not a SQLite file."), name);
    await api.openExchangeFcad(file(plate, "plate.fcad"));
    const heldRelease = arm("release");
    const closingPlate = api.closeExchange();
    await heldRelease;
    const lateInvalid = api.openExchangeFcad(notSql("bad.fcad"));
    held.release?.();
    await Promise.all([closingPlate, lateInvalid]);
    assert.equal(exchangeNow(), null, "late release must not keep the plate view");
    assert.ok(ui.state.messages.some((message) => /SQLite/.test(message)));
    ui.downloads.length = 0;
    ui.state.messages.length = 0;
    await api.downloadExchangeFcad();
    await api.downloadExchangeStep();
    assert.equal(ui.downloads.length, 0);
    assert.ok(ui.state.messages.filter((message) => /Document closed/.test(message)).length >= 2);
    await api.openExchangeFcad(file(plate, "plate.fcad"));
    const earlyClose = api.closeExchange();
    const earlyBad = api.openExchangeFcad(notSql("bad-early.fcad"));
    await Promise.all([earlyClose, earlyBad]);
    near(ui.state.exchange?.volume ?? 0, 24000, "close cancelled before release");
    assert.equal(ui.state.exchange?.fileName, "plate.fcad");
    assert.equal(ui.state.exchange?.busy, false);
    ui.downloads.length = 0;
    await api.downloadExchangeFcad();
    await api.downloadExchangeStep();
    const beforeRelease = ui.downloads.splice(0);
    assert.equal(await heightOf(beforeRelease.find((item) => item.name.endsWith(".fcad"))!.bytes), 10);
    near(await stepVolume(beforeRelease.find((item) => item.name.endsWith(".step"))!.bytes), 24000, "step before release");

    await api.closeExchange();
    assert.equal(exchangeNow(), null);
    ui.state.messages.length = 0;
    await api.downloadExchangeStep();
    assert.ok(ui.state.messages.some((message) => /Document closed/.test(message)));

    await api.openExchangeFcad(file(plate, "plate.fcad"));
    const unsupportedHeld = arm("release");
    const unsupported = api.openExchangeFcad(file(assembly, "assembly.fcad"));
    await unsupportedHeld;
    const duringUnsupported = api.openExchangeFcad(notSql("bad-unsupported.fcad"));
    held.release?.();
    await Promise.all([unsupported, duringUnsupported]);
    assert.equal(exchangeNow(), null, "superseded unsupported install must not keep the old solid");

    await api.openExchangeFcad(file(plate, "plate.fcad"));
    const releaseReplace = arm("release");
    const closingAgain = api.closeExchange();
    await releaseReplace;
    const next = api.openExchangeFcad(file(profile, "l.fcad"));
    held.release?.();
    await Promise.all([closingAgain, next]);
    near(ui.state.exchange?.volume ?? 0, 20320, "valid open after release");
    assert.equal(ui.state.exchange?.busy, false);
    ui.downloads.length = 0;
    await api.downloadExchangeFcad();
    await api.downloadExchangeStep();
    const replacedExports = ui.downloads.splice(0);
    assert.equal(await heightOf(replacedExports.find((item) => item.name.endsWith(".fcad"))!.bytes), 12.7);
    near(await stepVolume(replacedExports.find((item) => item.name.endsWith(".step"))!.bytes), 20320, "L step after release");

    await api.closeExchange();
    await api.openExchangeFcad(file(plate, "plate.fcad"));
    await api.commitExchangeHeight("16");
    const cancelRelease = api.leaveExchangeForLegacy(() => undefined);
    await waitGate();
    api.chooseDocumentGate("cancel");
    await cancelRelease;
    near(ui.state.exchange?.volume ?? 0, 38400, "cancel keeps the solid");
    ui.downloads.length = 0;
    await api.downloadExchangeFcad();
    await api.downloadExchangeStep();
    const cancelled = ui.downloads.splice(0);
    assert.equal(await heightOf(cancelled.find((item) => item.name.endsWith(".fcad"))!.bytes), 16);
    near(await stepVolume(cancelled.find((item) => item.name.endsWith(".step"))!.bytes), 38400, "cancel step");

    const crashed = bridges.at(-1)!.exited;
    await api.debugCrashWorker().catch(() => undefined);
    await crashed;
    near(ui.state.exchange?.volume ?? 0, 38400, "crash keeps the dirty plate");
    assert.equal(ui.state.exchange?.busy, false);
    ui.downloads.length = 0;
    ui.state.messages.length = 0;
    await api.downloadExchangeFcad();
    await api.downloadExchangeStep();
    const revived = ui.downloads.splice(0);
    assert.equal(await heightOf(revived.find((item) => item.name.endsWith(".fcad"))!.bytes), 16);
    near(await stepVolume(revived.find((item) => item.name.endsWith(".step"))!.bytes), 38400, "dirty plate revived after crash");
    const closingCrashed = api.closeExchange();
    await waitGate();
    api.chooseDocumentGate("discard");
    await closingCrashed;
    assert.equal(exchangeNow(), null);
    ui.state.messages.length = 0;
    await api.downloadExchangeStep();
    assert.ok(ui.state.messages.some((message) => /Document closed/.test(message)));
    await api.openExchangeFcad(file(plate, "plate.fcad"));
    near(ui.state.exchange?.volume ?? 0, 24000, "reopen after crash and close");
    assert.equal(ui.state.exchange?.busy, false);
  } finally {
    for (const bridge of bridges) bridge.terminate();
  }
});
