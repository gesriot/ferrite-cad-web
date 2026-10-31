import { stepErrors, tubeErrors } from "./checks.ts";
import { OcctSession } from "./client.ts";
import type { Inspect } from "./brep.ts";
import plateUrl from "../../fixtures/step/canonical/01-single-part.step?url";

export type OcctMesh = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

type InitResult = {
  initMs: number;
  wasmUrl: string;
  wasmMemoryBytes: number;
  thread: string;
};

type Built = Inspect & OcctMesh & { step: Uint8Array; info: Inspect };
type Imported = { info: Inspect; solids?: Inspect[] };

const PLATE = { volume: 24000, min: [0, 0, 0] as [number, number, number], max: [60, 40, 10] as [number, number, number] };
const RAISED = { volume: 36000, min: [0, 0, 0] as [number, number, number], max: [60, 40, 15] as [number, number, number] };

function boxErrors(info: Inspect, box: typeof PLATE, label: string): string[] {
  const errors: string[] = [];
  if (!info.valid || !info.solidValid) errors.push(`${label} failed BRepCheck`);
  if (info.solids !== 1 || info.solidType !== "TopAbs_SOLID") errors.push(`${label} solids ${info.solids} ${info.solidType}`);
  if (!(Math.abs(info.volume - box.volume) < 1e-3)) errors.push(`${label} volume ${info.volume} !== ${box.volume}`);
  for (let i = 0; i < 3; i++) {
    if (Math.abs(info.bounds.min[i]! - box.min[i]) > 1e-3) errors.push(`${label} min[${i}]=${info.bounds.min[i]}`);
    if (Math.abs(info.bounds.max[i]! - box.max[i]) > 1e-3) errors.push(`${label} max[${i}]=${info.bounds.max[i]}`);
  }
  if ((info.surfaces.PLANE ?? 0) < 6) errors.push(`${label} planar faces ${info.surfaces.PLANE ?? 0}`);
  if (!info.analyticOnly) errors.push(`${label} surfaces ${JSON.stringify(info.surfaces)}`);
  return errors;
}

function bytesDiffer(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return true;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return true;
  return false;
}

async function wasmProbe(url: string) {
  const started = performance.now();
  const response = await fetch(url);
  const contentType = response.headers.get("content-type") ?? "";
  const buffer = await response.arrayBuffer();
  const magic = new Uint8Array(buffer, 0, 4);
  const magicOk = magic.length === 4 && magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d;
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength)));
  return {
    url,
    status: response.status,
    contentType,
    bytes: buffer.byteLength,
    magicOk,
    htmlFallback: head.trimStart().startsWith("<"),
    fetchMs: performance.now() - started,
  };
}

export async function runOcctProof() {
  const errors: string[] = [];
  const sessionA = new OcctSession();
  let sessionB: OcctSession | null = null;
  let sessionC: OcctSession | null = null;
  let sessionD: OcctSession | null = null;
  let sessionE: OcctSession | null = null;
  try {
    const initA = await sessionA.call<InitResult>("init");
    const wasm = await wasmProbe(initA.wasmUrl);
    if (!wasm.magicOk) errors.push("WASM magic is not \\0asm");
    if (wasm.htmlFallback) errors.push("WASM URL returned HTML");
    if (!wasm.contentType.toLowerCase().includes("application/wasm")) {
      errors.push(`WASM content-type is ${wasm.contentType || "(empty)"}`);
    }
    const built = await sessionA.call<Built>("build-tube");
    errors.push(...tubeErrors(built.info).map((item) => `build: ${item}`));
    errors.push(...stepErrors(built.step).map((item) => `write: ${item}`));
    const originalStep = built.step.slice();
    sessionA.close();

    sessionB = new OcctSession();
    const initB = await sessionB.call<InitResult>("init");
    const readBack = await sessionB.call<Imported>("import-step", { step: originalStep.buffer }, [originalStep.buffer]);
    errors.push(...tubeErrors(readBack.info).map((item) => `reread: ${item}`));
    const readDelta = Math.abs(readBack.info.volume - built.info.volume);
    if (!(readDelta < 1e-6)) errors.push(`reread volume delta ${readDelta}`);

    const modified = await sessionB.call<Built>("modify-radial");
    if (!(modified.info.volume < built.info.volume - 100)) {
      errors.push(`radial cut did not remove material (${modified.info.volume} vs ${built.info.volume})`);
    }
    if (!modified.info.valid || !modified.info.solidValid) errors.push("modified solid failed BRepCheck");
    if (modified.info.solids !== 1) errors.push(`modified solids ${modified.info.solids}`);
    if (!modified.info.analyticOnly) errors.push(`modified surfaces ${JSON.stringify(modified.info.surfaces)}`);
    errors.push(...stepErrors(modified.step).map((item) => `modified write: ${item}`));
    if (!bytesDiffer(built.step, modified.step)) errors.push("modified STEP is byte-identical to the source STEP");
    const modifiedStep = modified.step.slice();
    const modifiedVolume = modified.info.volume;
    sessionB.close();
    sessionB = null;

    sessionC = new OcctSession();
    await sessionC.call<InitResult>("init");
    const payload = modifiedStep.slice();
    const rereadMod = await sessionC.call<Imported>("import-step", { step: payload.buffer }, [payload.buffer]);
    const modDelta = Math.abs(rereadMod.info.volume - modifiedVolume);
    if (!(modDelta < 1e-4)) errors.push(`modified reread volume delta ${modDelta}`);
    if (!rereadMod.info.valid || !rereadMod.info.solidValid) errors.push("modified reread failed BRepCheck");
    sessionC.close();
    sessionC = null;

    const plateResponse = await fetch(plateUrl);
    const plateBytes = new Uint8Array(await plateResponse.arrayBuffer());
    sessionD = new OcctSession();
    const initD = await sessionD.call<InitResult>("init");
    const plateCopy = plateBytes.slice();
    const plate = await sessionD.call<Imported>("import-step", { step: plateCopy.buffer }, [plateCopy.buffer]);
    errors.push(...boxErrors(plate.info, PLATE, "01-single-part"));
    const raised = await sessionD.call<Built>("fuse-slab", { min: [0, 0, 10], max: [60, 40, 15] });
    errors.push(...boxErrors(raised.info, RAISED, "plate raised"));
    if (!bytesDiffer(plateBytes, raised.step)) errors.push("raised STEP is byte-identical to 01-single-part.step");
    const raisedStep = raised.step.slice();
    sessionD.close();
    sessionD = null;

    sessionE = new OcctSession();
    const initE = await sessionE.call<InitResult>("init");
    const raisedCopy = raisedStep.slice();
    const plateReread = await sessionE.call<Imported>("import-step", { step: raisedCopy.buffer }, [raisedCopy.buffer]);
    errors.push(...boxErrors(plateReread.info, RAISED, "plate reread"));
    if (!(Math.abs(plateReread.info.volume - raised.info.volume) < 1e-4)) {
      errors.push(`plate reread volume delta ${plateReread.info.volume - raised.info.volume}`);
    }
    sessionE.close();
    sessionE = null;

    const report = {
      ok: errors.length === 0,
      errors,
      kernel: {
        package: "replicad-opencascadejs",
        replicad: "replicad",
        thread: initA.thread,
        initMs: initA.initMs,
        secondSessionInitMs: initB.initMs,
        plateSessionInitMs: initD.initMs,
        plateRereadInitMs: initE.initMs,
        wasmMemoryBytes: initA.wasmMemoryBytes,
      },
      wasm,
      tube: built.info,
      reread: readBack.info,
      modified: modified.info,
      modifiedReread: rereadMod.info,
      plate: plate.info,
      plateRaised: raised.info,
      plateReread: plateReread.info,
      stepBytes: built.step.byteLength,
      modifiedStepBytes: modified.step.byteLength,
      plateRaisedStepBytes: raised.step.byteLength,
      fcad: {
        supported: "minimal plate only; not the full .fcad format",
        where: "artifacts/format-roundtrip/edited-plate.fcad is written by src/occt/roundtrip.ts from the fixture, with BLAKE3 payload hashes. This browser session proves the STEP worker path.",
      },
    };
    return {
      report,
      mesh: { positions: raised.positions, normals: raised.normals, indices: raised.indices },
      steps: { tube: built.step, modified: modified.step, plateRaised: raised.step },
    };
  } finally {
    sessionA.close();
    sessionB?.close();
    sessionC?.close();
    sessionD?.close();
    sessionE?.close();
  }
}
