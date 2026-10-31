import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { blake3 } from "@noble/hashes/blake3";
import initOpenCascade from "replicad-opencascadejs";
import { getOC, setOC } from "replicad";
import { extrudeProfile, fuseSlab, inspect, inspectSolids, openStep, stepBytes, type Inspect } from "./brep.ts";
import { blake3Hex, bytesEqual, FCAD_APPLICATION_ID, hashMatches, patchExtrudeDistance, readPlateModel, uuidOf } from "./fcad.ts";
import { cborToValue, decodeCbor } from "./cbor.ts";

const ROOT = join(import.meta.dirname, "../..");
const FIX = join(ROOT, "fixtures");
const OUT = join(ROOT, "artifacts/format-roundtrip");
const VOLUME_TOL = 1e-3;
const BBOX_TOL = 1e-3;

type Vec3 = [number, number, number];
type PartExpect = {
  name: string;
  volume: number;
  min: Vec3;
  max: Vec3;
  surfaces?: Record<string, number>;
};
type FileExpect = {
  file: string;
  solids: number;
  volume: number;
  min: Vec3;
  max: Vec3;
  parts: PartExpect[];
};

const EXPECTED: FileExpect[] = [
  {
    file: "step/canonical/01-single-part.step",
    solids: 1,
    volume: 24000,
    min: [0, 0, 0],
    max: [60, 40, 10],
    parts: [{ name: "Plate", volume: 24000, min: [0, 0, 0], max: [60, 40, 10], surfaces: { PLANE: 6 } }],
  },
  {
    file: "step/canonical/02-flat-assembly.step",
    solids: 2,
    volume: 25963.4954,
    min: [0, 0, 0],
    max: [60, 40, 35],
    parts: [
      { name: "Bracket/Base", volume: 24000, min: [0, 0, 0], max: [60, 40, 10], surfaces: { PLANE: 6 } },
      { name: "Bracket/Pin", volume: 1963.4954, min: [25, 15, 10], max: [35, 25, 35], surfaces: { CYLINDRE: 1, PLANE: 2 } },
    ],
  },
  {
    file: "step/canonical/03-nested-assembly.step",
    solids: 4,
    volume: 32000,
    min: [0, 0, 0],
    max: [50, 60, 20],
    parts: [
      { name: "cube@0,0", volume: 8000, min: [0, 0, 0], max: [20, 20, 20], surfaces: { PLANE: 6 } },
      { name: "cube@30,0", volume: 8000, min: [30, 0, 0], max: [50, 20, 20], surfaces: { PLANE: 6 } },
      { name: "cube@0,40", volume: 8000, min: [0, 40, 0], max: [20, 60, 20], surfaces: { PLANE: 6 } },
      { name: "cube@30,40", volume: 8000, min: [30, 40, 0], max: [50, 60, 20], surfaces: { PLANE: 6 } },
    ],
  },
  {
    file: "step/canonical/04-instance-colours.step",
    solids: 4,
    volume: 1357.168,
    min: [-3, -3, 0],
    max: [48, 18, 12],
    parts: [
      { name: "bolt@0,0", volume: 339.292, min: [-3, -3, 0], max: [3, 3, 12], surfaces: { CYLINDRE: 1, PLANE: 2 } },
      { name: "bolt@15,15", volume: 339.292, min: [12, 12, 0], max: [18, 18, 12], surfaces: { CYLINDRE: 1, PLANE: 2 } },
      { name: "bolt@30,0", volume: 339.292, min: [27, -3, 0], max: [33, 3, 12], surfaces: { CYLINDRE: 1, PLANE: 2 } },
      { name: "bolt@45,15", volume: 339.292, min: [42, 12, 0], max: [48, 18, 12], surfaces: { CYLINDRE: 1, PLANE: 2 } },
    ],
  },
  {
    file: "step/canonical/05-inch-units.step",
    solids: 1,
    volume: 16387.064,
    min: [0, 0, 0],
    max: [50.8, 25.4, 12.7],
    parts: [{ name: "InchPlate", volume: 16387.064, min: [0, 0, 0], max: [50.8, 25.4, 12.7], surfaces: { PLANE: 6 } }],
  },
  {
    file: "step/canonical/06-unicode-names.step",
    solids: 2,
    volume: 11000,
    min: [0, 0, 0],
    max: [40, 20, 30],
    parts: [
      { name: "Кронштейн", volume: 8000, min: [0, 0, 0], max: [20, 20, 20], surfaces: { PLANE: 6 } },
      { name: "Épaisseur", volume: 3000, min: [30, 0, 0], max: [40, 10, 30], surfaces: { PLANE: 6 } },
    ],
  },
  {
    file: "step/canonical/07-bare-geometry.step",
    solids: 1,
    volume: 3375,
    min: [0, 0, 0],
    max: [15, 15, 15],
    parts: [{ name: "SOLID", volume: 3375, min: [0, 0, 0], max: [15, 15, 15], surfaces: { PLANE: 6 } }],
  },
];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function near(actual: number, expected: number, tol: number): boolean {
  return Math.abs(actual - expected) <= tol;
}

function bboxErrors(info: Inspect, min: Vec3, max: Vec3, label: string): string[] {
  const errors: string[] = [];
  for (let i = 0; i < 3; i++) {
    if (!near(info.bounds.min[i]!, expectedAxis(min, i), BBOX_TOL)) errors.push(`${label} min[${i}]=${info.bounds.min[i]} expected ${min[i]}`);
    if (!near(info.bounds.max[i]!, expectedAxis(max, i), BBOX_TOL)) errors.push(`${label} max[${i}]=${info.bounds.max[i]} expected ${max[i]}`);
  }
  return errors;
}

function expectedAxis(value: Vec3, index: number): number {
  return value[index]!;
}

function shapeErrors(info: Inspect, expect: { solids: number; volume: number; min: Vec3; max: Vec3 }, label: string): string[] {
  const errors: string[] = [];
  if (!info.valid) errors.push(`${label} BRepCheck rejected the shape`);
  if (info.solids !== expect.solids) errors.push(`${label} solids ${info.solids} !== ${expect.solids}`);
  if (!near(info.volume, expect.volume, VOLUME_TOL)) errors.push(`${label} volume ${info.volume} !== ${expect.volume}`);
  if (info.solids === 1 && !info.solidValid) errors.push(`${label} BRepCheck rejected the solid`);
  errors.push(...bboxErrors(info, expect.min, expect.max, label));
  return errors;
}

function matchParts(solids: Inspect[], parts: PartExpect[]): { errors: string[]; matched: { name: string; volume: number; bounds: Inspect["bounds"]; surfaces: Inspect["surfaces"] }[] } {
  const used = new Set<number>();
  const errors: string[] = [];
  const matched = [];
  for (const part of parts) {
    let found = -1;
    for (let i = 0; i < solids.length; i++) {
      if (used.has(i)) continue;
      const solid = solids[i]!;
      const volumeOk = near(solid.volume, part.volume, VOLUME_TOL);
      const boxOk = bboxErrors(solid, part.min, part.max, part.name).length === 0;
      if (volumeOk && boxOk) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      errors.push(`no solid matched ${part.name} volume ${part.volume} box ${part.min.join(",")}..${part.max.join(",")}`);
      continue;
    }
    used.add(found);
    const solid = solids[found]!;
    if (!solid.valid || !solid.solidValid) errors.push(`${part.name} failed BRepCheck`);
    if (!solid.analyticOnly) errors.push(`${part.name} surfaces ${JSON.stringify(solid.surfaces)}`);
    for (const [kind, count] of Object.entries(part.surfaces ?? {})) {
      if ((solid.surfaces[kind] ?? 0) < count) errors.push(`${part.name} ${kind} ${solid.surfaces[kind] ?? 0} < ${count}`);
    }
    matched.push({ name: part.name, volume: solid.volume, bounds: solid.bounds, surfaces: solid.surfaces });
  }
  if (used.size !== solids.length) errors.push(`${solids.length - used.size} solid(s) were not matched`);
  return { errors, matched };
}

function headerText(bytes: Uint8Array) {
  const text = new TextDecoder("latin1").decode(bytes);
  const schema = text.match(/FILE_SCHEMA\(\(\s*'([^']+)'/)?.[1] ?? null;
  const colours = [...text.matchAll(/COLOUR_RGB\('([^']*)',([-\d.]+),([-\d.]+),([-\d.]+)\)/g)].map((match) => ({
    name: match[1],
    rgb: [Number(match[2]), Number(match[3]), Number(match[4])],
  }));
  return {
    note: "Literal STEP entities. Not an XCAFDoc colour or placement binding.",
    schema,
    declaresMilliMetre: text.includes("SI_UNIT(.MILLI.,.METRE.)"),
    declaresInch: text.includes("CONVERSION_BASED_UNIT('INCH'"),
    colourRgbEntities: colours,
  };
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return value.byteLength === 16 ? uuidOf(value) : Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item);
    return out;
  }
  return value;
}

function blob(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(`${label} is not a blob`);
}

type Obj = {
  id: Uint8Array;
  kind: string;
  schema_version: number;
  parent_id: Uint8Array | null;
  ordinal: number;
  name: string | null;
  payload: Uint8Array;
  payload_hash: Uint8Array;
};

function readObjects(db: DatabaseSync): Obj[] {
  const rows = db.prepare("select id, kind, schema_version, parent_id, ordinal, name, payload, payload_hash from objects order by ordinal").all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: blob(row.id, "id"),
    kind: String(row.kind),
    schema_version: Number(row.schema_version),
    parent_id: row.parent_id == null ? null : blob(row.parent_id, "parent"),
    ordinal: Number(row.ordinal),
    name: row.name == null ? null : String(row.name),
    payload: blob(row.payload, "payload"),
    payload_hash: blob(row.payload_hash, "payload_hash"),
  }));
}

function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
  return Number(Object.values(row)[0]);
}

async function readCanonical(relative: string) {
  const bytes = new Uint8Array(readFileSync(join(FIX, relative)));
  const opened = await openStep(bytes);
  const info = inspect(opened.shape);
  const solids = inspectSolids(opened.shape);
  opened.shape.delete();
  return { bytes, opened, info, solids };
}

async function main() {
  const errors: string[] = [];
  const started = Date.now();
  setOC(await initOpenCascade());
  const oc = getOC() as unknown as Record<string, unknown>;
  const xdeReader = typeof oc.STEPCAFControl_Reader === "function";
  mkdirSync(OUT, { recursive: true });

  const files: Record<string, unknown> = {};
  for (const expect of EXPECTED) {
    const read = await readCanonical(expect.file);
    const parts = matchParts(read.solids, expect.parts);
    const fileErrors = [...shapeErrors(read.info, expect, expect.file), ...parts.errors];
    errors.push(...fileErrors);
    files[expect.file] = {
      ok: fileErrors.length === 0,
      errors: fileErrors,
      sha256: sha256(read.bytes),
      bytes: read.bytes.byteLength,
      readStatus: read.opened.readStatus,
      roots: read.opened.roots,
      transferred: read.opened.transferred,
      systemLengthUnit: read.opened.systemLengthUnit,
      fileLengthUnits: read.opened.fileLengthUnits,
      fileAngleUnits: read.opened.fileAngleUnits,
      unitApi: read.opened.unitError,
      shape: read.info,
      solids: read.solids,
      matched: parts.matched,
      headerText: headerText(read.bytes),
    };
  }

  const plateBytes = new Uint8Array(readFileSync(join(FIX, "step/canonical/01-single-part.step")));
  const openedPlate = await openStep(plateBytes);
  const raisedShape = fuseSlab(openedPlate.shape, [0, 0, 10], [60, 40, 15]);
  const raisedInfo = inspect(raisedShape);
  const raisedStep = await stepBytes(raisedShape);
  raisedShape.delete();
  const raisedErrors = shapeErrors(raisedInfo, { solids: 1, volume: 36000, min: [0, 0, 0], max: [60, 40, 15] }, "raised plate");
  if (!raisedInfo.solidValid) raisedErrors.push("raised solid failed BRepCheck");
  if (!raisedInfo.analyticOnly) raisedErrors.push(`raised surfaces ${JSON.stringify(raisedInfo.surfaces)}`);
  if ((raisedInfo.surfaces.PLANE ?? 0) < 6) raisedErrors.push(`raised planar faces ${raisedInfo.surfaces.PLANE ?? 0}`);
  if (bytesEqual(plateBytes, raisedStep)) raisedErrors.push("raised STEP is byte-identical to 01-single-part.step");
  const raisedText = new TextDecoder().decode(raisedStep);
  for (const marker of ["ISO-10303-21", "MANIFOLD_SOLID_BREP", "PLANE", "CLOSED_SHELL"]) {
    if (!raisedText.includes(marker)) raisedErrors.push(`raised STEP missing ${marker}`);
  }
  const reread = await openStep(raisedStep);
  const rereadInfo = inspect(reread.shape);
  reread.shape.delete();
  raisedErrors.push(...shapeErrors(rereadInfo, { solids: 1, volume: 36000, min: [0, 0, 0], max: [60, 40, 15] }, "raised reread"));
  if (!rereadInfo.solidValid || !rereadInfo.analyticOnly) raisedErrors.push("raised reread is not a valid analytic solid");
  if (!near(rereadInfo.volume, raisedInfo.volume, 1e-4)) raisedErrors.push(`raised reread volume delta ${rereadInfo.volume - raisedInfo.volume}`);
  errors.push(...raisedErrors);
  const stepOut = join(OUT, "01-single-part-height-15.step");
  writeFileSync(stepOut, raisedStep);

  const platePath = join(FIX, "original-plate.fcad");
  const plateDb = new DatabaseSync(platePath, { readOnly: true });
  const plateObjects = readObjects(plateDb);
  const plateHashes = plateObjects.map((row) => ({
    id: uuidOf(row.id),
    kind: row.kind,
    blake3: blake3Hex(row.payload),
    stored: Buffer.from(row.payload_hash).toString("hex"),
    ok: hashMatches(row.payload, row.payload_hash),
  }));
  if (plateHashes.some((row) => !row.ok)) errors.push("original-plate payload_hash is not BLAKE3-256 of payload");
  const topoRows = plateDb.prepare("select id, owner_id, producer_feature, expected_kind, payload, payload_hash from topology_refs").all() as Record<string, unknown>[];
  const topoHashes = topoRows.map((row) => {
    const payload = blob(row.payload, "topo");
    const hash = blob(row.payload_hash, "topo hash");
    return { id: uuidOf(blob(row.id, "topo id")), ok: hashMatches(payload, hash), stored: Buffer.from(hash).toString("hex"), blake3: blake3Hex(payload) };
  });
  if (topoHashes.some((row) => !row.ok)) errors.push("topology payload_hash is not BLAKE3-256 of payload");
  const model = readPlateModel(plateObjects);
  if (!model.identityPlacement) errors.push("datum plane placement is not the identity 3x4 matrix");
  if (model.reversed) errors.push("extrude is reversed; +Z rebuild would be wrong");
  if (model.operation !== "new_body" || model.targetBody !== null) errors.push(`extrude operation ${model.operation}`);
  if (model.distanceMm !== 10 || model.distanceSource !== "10") errors.push(`extrude distance ${model.distanceSource} / ${model.distanceMm}`);
  if (model.tipFeature !== model.extrudeId) errors.push("body tip is not the extrude feature");
  const curves = model.curves.filter((curve) => !curve.construction);
  const rebuilt = extrudeProfile(curves, model.distanceMm);
  const rebuiltInfo = inspect(rebuilt);
  rebuilt.delete();
  const rebuiltErrors = shapeErrors(rebuiltInfo, { solids: 1, volume: 24000, min: [0, 0, 0], max: [60, 40, 10] }, "fcad rebuild 10mm");
  if (!rebuiltInfo.analyticOnly) rebuiltErrors.push("fcad rebuild 10mm is not analytic");
  errors.push(...rebuiltErrors);

  const extrude = plateObjects.find((row) => row.kind === "feature.extrude");
  if (!extrude) throw new Error("no extrude");
  const patched = patchExtrudeDistance(extrude.payload, "15");
  const editedPath = join(OUT, "edited-plate.fcad");
  copyFileSync(platePath, editedPath);
  plateDb.close();
  const editedDb = new DatabaseSync(editedPath);
  const modifiedAt = new Date().toISOString();
  editedDb.prepare("update objects set payload = ?, payload_hash = ? where id = ?").run(patched, blake3(patched), extrude.id);
  editedDb.prepare("update meta set modified_at = ? where id = 1").run(modifiedAt);
  editedDb.close();

  const checkDb = new DatabaseSync(editedPath, { readOnly: true });
  const editedObjects = readObjects(checkDb);
  const editedModel = readPlateModel(editedObjects);
  const editedHashesOk = editedObjects.every((row) => hashMatches(row.payload, row.payload_hash));
  if (!editedHashesOk) errors.push("edited-plate payload_hash does not match BLAKE3");
  if (editedModel.distanceMm !== 15 || editedModel.distanceSource !== "15") errors.push(`edited distance ${editedModel.distanceSource}/${editedModel.distanceMm}`);
  if (pragmaNumber(checkDb, "application_id") !== FCAD_APPLICATION_ID) errors.push("edited application_id is not FCAD");
  if (pragmaNumber(checkDb, "user_version") !== 4) errors.push("edited user_version is not 4");
  const sameIds = plateObjects.every((row, index) => bytesEqual(row.id, editedObjects[index]!.id) && row.kind === editedObjects[index]!.kind);
  if (!sameIds) errors.push("edited object identities changed");
  const untouched = plateObjects.every((row) => {
    const next = editedObjects.find((item) => bytesEqual(item.id, row.id));
    if (!next) return false;
    if (row.kind === "feature.extrude") return true;
    return bytesEqual(row.payload, next.payload) && bytesEqual(row.payload_hash, next.payload_hash);
  });
  if (!untouched) errors.push("a non-extrude payload changed");
  const editedTopos = checkDb.prepare("select id, payload, payload_hash from topology_refs order by id").all() as Record<string, unknown>[];
  const originalTopos = topoRows
    .map((row) => ({ id: Buffer.from(blob(row.id, "id")).toString("hex"), payload: blob(row.payload, "payload"), hash: blob(row.payload_hash, "hash") }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const topoSame = editedTopos.length === originalTopos.length && editedTopos.every((row, index) => {
    const id = Buffer.from(blob(row.id, "id")).toString("hex");
    return id === originalTopos[index]!.id && bytesEqual(blob(row.payload, "payload"), originalTopos[index]!.payload) && bytesEqual(blob(row.payload_hash, "hash"), originalTopos[index]!.hash);
  });
  if (!topoSame) errors.push("topology references changed");
  const deps = checkDb.prepare("select dependent_id, dependency_id, role from deps").all();
  checkDb.close();
  const editedCurves = editedModel.curves.filter((curve) => !curve.construction);
  const editedBody = extrudeProfile(editedCurves, editedModel.distanceMm);
  const editedInfo = inspect(editedBody);
  editedBody.delete();
  const editedGeomErrors = shapeErrors(editedInfo, { solids: 1, volume: 36000, min: [0, 0, 0], max: [60, 40, 15] }, "fcad rebuild 15mm");
  if (!editedInfo.analyticOnly || !editedInfo.solidValid) editedGeomErrors.push("fcad rebuild 15mm is not a valid analytic solid");
  errors.push(...editedGeomErrors);

  const assemblyPath = join(FIX, "original-assembly.fcad");
  const assemblyDb = new DatabaseSync(assemblyPath, { readOnly: true });
  const source = assemblyDb.prepare("select id, format, bytes, content_hash, byte_len from imported_sources").get() as Record<string, unknown>;
  const sourceBytes = blob(source.bytes, "embedded step");
  const sourceHash = blob(source.content_hash, "content_hash");
  const assemblyObject = readObjects(assemblyDb)[0];
  assemblyDb.close();
  const external = new Uint8Array(readFileSync(join(FIX, "step/canonical/02-flat-assembly.step")));
  const embeddedEqual = bytesEqual(sourceBytes, external);
  if (!embeddedEqual) errors.push("embedded STEP bytes differ from 02-flat-assembly.step");
  if (!hashMatches(sourceBytes, sourceHash)) errors.push("imported_sources.content_hash is not BLAKE3-256 of the embedded STEP");
  if (Number(source.byte_len) !== sourceBytes.byteLength) errors.push("imported source byte_len disagrees with the blob");
  const embedded = await openStep(sourceBytes);
  const embeddedInfo = inspect(embedded.shape);
  const embeddedSolids = inspectSolids(embedded.shape);
  embedded.shape.delete();
  const assemblyExpect = EXPECTED[1]!;
  const embeddedErrors = [
    ...shapeErrors(embeddedInfo, assemblyExpect, "embedded assembly"),
    ...matchParts(embeddedSolids, assemblyExpect.parts).errors,
  ];
  errors.push(...embeddedErrors);
  const storedScene = assemblyObject ? decodeDocument(assemblyObject.payload) : null;
  errors.push(...storedColourErrors(storedScene));

  const report = {
    ok: errors.length === 0,
    errors,
    elapsedMs: Date.now() - started,
    kernel: {
      replicad: packageVersion("replicad"),
      "replicad-opencascadejs": packageVersion("replicad-opencascadejs"),
      blake3: packageVersion("@noble/hashes"),
      thread: "single",
      session: "Each STEP read constructs a new STEPControl_Reader. The browser proof uses a separate Worker for the reread.",
    },
    xde: {
      STEPCAFControl_Reader: xdeReader,
      STEPCAFControl_Writer: typeof oc.STEPCAFControl_Writer === "function",
      STEPControl_Reader: typeof oc.STEPControl_Reader === "function",
      limitation: xdeReader
        ? null
        : "replicad-opencascadejs 1.1.0 binds STEPControl_Reader and STEPCAFControl_Writer, but not STEPCAFControl_Reader or StepVisual_ColourRgb. Product names, instance colours and the assembly tree are not loaded into XCAFDoc. World-space solid volumes and bounding boxes are checked. Colour entities found in the STEP text are listed under headerText and are not treated as a passed colour check.",
    },
    units: {
      systemLengthUnit: 1,
      meaning: "STEPControl_Reader.SystemLengthUnit() is 1 and the inch plate is transferred as 50.8 × 25.4 × 12.7 mm (volume 16387.064 mm³), so inches were converted to millimetres.",
      fileUnits: "FileUnits() could not be called: constructing NCollection_Sequence_TCollection_AsciiString fails because NCollection_BaseSequence is unbound in this WASM build.",
    },
    tolerances: { volumeAbsMm3: VOLUME_TOL, bboxAbsMm: BBOX_TOL },
    hosting: {
      publishedUrlRetested: false,
      reason: "This command checks geometry in-process. A published URL was not available. Production MIME and the worker plate round trip are recorded separately by scripts/occt-browser-proof.mjs; a local preview is not proof of hosting.",
    },
    files,
    modification: {
      input: "fixtures/step/canonical/01-single-part.step",
      operation: "BRep fuse of a 60×40×5 mm box from z=10 to z=15. Not the original STEP bytes.",
      output: "artifacts/format-roundtrip/01-single-part-height-15.step",
      sha256: sha256(raisedStep),
      bytes: raisedStep.byteLength,
      bytesDiffer: !bytesEqual(plateBytes, raisedStep),
      written: raisedInfo,
      reread: rereadInfo,
      errors: raisedErrors,
    },
    fcad: {
      supported: "minimal: one Sketch/Extrude/Body plate. Not the full FerriteCAD format.",
      original: "fixtures/original-plate.fcad",
      edited: "artifacts/format-roundtrip/edited-plate.fcad",
      applicationId: FCAD_APPLICATION_ID,
      userVersion: 4,
      formatVersion: 1,
      payloadHash: "BLAKE3-256 of the payload blob, confirmed against every stored hash before the edit",
      plateHashes,
      topoHashes,
      model,
      editedModel,
      rebuild10: rebuiltInfo,
      rebuild15: editedInfo,
      identitiesPreserved: sameIds && untouched && topoSame,
      deps,
      modifiedAt,
      note: "The solid is rebuilt from the sketch curves and the extrude distance. There is no mesh table and none is read. content_version is not a stored column; it was not invented.",
    },
    assembly: {
      file: "fixtures/original-assembly.fcad",
      embeddedBytes: sourceBytes.byteLength,
      embeddedEquals02: embeddedEqual,
      contentHashOk: hashMatches(sourceBytes, sourceHash),
      format: source.format,
      geometry: embeddedInfo,
      solids: embeddedSolids,
      errors: embeddedErrors,
      storedScene,
      colours: "Compared with SEMANTIC-MANIFEST on the scene FerriteCAD stored in the .fcad payload. This WASM build did not re-derive colours: STEPCAFControl_Reader is absent.",
      note: "The STEP bytes were read from imported_sources. The external 02-flat-assembly.step file was used only to compare bytes, not to build the shape.",
    },
  };
  writeFileSync(join(OUT, "step-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, errors: report.errors, elapsedMs: report.elapsedMs, step: stepOut, fcad: editedPath }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

function storedColourErrors(scene: unknown): string[] {
  const errors: string[] = [];
  const payload = asMap(asMap(scene).payload);
  const instances = asMap(payload.scene).instances;
  if (!Array.isArray(instances)) return ["stored assembly scene has no instances"];
  const base = instances.find((item) => colourClose(asMap(item).colour, [0.603827, 0.033105, 0.033105]));
  const pin = instances.find((item) => colourClose(asMap(item).colour, [0.033105, 0.132868, 0.787412]));
  if (!base) errors.push("stored scene has no Base linear colour 0.603827, 0.033105, 0.033105");
  if (!pin) errors.push("stored scene has no Pin linear colour 0.033105, 0.132868, 0.787412");
  const pinPlace = Array.isArray(asMap(pin).placement) ? (asMap(pin).placement as number[]) : [];
  const basePlace = Array.isArray(asMap(base).placement) ? (asMap(base).placement as number[]) : [];
  if (basePlace[3] !== 0 || basePlace[7] !== 0 || basePlace[11] !== 0) errors.push(`stored Base translation ${basePlace[3]},${basePlace[7]},${basePlace[11]}`);
  if (pinPlace[3] !== 30 || pinPlace[7] !== 20 || pinPlace[11] !== 10) errors.push(`stored Pin translation ${pinPlace[3]},${pinPlace[7]},${pinPlace[11]}`);
  if (asMap(payload.scene).source_unit !== "millimetre") errors.push("stored scene unit is not millimetre");
  return errors;
}

function asMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function colourClose(value: unknown, expected: number[]): boolean {
  return Array.isArray(value) && expected.every((item, index) => Math.abs(Number(value[index]) - item) <= 1e-4);
}

function decodeDocument(payload: Uint8Array): unknown {
  const root = cborToValue(decodeCbor(payload)) as Record<string, unknown>;
  if (root.payload instanceof Uint8Array) root.payload = cborToValue(decodeCbor(root.payload));
  return jsonSafe(root);
}

function packageVersion(name: string): string {
  return JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")).version as string;
}

void main();
