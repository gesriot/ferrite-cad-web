import { cborToValue, decodeCbor, field, textOf, type CborNode } from "./cbor.ts";
import {
  constraintContractOf,
  decodeBody,
  decodeExtrude,
  decodePlane,
  decodeSketch,
  decodeTopology,
  extrudeContract,
  sketchContract,
  TOPOLOGY_CAPS,
} from "./fcad-decode.ts";
import { bytesEqual, isUuidV7, requireUuidV7, uuidOf } from "./fcad.ts";
import { decodeImportedPayload } from "./fcad-scene.ts";
import type { PortableScene } from "../xde/types";
import type { SqlDb } from "./sql.ts";

/**
 * Structural contract for FCAD schema 4 / format 1.
 * A thrown error means the file is invalid. `opaque` means a known file contains
 * data this build will not interpret, so it must not become editable.
 * This is not a list of fixture names and it does not recompute hashes.
 */

const FEATURES = new Set(["feature.extrude", "feature.revolve", "feature.fillet", "feature.chamfer"]);
const ROLES = new Set(["profile", "plane", "target_body", "predecessor", "body_tip", "parameter", "topology_reference"]);
const READABLE: Record<string, readonly number[]> = {
  parameter: [1],
  "datum.plane": [1],
  sketch: [1, 2, 3, 4, 5],
  body: [1],
  "feature.extrude": [1, 2, 3],
  "exchange.step.imported": [1, 2, 3],
  "feature.revolve": [1, 2, 3, 4],
  "feature.fillet": [1, 2],
  "feature.chamfer": [1],
};
const KNOWN_CAPS: Record<string, readonly string[]> = {
  parameter: ["core.part.v1"],
  "datum.plane": ["core.part.v1"],
  sketch: [
    "core.part.v1",
    "sketch.constraints.v1",
    "sketch.constraints.circle.v1",
    "sketch.constraints.angle.v1",
    "sketch.constraints.collinear.v1",
  ],
  body: ["core.part.v1"],
  "feature.extrude": ["core.part.v1", "feature.predecessor.v1", "feature.through-all.v1"],
  "exchange.step.imported": ["exchange.step.imported.v1"],
  "feature.revolve": ["core.part.v1", "feature.revolve.v1", "feature.revolve.axis-closed.v1", "feature.revolve.partial.v1"],
  "feature.fillet": ["core.part.v1", "feature.predecessor.v1", "feature.fillet.v1", "feature.fillet.sequential.v1"],
  "feature.chamfer": ["core.part.v1", "feature.predecessor.v1", "feature.chamfer.v1"],
};
export const MAX_OBJECTS = 20_000;
export const MAX_EDGES = 100_000;
export const MAX_TOPOLOGY = 100_000;

export type ValidatedObject = {
  id: Uint8Array;
  kind: string;
  schema: number;
  name: string | null;
  payload: Uint8Array;
  hash: Uint8Array;
  parent: Uint8Array | null;
};

type Edge = { dependent: string; dependency: string; role: string };
type Decoded = { opaque: boolean; previous: string | null; tip: string | null; confirmedImport?: ConfirmedImport | null };

/** A known imported STEP object whose payload, hash, length and source link were checked. */
export type ConfirmedImport = {
  objectId: string;
  objectName: string | null;
  sourceName: string | null;
  sourceId: string;
  format: string;
  bytes: Uint8Array;
  byteLen: number;
  hasStoredScene: boolean;
  /** Schema 3, or schema 2 keyed by definition. Null for schema 1, which has no definition keys. */
  scene: PortableScene | null;
};

export function validateStructure(db: SqlDb, objects: ValidatedObject[]): { opaque: boolean; imports: ConfirmedImport[] } {
  if (objects.length > MAX_OBJECTS) throw new Error(`document contains ${objects.length} objects, limit ${MAX_OBJECTS}`);
  const byId = new Map<string, ValidatedObject>();
  for (const row of objects) {
    const id = idOf(row.id, "object id");
    if (byId.has(id)) throw new Error(`object id ${id} is duplicated`);
    byId.set(id, row);
  }
  let opaque = false;
  const imports: ConfirmedImport[] = [];
  checkParents(objects, byId);
  const edges = readEdges(db, byId);
  if (edges.length > MAX_EDGES) throw new Error(`dependency graph exceeds ${MAX_EDGES}`);
  assertAcyclic(byId, edges);
  const decoded = new Map<string, Decoded>();
  for (const row of objects) {
    const id = uuidOf(row.id);
    const result = checkObject(db, row, byId, edges);
    if (result.opaque) opaque = true;
    if (result.confirmedImport) imports.push(result.confirmedImport);
    decoded.set(id, result);
  }
  checkHistory(decoded);
  if (checkTopology(db, byId, edges)) opaque = true;
  checkSources(db, byId);
  return { opaque, imports };
}

function checkParents(objects: ValidatedObject[], byId: Map<string, ValidatedObject>) {
  const parentOf = new Map<string, string | null>();
  for (const row of objects) {
    const id = uuidOf(row.id);
    if (!row.parent) {
      parentOf.set(id, null);
      continue;
    }
    const parent = idOf(row.parent, "parent_id");
    if (parent === id) throw new Error(`object.self-parent: object ${id} is its own parent`);
    if (!byId.has(parent)) throw new Error(`object.missing-parent: object ${id} names missing parent ${parent}`);
    parentOf.set(id, parent);
  }
  for (const row of objects) {
    const start = uuidOf(row.id);
    const seen = new Set<string>();
    let current: string | null = start;
    while (current) {
      if (seen.has(current)) {
        throw new Error(`object.parent-cycle: object hierarchy contains a parent cycle through ${current}`);
      }
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
  }
}

function readEdges(db: SqlDb, byId: Map<string, ValidatedObject>): Edge[] {
  const rows = db.all("SELECT dependent_id, dependency_id, role FROM deps");
  return rows.map((row) => {
    const role = text(row[2], "role");
    if (!ROLES.has(role)) throw new Error(`unknown dependency role ${JSON.stringify(role)}`);
    const dependent = idOf(blob(row[0], "dependent_id"), "dependent_id");
    const dependency = idOf(blob(row[1], "dependency_id"), "dependency_id");
    if (!byId.has(dependent) || !byId.has(dependency)) {
      throw new Error(`reference.missing-target: dependency ${role} points at a missing object`);
    }
    return { dependent, dependency, role };
  });
}

function assertAcyclic(byId: Map<string, ValidatedObject>, edges: Edge[]) {
  const indegree = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const id of byId.keys()) indegree.set(id, 0);
  for (const edge of edges) {
    const list = next.get(edge.dependency) ?? [];
    list.push(edge.dependent);
    next.set(edge.dependency, list);
    indegree.set(edge.dependent, (indegree.get(edge.dependent) ?? 0) + 1);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let seen = 0;
  for (let i = 0; i < queue.length; i++) {
    seen += 1;
    for (const dependent of next.get(queue[i]!) ?? []) {
      const degree = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, degree);
      if (degree === 0) queue.push(dependent);
    }
  }
  if (seen !== byId.size) throw new Error("graph.not-orderable: dependency graph contains a cycle");
}

function hasEdge(edges: Edge[], dependent: string, dependency: string, role: string) {
  return edges.some((edge) => edge.dependent === dependent && edge.dependency === dependency && edge.role === role);
}

function checkObject(db: SqlDb, row: ValidatedObject, byId: Map<string, ValidatedObject>, edges: Edge[]): Decoded {
  const id = uuidOf(row.id);
  const blank = { opaque: false, previous: null as string | null, tip: null as string | null, confirmedImport: null as ConfirmedImport | null };
  const readable = READABLE[row.kind];
  if (!readable) return { ...blank, opaque: true };
  if (!readable.includes(row.schema)) return { ...blank, opaque: true };
  let envelope;
  try {
    envelope = readEnvelope(row.payload, row.kind);
  } catch (error) {
    throw new Error(`${row.kind} ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (envelope.schema !== row.schema) {
    throw new Error(`${row.kind} ${id}: schema_version ${envelope.schema} does not match column ${row.schema}`);
  }
  const known = KNOWN_CAPS[row.kind] ?? [];
  if (envelope.caps.some((cap) => !known.includes(cap))) return { ...blank, opaque: true };
  if (row.kind === "exchange.step.imported") {
    // Unknown schema or required capabilities stay opaque. Their payload links are
    // not confirmed and must not be treated as a supported STEP source.
    // A known layout is decoded from CBOR tokens before any source is confirmed.
    // The payload is not collapsed to a text-keyed object: an ignored field may
    // hold a map whose keys are not strings.
    if (envelope.caps.length !== 1 || envelope.caps[0] !== "exchange.step.imported.v1") {
      throw new Error(`exchange.step.imported ${id}: capabilities do not match this layout`);
    }
    const decoded = decodeImportedPayload(envelope.innerNode, row.schema);
    const ref = db.get("SELECT source_id FROM imported_source_refs WHERE object_id = ?", [row.id]);
    if (!ref) throw new Error(`imported-source.unreachable: ${id} does not reference the source bytes`);
    const refBytes = blob(ref[0], "source_id");
    const sourceId = idOf(refBytes, "source_id");
    const sourceRow = db.get("SELECT content_hash, byte_len, format, bytes FROM imported_sources WHERE id = ?", [refBytes]);
    if (!sourceRow) throw new Error(`imported-source.unreachable: ${id} names missing source ${sourceId}`);
    if (!bytesEqual(decoded.source, refBytes)) {
      throw new Error(`imported-source.unreachable: ${id} payload source does not match imported source ${sourceId}`);
    }
    const rowHash = blob(sourceRow[0], "content_hash");
    if (!bytesEqual(decoded.sourceHash, rowHash)) {
      throw new Error(`imported source ${sourceId} does not match the hash named by ${id}`);
    }
    const rowLen = sourceRow[1];
    if (typeof rowLen !== "number" || decoded.sourceByteLen !== rowLen) {
      throw new Error(`imported source ${sourceId} length does not match the length named by ${id}`);
    }
    const format = text(sourceRow[2], "format");
    if (format !== "exchange.step") throw new Error(`embedded source format ${format} is not STEP`);
    const stored = blob(sourceRow[3], "bytes");
    if (stored.byteLength !== rowLen) throw new Error(`imported source ${sourceId} byte_len does not equal the stored bytes`);
    const bytes = new Uint8Array(stored.byteLength);
    bytes.set(stored);
    return {
      ...blank,
      opaque: true,
      confirmedImport: {
        objectId: id,
        objectName: row.name,
        sourceName: decoded.sourceName,
        sourceId,
        format,
        bytes,
        byteLen: rowLen,
        hasStoredScene: true,
        scene: decoded.scene,
      },
    };
  }
  const inner = asRecord(envelope.inner, row.kind);
  if (row.kind === "datum.plane") {
    decodePlane(inner);
    return blank;
  }
  if (row.kind === "sketch") return checkSketch(id, inner, envelope.schema, envelope.caps, byId, edges);
  if (row.kind === "feature.extrude") return checkExtrude(id, inner, envelope.schema, envelope.caps, byId, edges);
  if (row.kind === "feature.revolve") return checkRevolve(id, inner, byId, edges);
  if (row.kind === "feature.fillet" || row.kind === "feature.chamfer") return checkModifier(id, row.kind, inner, byId, edges);
  if (row.kind === "body") {
    decodeBody(inner);
    return checkBody(id, inner, byId, edges);
  }
  return blank;
}

function checkSketch(
  id: string,
  inner: Record<string, unknown>,
  schema: number,
  caps: string[],
  byId: Map<string, ValidatedObject>,
  edges: Edge[],
): Decoded {
  const decoded = decodeSketch(inner);
  sketchContract(schema, caps, constraintContractOf(inner));
  requireTarget(id, decoded.plane, "plane", "datum.plane", "sketch", byId, edges);
  const seen = new Set<string>();
  for (const curve of decoded.curves) {
    if (seen.has(curve.id)) throw new Error(`sketch ${id}: segment ${curve.id} is duplicated`);
    seen.add(curve.id);
  }
  return { opaque: false, previous: null, tip: null };
}

function checkExtrude(
  id: string,
  inner: Record<string, unknown>,
  schema: number,
  caps: string[],
  byId: Map<string, ValidatedObject>,
  edges: Edge[],
): Decoded {
  const decoded = decodeExtrude(inner);
  extrudeContract(schema, caps, decoded);
  requireTarget(id, decoded.profile, "profile", "sketch", "extrude", byId, edges);
  const previous = decoded.previous ? idOf(decoded.previous, "previous") : null;
  const target = decoded.target ? idOf(decoded.target, "target_body") : null;
  if (previous && target) throw new Error(`feature.two-inputs: feature ${id} names both a predecessor and a target body`);
  if (decoded.operation === "new_body" && previous) {
    throw new Error(`feature.unused-predecessor: feature ${id} starts a body and also names ${previous}`);
  }
  if (decoded.operation !== "new_body" && !previous) {
    throw new Error(`feature.missing-predecessor: feature ${id} names no earlier feature`);
  }
  if (previous) requireFeature(id, previous, "predecessor", byId, edges);
  if (target) requireTarget(id, decoded.target, "target_body", "body", "extrude", byId, edges);
  return { opaque: false, previous, tip: null };
}

function checkRevolve(id: string, inner: Record<string, unknown>, byId: Map<string, ValidatedObject>, edges: Edge[]): Decoded {
  requireTarget(id, inner.profile, "profile", "sketch", "revolve", byId, edges);
  return { opaque: false, previous: null, tip: null };
}

function checkModifier(id: string, kind: string, inner: Record<string, unknown>, byId: Map<string, ValidatedObject>, edges: Edge[]): Decoded {
  if (inner.previous == null) throw new Error(`feature.missing-predecessor: ${kind} ${id} names no earlier feature`);
  const previous = idOf(blob(inner.previous, "previous"), "previous");
  if (previous === id) throw new Error(`feature.self-predecessor: feature ${id} names itself`);
  requireFeature(id, previous, "predecessor", byId, edges);
  const edge = asRecord(inner.edge, "edge");
  if (edge.feature != null) idOf(blob(edge.feature, "edge.feature"), "edge.feature");
  return { opaque: false, previous, tip: null };
}

function checkBody(id: string, inner: Record<string, unknown>, byId: Map<string, ValidatedObject>, edges: Edge[]): Decoded {
  if (inner.tip_feature == null) return { opaque: false, previous: null, tip: null };
  const tip = idOf(blob(inner.tip_feature, "tip_feature"), "tip_feature");
  const found = byId.get(tip);
  if (!found) throw new Error(`reference.missing-target: body ${id} refers to missing tip feature ${tip}`);
  if (!FEATURES.has(found.kind)) throw new Error(`reference.wrong-kind: body ${id} expects ${tip} to be a feature, found ${found.kind}`);
  if (!hasEdge(edges, id, tip, "body_tip")) {
    throw new Error(`reference.missing-edge: body ${id} refers to tip feature ${tip} but no body_tip dependency records it`);
  }
  return { opaque: false, previous: null, tip };
}

function requireTarget(
  objectId: string,
  value: unknown,
  role: string,
  expectedKind: string,
  what: string,
  byId: Map<string, ValidatedObject>,
  edges: Edge[],
) {
  const target = idOf(blob(value, role), role);
  const found = byId.get(target);
  if (!found) throw new Error(`reference.missing-target: ${what} ${objectId} refers to missing object ${target}`);
  if (found.kind !== expectedKind) {
    throw new Error(`reference.wrong-kind: ${what} ${objectId} expects ${target} to be a ${expectedKind}, found ${found.kind}`);
  }
  if (!hasEdge(edges, objectId, target, role)) {
    throw new Error(`reference.missing-edge: ${what} ${objectId} refers to ${target} but no ${role} dependency records it`);
  }
}

function requireFeature(objectId: string, target: string, role: string, byId: Map<string, ValidatedObject>, edges: Edge[]) {
  const found = byId.get(target);
  if (!found) throw new Error(`reference.missing-target: feature ${objectId} modifies missing feature ${target}`);
  if (!FEATURES.has(found.kind)) throw new Error(`reference.wrong-kind: feature ${objectId} expects ${target} to be a feature, found ${found.kind}`);
  if (!hasEdge(edges, objectId, target, role)) {
    throw new Error(`reference.missing-edge: feature ${objectId} modifies ${target} but no ${role} dependency records it`);
  }
}

function checkHistory(decoded: Map<string, Decoded>) {
  const consumers = new Map<string, string[]>();
  const owners = new Map<string, string[]>();
  for (const [id, item] of decoded) {
    if (item.previous) {
      const list = consumers.get(item.previous) ?? [];
      list.push(id);
      consumers.set(item.previous, list);
    }
    if (item.tip) {
      const list = owners.get(item.tip) ?? [];
      list.push(id);
      owners.set(item.tip, list);
    }
  }
  for (const [feature, claimants] of consumers) {
    if (claimants.length > 1) throw new Error(`feature.forked-history: features ${claimants.join(", ")} all modify ${feature}`);
  }
  for (const [feature, bodies] of owners) {
    if (bodies.length > 1) throw new Error(`body.shared-tip: bodies ${bodies.join(", ")} all expose ${feature}`);
  }
}

function checkTopology(db: SqlDb, byId: Map<string, ValidatedObject>, edges: Edge[]): boolean {
  const rows = db.all("SELECT id, owner_id, producer_feature, expected_kind, payload FROM topology_refs");
  if (rows.length > MAX_TOPOLOGY) throw new Error(`topology_refs exceed ${MAX_TOPOLOGY}`);
  let opaque = false;
  for (const row of rows) {
    const id = idOf(blob(row[0], "topology id"), "topology id");
    const ownerBytes = blob(row[1], "owner_id");
    const producerBytes = blob(row[2], "producer_feature");
    if (!isUuidV7(ownerBytes)) {
      throw new Error(`ObjectId must be an RFC 4122 UUIDv7, found ${ownerBytes.byteLength === 16 ? uuidOf(ownerBytes) : `${ownerBytes.byteLength} bytes`}`);
    }
    const owner = uuidOf(ownerBytes);
    const producer = idOf(producerBytes, "producer_feature");
    if (!byId.has(owner)) throw new Error(`topology-ref.orphan-owner: topology reference ${id} is owned by ${owner}, which does not exist`);
    const producerRow = byId.get(producer);
    if (!producerRow) throw new Error(`topology-ref.missing-producer: topology reference ${id} names ${producer}, which does not exist`);
    if (!FEATURES.has(producerRow.kind)) {
      throw new Error(`topology-ref.producer-not-feature: topology reference ${id} names ${producer}, which is not a feature, as its producer`);
    }
    if (owner !== producer && !hasEdge(edges, owner, producer, "topology_reference")) {
      throw new Error(`topology-ref.missing-edge: topology reference ${id} is owned by ${owner} but has no topology_reference dependency on ${producer}`);
    }
    const kind = text(row[3], "expected_kind");
    if (kind !== "face" && kind !== "edge" && kind !== "vertex") throw new Error(`unknown entity kind ${JSON.stringify(kind)}`);
    if (checkTopologyPayload(blob(row[4], "topology payload"), kind) === "opaque") opaque = true;
  }
  return opaque;
}

function checkTopologyPayload(payload: Uint8Array, expectedKind: string): "ok" | "opaque" {
  const envelope = readEnvelope(payload, "topology_ref");
  if (envelope.schema !== 1) return "opaque";
  if (envelope.caps.some((cap) => !TOPOLOGY_CAPS.has(cap))) return "opaque";
  const decoded = decodeTopology(envelope.inner);
  if (decoded.entityKind && decoded.entityKind !== expectedKind) {
    throw new Error(`topology-ref.expected-kind: role does not match ${expectedKind}`);
  }
  if (decoded.outsideSlice) return "opaque";
  return "ok";
}

function checkSources(db: SqlDb, byId: Map<string, ValidatedObject>) {
  for (const row of db.all("SELECT id FROM imported_sources")) idOf(blob(row[0], "source id"), "source id");
  for (const row of db.all("SELECT object_id, source_id FROM imported_source_refs")) {
    const objectId = idOf(blob(row[0], "object_id"), "object_id");
    idOf(blob(row[1], "source_id"), "source_id");
    if (!byId.has(objectId)) throw new Error(`imported-source.unreachable: object reference ${objectId} does not find an object`);
  }
  for (const row of db.all("SELECT id FROM checkpoints")) idOf(blob(row[0], "checkpoint id"), "checkpoint id");
}

function readEnvelope(payload: Uint8Array, expected: string): { schema: number; caps: string[]; inner: unknown; innerNode: CborNode } {
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
  const innerNode = decodeCbor(raw.value);
  // Imported payloads are decoded from tokens. Collapsing first would require
  // every ignored value to be a map with text keys.
  const inner = expected === "exchange.step.imported" ? null : cborToValue(innerNode);
  return { schema: schemaNode.value, caps, inner, innerNode };
}

function idOf(bytes: Uint8Array, label: string): string {
  if (!isUuidV7(bytes)) {
    const shown = bytes.byteLength === 16 ? uuidOf(bytes) : `${bytes.byteLength} bytes`;
    throw new Error(`${label.includes("Object") ? "ObjectId" : "ObjectId"} must be an RFC 4122 UUIDv7, found ${shown}`);
  }
  return requireUuidV7(bytes, label);
}

function blob(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} is not a BLOB`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not text`);
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) throw new Error(`${label} is not a CBOR map`);
  return value as Record<string, unknown>;
}
