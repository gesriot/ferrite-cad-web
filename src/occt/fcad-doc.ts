import { openFcadBytes } from "./file-limits.ts";
export { MAX_FCAD_BYTES } from "./file-limits.ts";
import { blake3 } from "@noble/hashes/blake3";
import { cborToValue, decodeCbor, field, textOf } from "./cbor.ts";
import { blake3Hex, bytesEqual, hashMatches, isUuidV7, parseHeight, requireUuidV7, rewriteExtrudeDistance, uuidOf, type Point, type SketchCurve } from "./fcad.ts";
import { decodeBody, decodeExtrude, decodePlane, decodeSketch } from "./fcad-decode.ts";
import type { SqlDb } from "./sql.ts";
import { validateStructure, type ValidatedObject } from "./fcad-validate.ts";
import { HISTORICAL_BASIS, detectFamily, readCurrent, readCurrentImport } from "./fcad-current.ts";
import type { PortableScene } from "../xde/types";

/**
 * Supported FCAD slice: one identity XY plane, one closed line sketch without
 * constraints, one positive blind extrude (+Z, new body), one body.
 * Anything else is refused or opened read-only. This is not full FCAD.
 */

const CORE = "core.part.v1";
const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
];

export type PartModel = {
  documentId: string;
  planeId: string;
  planeName: string;
  sketchId: string;
  sketchName: string;
  curves: SketchCurve[];
  area: number;
  extrudeId: string;
  extrudeName: string;
  distanceSource: string;
  distanceMm: number;
  bodyId: string;
  bodyName: string;
};

/** Whole FCAD container limit. One parsed CBOR value is capped separately at 8 MiB in cbor.ts. */


export type FcadBasis = "current" | "historical";
export type FcadDocument =
  | { ok: false; status: "invalid"; error: string; basis?: FcadBasis }
  | { ok: true; status: "unsupported"; editable: false; reason: string; summary: string; basis?: FcadBasis }
  | { ok: true; status: "editable"; editable: true; model: PartModel; summary: string; basis?: FcadBasis };

/** Shown only after the shared reader has accepted the container. */
export type ImportedSourceMeta = {
  format: string;
  byteLen: number;
  blobBytes: number;
  contentHashHex: string;
  hashOk: true;
  objectName: string | null;
  sourceName: string | null;
  sourceByteLen: number;
  sourceId: string;
  payloadSourceId: string;
  refSourceId: string;
  sourceLinkOk: true;
  hasStoredScene: boolean;
};

type ObjectRow = ValidatedObject;

export function kernelCurves(curves: SketchCurve[]): { kind: string; start: Point; end: Point }[] {
  const issue = loopIssue(curves);
  if (issue) throw new Error(issue);
  const area = signedArea(curves);
  const lines = curves.map((curve) => ({ kind: "line" as const, start: curve.start, end: curve.end }));
  if (area < 0) return lines.reverse().map((curve) => ({ kind: "line", start: curve.end, end: curve.start }));
  return lines;
}

export function readFcad(db: SqlDb): FcadDocument {
  try {
    return readUnchecked(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a database/i.test(message)) return { ok: false, status: "invalid", error: "file is not a SQLite database" };
    return { ok: false, status: "invalid", error: message };
  }
}

/**
 * STEP bytes from one imported object whose known schema, capabilities, payload,
 * hash, length and source link were confirmed by the shared validator.
 * An unknown schema or required capability stays unsupported and yields no bytes.
 * Invalid containers throw the reader error. A known assembly may still be
 * unsupported for parametric editing. The stored scene is not geometry.
 */
export function readEmbeddedStep(db: SqlDb): { step: Uint8Array; meta: ImportedSourceMeta; scene: PortableScene | null } {
  if (detectFamily(db) === "current") return readCurrentImport(db);
  const opened = readFcad(db);
  if (!opened.ok) throw new Error(opened.error);
  if (!knownContainer(db)) {
    throw new Error(opened.status === "unsupported" ? opened.reason : "this document is not a known FCAD container");
  }
  const imports = confirmedImports(db);
  if (imports.length !== 1) {
    if (opened.status === "unsupported") throw new Error(opened.reason);
    throw new Error(imports.length === 0 ? "this document has no embedded STEP source" : `this document has ${imports.length} embedded STEP sources`);
  }
  const found = imports[0]!;
  const step = new Uint8Array(found.bytes.byteLength);
  step.set(found.bytes);
  return {
    step,
    meta: {
      format: found.format,
      byteLen: found.byteLen,
      blobBytes: step.byteLength,
      contentHashHex: blake3Hex(step),
      hashOk: true,
      objectName: found.objectName,
      sourceName: found.sourceName,
      sourceByteLen: found.byteLen,
      sourceId: found.sourceId,
      payloadSourceId: found.sourceId,
      refSourceId: found.sourceId,
      sourceLinkOk: true,
      hasStoredScene: found.hasStoredScene,
    },
    scene: found.scene,
  };
}

function knownContainer(db: SqlDb): boolean {
  if (numberCell(db.get("PRAGMA user_version"), 0, "user_version") !== 4) return false;
  const meta = db.get("SELECT format_version, minimum_reader_version FROM meta WHERE id = 1");
  if (!meta) return false;
  if (numberCell(meta, 0, "format_version") !== 1) return false;
  if (numberCell(meta, 1, "minimum_reader_version") > 1) return false;
  return true;
}

function confirmedImports(db: SqlDb) {
  const objects = db
    .all("SELECT id, kind, schema_version, name, payload, payload_hash, parent_id FROM objects ORDER BY ordinal, rowid")
    .map(objectRow);
  return validateStructure(db, objects).imports;
}

/** Rewrites only the extrude distance. Throws before any write when the edit is unsafe. */
export function saveHeight(bytes: Uint8Array, source: string, openDb: (bytes: Uint8Array) => SqlDb): Uint8Array {
  const parsed = parseHeight(source);
  if (!parsed.ok) throw new Error(parsed.error);
  openFcadBytes(bytes, () => undefined);
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const db = openDb(owned);
  try {
    const opened = readFcad(db);
    if (!opened.ok) throw new Error(opened.error);
    if (!opened.editable) throw new Error(opened.reason);
    const extrude = objectByKind(db, "feature.extrude");
    const before = snapshot(db);
    const nextPayload = rewriteExtrudeDistance(extrude.payload, parsed.source, parsed.value);
    const nextHash = blake3(nextPayload);
    db.exec("BEGIN");
    try {
      db.run("UPDATE objects SET payload = ?, payload_hash = ? WHERE id = ?", [nextPayload, nextHash, extrude.id]);
      db.run("UPDATE meta SET modified_at = ? WHERE id = 1", [new Date().toISOString()]);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the failed statement already rolled the transaction back */
      }
      throw error;
    }
    const after = snapshot(db);
    if (after.deps !== before.deps || after.topos !== before.topos || after.sources !== before.sources || after.checkpoints !== before.checkpoints) {
      throw new Error("the edit touched dependencies, topology, or attachments");
    }
    if (after.meta !== before.meta || after.capabilities !== before.capabilities) {
      throw new Error("the edit touched document metadata");
    }
    if (after.others !== before.others) throw new Error("the edit changed another payload");
    const written = readFcad(db);
    if (!written.ok || !written.editable) throw new Error("the document cannot be read after writing");
    if (written.model.distanceSource !== parsed.source || written.model.distanceMm !== parsed.value) {
      throw new Error("the written height does not match the request");
    }
    if (written.model.extrudeId !== opened.model.extrudeId || written.model.sketchId !== opened.model.sketchId) {
      throw new Error("object UUIDs changed");
    }
    const exported = db.export();
    const check = openDb(exported);
    try {
      const again = readFcad(check);
      if (!again.ok || !again.editable) throw new Error("the SQLite export does not open");
      if (again.model.distanceMm !== parsed.value || again.model.distanceSource !== parsed.source) {
        throw new Error("the height in the export does not match");
      }
      const integrity = textCell(check.get("PRAGMA integrity_check"), 0, "integrity");
      if (integrity !== "ok") throw new Error(`integrity_check ${integrity}`);
    } finally {
      check.close();
    }
    return exported;
  } finally {
    db.close();
  }
}

function readUnchecked(db: SqlDb): FcadDocument {
  const integrity = textCell(db.get("PRAGMA integrity_check"), 0, "integrity_check");
  if (integrity !== "ok") return { ok: false, status: "invalid", error: `SQLite integrity_check: ${integrity}` };
  const applicationId = numberCell(db.get("PRAGMA application_id"), 0, "application_id");
  if (applicationId !== 0x46434144) return { ok: false, status: "invalid", error: "this is not an FCAD document (application_id)" };
  const family = detectFamily(db);
  if (family === "current") return readCurrent(db);
  const userVersion = numberCell(db.get("PRAGMA user_version"), 0, "user_version");
  if (family !== "historical" || userVersion !== 4) {
    return { ok: true, status: "unsupported", editable: false, reason: `SQLite schema ${userVersion} is unknown to this build`, summary: "unknown schema" };
  }
  const broken = db.all("PRAGMA foreign_key_check");
  if (broken.length > 0) {
    if (db.get("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'topology_refs'")) for (const row of db.all("SELECT owner_id, producer_feature, id FROM topology_refs")) {
      for (const value of [row[0], row[1], row[2]]) {
        if (value instanceof Uint8Array && !isUuidV7(value)) {
          const shown = value.byteLength === 16 ? uuidOf(value) : `${value.byteLength} bytes`;
          return { ok: false, status: "invalid", error: `ObjectId must be an RFC 4122 UUIDv7, found ${shown}` };
        }
      }
    }
    return { ok: false, status: "invalid", error: "SQLite foreign_key_check found broken references" };
  }
  const meta = db.get(
    "SELECT format_version, minimum_reader_version, document_id, display_length_unit, display_angle_unit, created_at, generator FROM meta WHERE id = 1",
  );
  if (!meta) return { ok: false, status: "invalid", error: "meta has no document row" };
  const formatVersion = numberCell(meta, 0, "format_version");
  const readerVersion = numberCell(meta, 1, "minimum_reader_version");
  if (formatVersion !== 1) {
    return { ok: true, status: "unsupported", editable: false, reason: `format_version ${formatVersion} is unknown to this build`, summary: "unknown version" };
  }
  if (readerVersion > 1) {
    return { ok: true, status: "unsupported", editable: false, reason: `document requires reader version ${readerVersion}`, summary: "version is too new" };
  }
  const documentId = requireUuidV7(asBlob(meta[2], "document_id"), "document_id");
  verifyHashes(db);
  const objects = db
    .all("SELECT id, kind, schema_version, name, payload, payload_hash, parent_id FROM objects ORDER BY ordinal, rowid")
    .map(objectRow);
  const summary = objects.map((row) => row.kind).join(", ") || "empty";
  const structure = validateStructure(db, objects);
  if (structure.opaque) {
    return {
      ok: true,
      status: "unsupported",
      editable: false,
      reason: "document contains data this build stores without decoding",
      summary,
      basis: "historical",
    };
  }
  const reason = supportIssue(db, objects);
  if (reason) return { ok: true, status: "unsupported", editable: false, reason, summary, basis: "historical" };
  const model = partModel(documentId, objects);
  return { ok: true, status: "editable", editable: true, model, summary: `${summary} (${HISTORICAL_BASIS})`, basis: "historical" };
}

function verifyHashes(db: SqlDb) {
  for (const row of db.all("SELECT id, payload, payload_hash FROM objects")) {
    const payload = asBlob(row[1], "payload");
    const hash = asBlob(row[2], "payload_hash");
    if (!hashMatches(payload, hash)) throw new Error(`BLAKE3 payload hash does not match for ${uuidOf(asBlob(row[0], "id"))}`);
  }
  if (db.get("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'topology_refs'")) for (const row of db.all("SELECT id, payload, payload_hash FROM topology_refs")) {
    const hash = row[2];
    if (hash == null) continue;
    if (!hashMatches(asBlob(row[1], "topology payload"), asBlob(hash, "topology hash"))) {
      throw new Error(`BLAKE3 topology hash does not match for ${uuidOf(asBlob(row[0], "topology id"))}`);
    }
  }
  for (const row of db.all("SELECT id, bytes, content_hash, byte_len FROM imported_sources")) {
    const bytes = asBlob(row[1], "imported bytes");
    if (!hashMatches(bytes, asBlob(row[2], "content_hash"))) throw new Error("BLAKE3 imported_sources hash does not match");
    if (numberCell(row, 3, "byte_len") !== bytes.byteLength) throw new Error("imported_sources byte_len does not equal the length");
  }
  for (const row of db.all("SELECT id, image, image_hash FROM checkpoints")) {
    if (!hashMatches(asBlob(row[1], "checkpoint"), asBlob(row[2], "checkpoint hash"))) {
      throw new Error("BLAKE3 checkpoint hash does not match");
    }
  }
  for (const row of db.all("SELECT dependent_id, dependency_id, role FROM deps")) {
    const dependent = asBlob(row[0], "dependent_id");
    const dependency = asBlob(row[1], "dependency_id");
    if (!db.get("SELECT 1 FROM objects WHERE id = ?", [dependent])) throw new Error(`no object for dependency ${textCell(row, 2, "role")}`);
    if (!db.get("SELECT 1 FROM objects WHERE id = ?", [dependency])) throw new Error(`no target for dependency ${textCell(row, 2, "role")}`);
  }
}

function supportIssue(db: SqlDb, objects: ObjectRow[]): string | null {
  const required = db
    .all("SELECT name FROM capabilities WHERE required = 1 ORDER BY name")
    .map((row) => textCell(row, 0, "capability"));
  if (required.length !== 1 || required[0] !== CORE) {
    return `editing needs only capability ${CORE}; file has: ${required.join(", ") || "none"}`;
  }
  const counts = new Map<string, number>();
  for (const row of objects) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  const expected = ["datum.plane", "sketch", "feature.extrude", "body"];
  const kinds = [...counts.keys()];
  if (kinds.length !== 4 || expected.some((kind) => counts.get(kind) !== 1)) {
    return `this slice supports one plane, one sketch, one extrude, and one body; file has: ${kinds.join(", ") || "empty"}`;
  }
  for (const row of objects) {
    if (row.schema !== 1) return `${row.kind} is stored at schema ${row.schema}; editing is supported only for 1`;
    const envelope = envelopeOf(row.payload, row.kind);
    if (envelope.schema !== 1) return `${row.kind}: envelope schema ${envelope.schema}`;
    if (envelope.caps.some((cap) => cap !== CORE)) return `${row.kind} requires ${envelope.caps.join(", ")}`;
  }
  const plane = objects.find((row) => row.kind === "datum.plane")!;
  const sketch = objects.find((row) => row.kind === "sketch")!;
  const extrude = objects.find((row) => row.kind === "feature.extrude")!;
  const body = objects.find((row) => row.kind === "body")!;
  const planeDecoded = decodePlane(envelopeOf(plane.payload, plane.kind).inner);
  if (JSON.stringify(planeDecoded.rows) !== JSON.stringify(IDENTITY)) return "plane is not identity XY";
  const sketchDecoded = decodeSketch(envelopeOf(sketch.payload, sketch.kind).inner);
  if (!bytesEqual(sketchDecoded.plane, plane.id)) return "sketch does not lie on this plane";
  if (sketchDecoded.constraints > 0) return "the sketch has constraints; this slice does not edit them";
  const loop = loopIssue(sketchDecoded.curves);
  if (loop) return loop;
  const extrudeDecoded = decodeExtrude(envelopeOf(extrude.payload, extrude.kind).inner);
  if (extrudeDecoded.previous) return "extrude references a previous feature";
  if (extrudeDecoded.reversed) return "extrude is reversed; only +Z is supported";
  if (extrudeDecoded.operation !== "new_body") return `operation ${extrudeDecoded.operation} is not New Body`;
  if (extrudeDecoded.target) return "extrude names a target body";
  if (!bytesEqual(extrudeDecoded.profile, sketch.id)) return "extrude profile is not this sketch";
  if (extrudeDecoded.endKind !== "blind") return `end condition ${extrudeDecoded.endKind} is not Blind`;
  const parsed = parseHeight(extrudeDecoded.distanceSource ?? "");
  if (!parsed.ok) return "height is an expression; this slice edits only a constant";
  if (parsed.value !== extrudeDecoded.distanceValue) throw new Error("source constant does not match the stored value");
  const bodyDecoded = decodeBody(envelopeOf(body.payload, body.kind).inner);
  if (!bodyDecoded.tip || !bytesEqual(bodyDecoded.tip, extrude.id)) return "body does not reference this extrude";
  const deps = db.all("SELECT dependent_id, dependency_id, role FROM deps");
  if (deps.length !== 3) return `this slice has no room for extra dependencies; file has ${deps.length}`;
  const roles = new Map(deps.map((row) => [textCell(row, 2, "role"), row]));
  const planeDep = roles.get("plane");
  const profileDep = roles.get("profile");
  const tipDep = roles.get("body_tip");
  if (!planeDep || !profileDep || !tipDep) return "missing a plane, profile, or body_tip dependency";
  if (!bytesEqual(asBlob(planeDep[0], "dep"), sketch.id) || !bytesEqual(asBlob(planeDep[1], "dep"), plane.id)) {
    return "plane dependency does not link the sketch and the plane";
  }
  if (!bytesEqual(asBlob(profileDep[0], "dep"), extrude.id) || !bytesEqual(asBlob(profileDep[1], "dep"), sketch.id)) {
    return "profile dependency does not link the extrude and the sketch";
  }
  if (!bytesEqual(asBlob(tipDep[0], "dep"), body.id) || !bytesEqual(asBlob(tipDep[1], "dep"), extrude.id)) {
    return "body_tip dependency does not link the body and the extrude";
  }
  return null;
}

function partModel(documentId: string, objects: ObjectRow[]): PartModel {
  const plane = objects.find((row) => row.kind === "datum.plane")!;
  const sketch = objects.find((row) => row.kind === "sketch")!;
  const extrude = objects.find((row) => row.kind === "feature.extrude")!;
  const body = objects.find((row) => row.kind === "body")!;
  const sketchDecoded = decodeSketch(envelopeOf(sketch.payload, sketch.kind).inner);
  const curves = sketchDecoded.curves;
  const extrudeDecoded = decodeExtrude(envelopeOf(extrude.payload, extrude.kind).inner);
  return {
    documentId,
    planeId: uuidOf(plane.id),
    planeName: plane.name ?? "XY",
    sketchId: uuidOf(sketch.id),
    sketchName: sketch.name ?? "Sketch",
    curves,
    area: signedArea(curves),
    extrudeId: uuidOf(extrude.id),
    extrudeName: extrude.name ?? "Extrude",
    distanceSource: extrudeDecoded.distanceSource ?? "",
    distanceMm: extrudeDecoded.distanceValue ?? Number.NaN,
    bodyId: uuidOf(body.id),
    bodyName: body.name ?? "Body",
  };
}

function objectByKind(db: SqlDb, kind: string): ObjectRow {
  const rows = detectFamily(db) === "current"
    ? db.all("SELECT id, kind, 0, name, payload, payload_hash, parent_id FROM objects WHERE kind = ?", [kind]).map(objectRow)
    : db.all("SELECT id, kind, schema_version, name, payload, payload_hash, parent_id FROM objects WHERE kind = ?", [kind]).map(objectRow);
  if (rows.length !== 1) throw new Error(`object ${kind} is not unique`);
  return rows[0]!;
}

function snapshot(db: SqlDb): { deps: string; topos: string; sources: string; checkpoints: string; meta: string; capabilities: string; others: string } {
  const deps = db
    .all("SELECT hex(dependent_id), hex(dependency_id), role FROM deps ORDER BY role, 1, 2")
    .map((row) => row.join("|"))
    .join("\n");
  const hasTopo = Boolean(db.get("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'topology_refs'"));
  const topos = hasTopo
    ? db
        .all("SELECT hex(id), hex(owner_id), hex(producer_feature), expected_kind, hex(payload), hex(payload_hash) FROM topology_refs ORDER BY 1")
        .map((row) => row.join("|"))
        .join("\n")
    : "";
  const sources = db
    .all("SELECT hex(id), format, hex(content_hash), byte_len FROM imported_sources ORDER BY 1")
    .map((row) => row.join("|"))
    .join("\n");
  const checkpoints = db
    .all("SELECT hex(id), name, hex(model), byte_len, hex(image_hash) FROM checkpoints ORDER BY 1")
    .map((row) => row.join("|"))
    .join("\n");
  const meta = detectFamily(db) === "current"
    ? db.all("SELECT hex(document_id), display_length_unit, display_angle_unit, created_at, generator FROM meta").map((row) => row.join("|")).join("\n")
    : db.all("SELECT format_version, minimum_reader_version, hex(document_id), display_length_unit, display_angle_unit, created_at, generator FROM meta").map((row) => row.join("|")).join("\n");
  const capabilities = hasTable(db, "capabilities")
    ? db.all("SELECT name, required FROM capabilities ORDER BY name").map((row) => row.join("|")).join("\n")
    : "";
  const others = db
    .all("SELECT hex(id), hex(payload), hex(payload_hash) FROM objects WHERE kind != 'feature.extrude' ORDER BY 1")
    .map((row) => row.join("|"))
    .join("\n");
  return { deps, topos, sources, checkpoints, meta, capabilities, others };
}

function objectRow(row: unknown[]): ObjectRow {
  return {
    id: asBlob(row[0], "id"),
    kind: textCell(row, 1, "kind"),
    schema: numberCell(row, 2, "schema_version"),
    name: row[3] == null ? null : textCell(row, 3, "name"),
    payload: asBlob(row[4], "payload"),
    hash: asBlob(row[5], "payload_hash"),
    parent: row[6] == null ? null : asBlob(row[6], "parent_id"),
  };
}

function envelopeOf(payload: Uint8Array, expected: string): { schema: number; caps: string[]; inner: unknown } {
  const root = decodeCbor(payload);
  const type = textOf(field(root, "type"), "type");
  if (type !== expected) throw new Error(`type ${type} instead of ${expected}`);
  const schemaNode = field(root, "schema_version");
  if (schemaNode.type !== "uint" || typeof schemaNode.value !== "number") throw new Error("schema_version is not an integer");
  const capsNode = field(root, "required_capabilities");
  if (capsNode.type !== "array") throw new Error("required_capabilities is not an array");
  const caps = capsNode.items.map((item) => textOf(item, "capability"));
  const raw = field(root, "payload");
  if (raw.type !== "bytes") throw new Error("inner payload is not a CBOR byte string");
  return { schema: schemaNode.value, caps, inner: cborToValue(decodeCbor(raw.value)) };
}

export function loopIssue(curves: SketchCurve[]): string | null {
  if (curves.length < 3) return "contour is shorter than three line segments";
  if (curves.some((curve) => curve.construction)) return "contour contains construction geometry";
  if (curves.some((curve) => curve.kind !== "line")) return "contour is not only line segments";
  if (curves.some((curve) => !Number.isFinite(curve.start[0]) || !Number.isFinite(curve.start[1]) || !Number.isFinite(curve.end[0]) || !Number.isFinite(curve.end[1]))) {
    return "a line segment has no finite coordinates";
  }
  const same = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6;
  const ids = new Set<string>();
  for (let i = 0; i < curves.length; i++) {
    const curve = curves[i]!;
    if (ids.has(curve.id)) return "a segment repeats in the contour";
    ids.add(curve.id);
    const next = curves[(i + 1) % curves.length]!;
    if (!same(curve.end, next.start)) return "contour is not closed";
    if (same(curve.start, curve.end)) return "contour has a degenerate line segment";
  }
  if (!(Math.abs(signedArea(curves)) > 1e-6)) return "contour is degenerate";
  if (!simpleLoop(curves)) return "contour is not simple: line segments intersect";
  return null;
}

function simpleLoop(curves: SketchCurve[]): boolean {
  const n = curves.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      if (segmentsCross(curves[i]!.start, curves[i]!.end, curves[j]!.start, curves[j]!.end)) return false;
    }
  }
  return true;
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const ab = cross(a, b, c) * cross(a, b, d);
  const cd = cross(c, d, a) * cross(c, d, b);
  return ab < 0 && cd < 0;
}

function signedArea(curves: SketchCurve[]): number {
  let area = 0;
  for (const curve of curves) area += curve.start[0] * curve.end[1] - curve.end[0] * curve.start[1];
  return area / 2;
}

function asBlob(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} is not a BLOB`);
  return value;
}

function textCell(row: unknown[] | undefined, index: number, label: string): string {
  const value = row?.[index];
  if (typeof value !== "string") throw new Error(`${label} is not text`);
  return value;
}

function numberCell(row: unknown[] | undefined, index: number, label: string): number {
  const value = row?.[index];
  if (typeof value !== "number") throw new Error(`${label} is not a number`);
  return value;
}


function hasTable(db: SqlDb, table: string): boolean {
  return Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]));
}
