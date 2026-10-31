/**
 * Reader for the current native FCAD layout (main 2f8b2599).
 *
 * user_version 0 is SQLite's default, not a schema version. Recognition is the
 * table shape: no format_version, no capabilities, no objects.schema_version,
 * envelope is type + nested payload. This is not a migration of historical files.
 *
 * Container, payload, link and semantic checks live in one path. Family
 * detection only chooses the decoder. Extraction and the plate editor both
 * call it; neither can skip application_id, metadata, integrity, hashes or
 * the understood reference contract.
 */
import { blake3 } from "@noble/hashes/blake3";
import { cborToValue, decodeCbor, field, textOf } from "./cbor.ts";
import { decodeBody } from "./fcad-decode.ts";
import { decodeImportedPayload, type DecodedImport } from "./fcad-scene.ts";
import { blake3Hex, bytesEqual, hashMatches, isUuidV7, requireUuidV7, uuidOf, type SketchCurve } from "./fcad.ts";
import { loopIssue, type FcadDocument, type ImportedSourceMeta, type PartModel } from "./fcad-doc.ts";
import type { SqlDb } from "./sql.ts";
import type { PortableScene } from "../xde/types";

export const CURRENT_BASIS = "current native main 2f8b25993e1ebba426dd2bb14cc40af20106d92b";
export const HISTORICAL_BASIS = "historical base 56b3c61ee3fa0c49534a48de090544cefc93ce83; not the current native format";

const IDENTITY = JSON.stringify([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]);
const FCAD_APPLICATION_ID = 0x46434144;
const EXTRUDE_FIELDS = new Set(["profile", "end_condition", "reversed", "operation", "previous", "regions"]);
const FIXED_PLANE_FIELDS = new Set(["kind", "placement"]);
const OFFSET_PLANE_FIELDS = new Set(["kind", "from", "distance_mm"]);
const FACE_PLANE_FIELDS = new Set(["kind", "result", "face", "offset_mm"]);
const KNOWN_KINDS = new Set(["parameter", "datum.plane", "sketch", "body", "feature.extrude", "feature.revolve", "feature.fillet", "feature.chamfer", "feature.keep_solids", "exchange.step.imported"]);
const DIMENSIONS = new Set(["length", "angle", "scalar"]);
const REVOLVE_AXES = new Set(["sketch_x", "sketch_y"]);
const REVOLVE_EXTENTS = new Set(["full_turn"]);
const OPERATIONS = new Set(["new_body", "add", "cut", "intersect"]);
const ENTITY_KINDS = new Set([0, 1, 2]); // face, edge, vertex
const SELECTIONS = new Set([0, 1]); // one, all_descendants

type Expression = { source: string; value: number };
type EntityRef = { id: Uint8Array; producer: Uint8Array; kind: number; digest: Uint8Array; selection: number };
type DecodedPayload =
  | { kind: "datum.plane"; variant: "fixed"; placement: number[][] }
  | { kind: "datum.plane"; variant: "offset"; from: Uint8Array; distance: Expression }
  | { kind: "datum.plane"; variant: "face"; result: Uint8Array; face: EntityRef; offset: Expression }
  | { kind: "parameter"; name: string; dimension: string; expression: Expression }
  | { kind: "feature.revolve"; profile: Uint8Array; regions: Uint8Array[]; axis: { kind: "sketch_x" } | { kind: "sketch_y" } | { kind: "line"; id: Uint8Array }; extent: { kind: "full_turn" } | { kind: "partial"; angle: Expression }; operation: string; previous: Uint8Array | null }
  | { kind: "feature.fillet"; previous: Uint8Array; edges: EntityRef[]; radius: Expression }
  | { kind: "feature.chamfer"; previous: Uint8Array; edges: EntityRef[]; distance: Expression }
  | { kind: "feature.keep_solids"; previous: Uint8Array; selection: { kind: string; faces?: EntityRef[] } }
  | ({ kind: "sketch" } & DecodedCurrentSketch)
  | { kind: "feature.extrude"; profile: Uint8Array; regions: Uint8Array[]; end: { kind: "blind" | "symmetric"; distance: Expression } | { kind: "through_all" } | { kind: "up_to_face"; result: Uint8Array; face: EntityRef; offset: Expression } | { kind: "up_to_vertex"; result: Uint8Array; vertex: EntityRef }; reversed: boolean; operation: string; previous: Uint8Array | null }
  | { kind: "body"; tip: Uint8Array | null }
  | { kind: "exchange.step.imported"; imported: DecodedImport };

function currentUuid(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || !isUuidV7(value)) throw new CurrentInvalid(`${label} must be an RFC 4122 UUIDv7`);
  return value;
}

function validateEdges(edges: EntityRef[], label: string) {
  if (!edges.length) throw new CurrentInvalid(`${label} must be non-empty`);
  const meanings = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 1) throw new CurrentInvalid(`${label} must name an edge`);
    const key = JSON.stringify([Array.from(edge.producer), edge.kind, Array.from(edge.digest), edge.selection]);
    if (meanings.has(key)) throw new CurrentInvalid(`${label} repeats an edge meaning`);
    meanings.add(key);
  }
}

function decodeTransform(value: unknown, label: string): number[][] {
  const rec = asRecord(value, label);
  const rows = asArray(rec.rows, `${label}.rows`);
  if (rows.length !== 3) throw new CurrentInvalid(`${label}.rows: expected length 3, found ${rows.length}`);
  const out: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const row = asArray(rows[i], `${label}.rows[${i}]`);
    if (row.length !== 4) throw new CurrentInvalid(`${label}.rows[${i}]: expected length 4, found ${row.length}`);
    const nums: number[] = [];
    for (let j = 0; j < 4; j++) {
      if (typeof row[j] !== "number" || !Number.isFinite(row[j])) throw new CurrentInvalid(`${label}.rows[${i}][${j}] must be finite`);
      nums.push(row[j] as number);
    }
    out.push(nums);
  }
  return out;
}

function decodeExpression(value: unknown, label: string): { source: string; value: number } {
  const rec = asRecord(value, label);
  if (typeof rec.source !== "string") throw new CurrentInvalid(`${label}.source: expected string`);
  if (typeof rec.value !== "number" || !Number.isFinite(rec.value)) throw new CurrentInvalid(`${label}.value must be finite`);
  return { source: rec.source, value: rec.value };
}

function decodeEntityReference(value: unknown, label: string, rawNode: import("./cbor.ts").CborNode): EntityRef {
  const rec = asRecord(value, label);
  const REF_FIELDS = new Set(["id", "meaning"]);
  for (const key of Object.keys(rec)) if (!REF_FIELDS.has(key)) throw new CurrentInvalid(`unknown field ${key} on ${label}`);
  if (!(rec.id instanceof Uint8Array) || !isUuidV7(rec.id)) throw new CurrentInvalid(`${label}.id must be an RFC 4122 UUIDv7`);
  if (!("meaning" in rec)) throw new CurrentInvalid(`${label} requires meaning`);
  if (!Array.isArray(rec.meaning) || rec.meaning.length !== 4) throw new CurrentInvalid(`${label}.meaning: expected 4-element tuple`);
  const [producer, kind, digest, selection] = rec.meaning;
  if (!(producer instanceof Uint8Array) || !isUuidV7(producer)) throw new CurrentInvalid(`${label}.meaning[0] must be an RFC 4122 UUIDv7`);
  // Raw CBOR token is required: float 0 is not uint 0.
  if (rawNode.type !== "map") throw new CurrentInvalid(`${label}: expected map`);
  const meaningEntry = rawNode.entries.find(e => e.key.type === "text" && e.key.value === "meaning");
  if (!meaningEntry || meaningEntry.value.type !== "array" || meaningEntry.value.items.length < 4) {
    throw new CurrentInvalid(`${label}.meaning: expected array of 4`);
  }
  const kindNode = meaningEntry.value.items[1];
  const selNode = meaningEntry.value.items[3];
  if (!kindNode || kindNode.type !== "uint") throw new CurrentInvalid(`${label}.meaning[1]: expected uint, found ${kindNode?.type ?? "missing"}`);
  if (!selNode || selNode.type !== "uint") throw new CurrentInvalid(`${label}.meaning[3]: expected uint, found ${selNode?.type ?? "missing"}`);
  if (typeof kind !== "number" || !Number.isInteger(kind) || !ENTITY_KINDS.has(kind)) throw new CurrentInvalid(`${label}.meaning[1]: unknown entity kind`);
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) throw new CurrentInvalid(`${label}.meaning[2]: expected 32-byte digest`);
  if (typeof selection !== "number" || !Number.isInteger(selection) || !SELECTIONS.has(selection)) throw new CurrentInvalid(`${label}.meaning[3]: unknown selection`);
  return { id: rec.id, producer, kind, digest, selection };
}


function decodeCurrentPlane(inner: Record<string, unknown>, raw: import("./cbor.ts").CborNode): DecodedPayload {
  if (typeof inner.kind !== "string") throw new CurrentInvalid("datum.plane.kind: expected string");
  if (inner.kind === "fixed") {
    for (const key of Object.keys(inner)) if (!FIXED_PLANE_FIELDS.has(key)) throw new CurrentInvalid(`unknown field ${key} on datum.plane fixed`);
    return { kind: "datum.plane", variant: "fixed", placement: decodeTransform(inner.placement, "placement") };
  }
  if (inner.kind === "offset") {
    for (const key of Object.keys(inner)) if (!OFFSET_PLANE_FIELDS.has(key)) throw new CurrentInvalid(`unknown field ${key} on datum.plane offset`);
    if (!(inner.from instanceof Uint8Array) || !isUuidV7(inner.from)) throw new CurrentInvalid("offset.from must be an RFC 4122 UUIDv7");
    return { kind: "datum.plane", variant: "offset", from: inner.from, distance: decodeExpression(inner.distance_mm, "distance_mm") };
  }
  if (inner.kind === "face") {
    for (const key of Object.keys(inner)) if (!FACE_PLANE_FIELDS.has(key)) throw new CurrentInvalid(`unknown field ${key} on datum.plane face`);
    if (!(inner.result instanceof Uint8Array) || !isUuidV7(inner.result)) throw new CurrentInvalid("face.result must be an RFC 4122 UUIDv7");
    const faceNode = raw.type === "map" ? raw.entries.find(e => e.key.type === "text" && e.key.value === "face")?.value : undefined;
    if (!faceNode) throw new CurrentInvalid("face: missing raw node");
    return { kind: "datum.plane", variant: "face", result: inner.result, face: decodeEntityReference(inner.face, "face", faceNode!), offset: decodeExpression(inner.offset_mm, "offset_mm") };
  }
  throw new CurrentInvalid(`unknown datum.plane kind ${JSON.stringify(inner.kind)}`);
}

function decodeKnownPayload(obj: ObjectRow): DecodedPayload {
  const raw = payloadNode(obj);
  const inner = asRecord(cborToValue(raw), obj.kind);
  if (obj.kind === "datum.plane") return decodeCurrentPlane(inner, raw);
  if (obj.kind === "parameter") {
    if (typeof inner.name !== "string") throw new CurrentInvalid("parameter.name: expected string");
    if (typeof inner.dimension !== "string" || !DIMENSIONS.has(inner.dimension)) throw new CurrentInvalid("parameter.dimension: expected length|angle|scalar");
    return { kind: "parameter", name: inner.name, dimension: inner.dimension, expression: decodeExpression(inner.expression, "expression") };
  }
  if (obj.kind === "feature.revolve") {
    const REVOLVE_FIELDS = new Set(["profile", "regions", "axis", "extent", "operation", "previous"]);
    for (const key of Object.keys(inner)) if (!REVOLVE_FIELDS.has(key)) throw new CurrentInvalid(`unknown field ${key} on feature.revolve`);
    if (!Array.isArray(inner.regions)) throw new CurrentInvalid("revolve.regions: expected array");
    for (const item of inner.regions) if (!(item instanceof Uint8Array) || !isUuidV7(item)) throw new CurrentInvalid("revolve.regions item must be an RFC 4122 UUIDv7");
    if (!(inner.profile instanceof Uint8Array) || !isUuidV7(inner.profile)) throw new CurrentInvalid("revolve.profile must be an RFC 4122 UUIDv7");
    // Axis: string or {line: UUID}. null is invalid.
    let axis: { kind: "sketch_x" } | { kind: "sketch_y" } | { kind: "line"; id: Uint8Array };
    if (typeof inner.axis === "string" && REVOLVE_AXES.has(inner.axis)) {
      axis = { kind: inner.axis as "sketch_x" | "sketch_y" };
    } else if (inner.axis && typeof inner.axis === "object" && "line" in (inner.axis as object)) {
      if (Object.keys(inner.axis).length !== 1) throw new CurrentInvalid("revolve.axis: expected a single variant");
      const line = (inner.axis as { line: unknown }).line;
      if (!(line instanceof Uint8Array) || !isUuidV7(line)) throw new CurrentInvalid("revolve.axis.line must be an RFC 4122 UUIDv7");
      axis = { kind: "line", id: line };
    } else {
      throw new CurrentInvalid("revolve.axis: expected sketch_x|sketch_y|{line: UUID}");
    }
    // Extent: string or {partial: {angle: Expression}}. null is invalid.
    let extent: { kind: "full_turn" } | { kind: "partial"; angle: Expression };
    if (typeof inner.extent === "string" && REVOLVE_EXTENTS.has(inner.extent)) {
      extent = { kind: "full_turn" };
    } else if (inner.extent && typeof inner.extent === "object" && "partial" in (inner.extent as object)) {
      if (Object.keys(inner.extent).length !== 1) throw new CurrentInvalid("revolve.extent: expected a single variant");
      const partial = (inner.extent as { partial: unknown }).partial;
      if (!partial || typeof partial !== "object") throw new CurrentInvalid("revolve.extent.partial must be an object");
      const angle = decodeExpression((partial as { angle?: unknown }).angle, "revolve.extent.partial.angle");
      // Native refuses 0, negative, and angles too close to 0 or 2π.
      if (angle.value < 0.00017453292519943296 || angle.value > 6.283185307179586 - 0.00017453292519943296) {
        throw new CurrentInvalid("revolve partial angle is outside the accepted range");
      }
      extent = { kind: "partial", angle };
    } else {
      throw new CurrentInvalid("revolve.extent: expected full_turn|{partial: {angle}}");
    }
    if (typeof inner.operation !== "string" || !OPERATIONS.has(inner.operation)) throw new CurrentInvalid("revolve.operation: expected new_body|add|cut|intersect");
    const previous = inner.previous == null ? null : (inner.previous instanceof Uint8Array && isUuidV7(inner.previous) ? inner.previous : (() => { throw new CurrentInvalid("revolve.previous must be UUID or null"); })());
    return { kind: "feature.revolve", profile: inner.profile, regions: inner.regions as Uint8Array[], axis, extent, operation: inner.operation, previous };
  }
  if (obj.kind === "feature.fillet") {
    const FILLET_FIELDS = new Set(["previous", "edges", "radius_mm"]);
    for (const key of Object.keys(inner)) if (!FILLET_FIELDS.has(key)) throw new CurrentInvalid(`unknown field ${key} on feature.fillet`);
    if (!(inner.previous instanceof Uint8Array) || !isUuidV7(inner.previous)) throw new CurrentInvalid("fillet.previous must be an RFC 4122 UUIDv7");
    if (!Array.isArray(inner.edges)) throw new CurrentInvalid("fillet.edges: expected array");
    if (inner.edges.length === 0) throw new CurrentInvalid("fillet.edges must be non-empty");
    if (!("radius_mm" in inner)) throw new CurrentInvalid("fillet requires radius_mm");
    if ("distance_mm" in inner) throw new CurrentInvalid("fillet must not have distance_mm");
    const edgesNode = raw.type === "map" ? raw.entries.find(e => e.key.type === "text" && e.key.value === "edges")?.value : undefined;
    if (!edgesNode || edgesNode.type !== "array") throw new CurrentInvalid("fillet.edges: missing raw array");
    const edges: EntityRef[] = [];
    for (let i = 0; i < inner.edges.length; i++) {
      const edgeNode = edgesNode.items[i];
      if (!edgeNode) throw new CurrentInvalid(`fillet.edges[${i}]: missing raw node`);
      edges.push(decodeEntityReference(inner.edges[i], `fillet.edges[${i}]`, edgeNode));
    }
    const radius = decodeExpression(inner.radius_mm, "radius_mm");
    if (!(radius.value > 0)) throw new CurrentInvalid("fillet.radius_mm must be positive");
    validateEdges(edges, "fillet.edges");
    return { kind: "feature.fillet", previous: inner.previous, edges, radius };
  }
  if (obj.kind === "feature.chamfer") {
    const CHAMFER_FIELDS = new Set(["previous", "edges", "distance_mm"]);
    for (const key of Object.keys(inner)) if (!CHAMFER_FIELDS.has(key)) throw new CurrentInvalid(`unknown field ${key} on feature.chamfer`);
    if (!(inner.previous instanceof Uint8Array) || !isUuidV7(inner.previous)) throw new CurrentInvalid("chamfer.previous must be an RFC 4122 UUIDv7");
    if (!Array.isArray(inner.edges)) throw new CurrentInvalid("chamfer.edges: expected array");
    if (!("distance_mm" in inner)) throw new CurrentInvalid("chamfer requires distance_mm");
    if ("radius_mm" in inner) throw new CurrentInvalid("chamfer must not have radius_mm");
    const edgesNode = field(raw, "edges");
    if (edgesNode.type !== "array") throw new CurrentInvalid("chamfer.edges: expected array");
    const edges = inner.edges.map((value, index) => decodeEntityReference(value, "chamfer.edges", edgesNode.items[index]!));
    validateEdges(edges, "chamfer.edges");
    const distance = decodeExpression(inner.distance_mm, "distance_mm");
    if (!(distance.value > 0)) throw new CurrentInvalid("chamfer.distance_mm must be positive");
    return { kind: "feature.chamfer", previous: inner.previous, edges, distance };
  }
  if (obj.kind === "feature.keep_solids") {
    for (const key of Object.keys(inner)) if (!["previous", "selection"].includes(key)) throw new CurrentInvalid(`unknown field ${key} on keep_solids`);
    const previous = currentUuid(inner.previous, "keep_solids.previous");
    const sel = asRecord(inner.selection, "selection");
    for (const key of Object.keys(sel)) if (!["kind", "faces"].includes(key)) throw new CurrentInvalid(`unknown field ${key} on selection`);
    if (sel.kind === "containing_faces") {
      const facesNode = field(field(raw, "selection"), "faces");
      if (facesNode.type !== "array" || facesNode.items.length === 0) throw new CurrentInvalid("containing_faces requires non-empty faces");
      const faces = facesNode.items.map(node => decodeEntityReference(cborToValue(node), "selection.faces", node));
      if (faces.some(face => face.kind !== 0)) throw new CurrentInvalid("KeepSolids requires face references");
      return { kind: "feature.keep_solids", previous, selection: { kind: "containing_faces", faces } };
    }
    if (sel.kind !== "all") throw new CurrentInvalid("selection.kind: expected all or containing_faces");
    if ("faces" in sel) throw new CurrentInvalid("selection all must not have faces");
    return { kind: "feature.keep_solids", previous, selection: { kind: "all" } };
  }
  if (obj.kind === "sketch") return { kind: "sketch", ...decodeSketchCurrent(inner) };
  if (obj.kind === "feature.extrude") {
    for (const key of Object.keys(inner)) if (!EXTRUDE_FIELDS.has(key)) throw new CurrentInvalid(`unknown field ${key} on feature.extrude`);
    if (typeof inner.reversed !== "boolean") throw new CurrentInvalid("feature.extrude.reversed: expected bool");
    const regions = asArray(inner.regions, "extrude.regions").map(value => currentUuid(value, "extrude.regions item"));
    if (typeof inner.operation !== "string" || !OPERATIONS.has(inner.operation)) throw new CurrentInvalid("extrude.operation: expected new_body|add|cut|intersect");
    return { kind: "feature.extrude", profile: currentUuid(inner.profile, "extrude.profile"), regions,
      end: decodeExtrudeEnd(inner, raw), reversed: inner.reversed, operation: inner.operation,
      previous: inner.previous == null ? null : currentUuid(inner.previous, "extrude.previous") };
  }
  if (obj.kind === "body") {
    const body = decodeBody(inner);
    return { kind: "body", tip: body.tip === null ? null : currentUuid(body.tip, "body.tip_feature") };
  }
  if (obj.kind === "exchange.step.imported") return { kind: "exchange.step.imported", imported: decodeImportedPayload(raw, 3) };
  throw new CurrentInvalid(`unknown object kind ${JSON.stringify(obj.kind)}`);
}

function decodeExtrudeEnd(inner: Record<string, unknown>, raw: import("./cbor.ts").CborNode): { kind: "blind" | "symmetric"; distance: Expression } | { kind: "through_all" } | { kind: "up_to_face"; result: Uint8Array; face: EntityRef; offset: Expression } | { kind: "up_to_vertex"; result: Uint8Array; vertex: EntityRef } {
  const end = asRecord(inner.end_condition, "end_condition");
  if (typeof end.kind !== "string") throw new CurrentInvalid("end_condition.kind: expected string");
  if (end.kind === "blind" || end.kind === "symmetric") {
    const distance = decodeExpression(end.distance, "end_condition.distance");
    if (!(distance.value > 0)) throw new CurrentInvalid("extrude distance must be positive");
    return { kind: end.kind, distance };
  }
  if (end.kind === "through_all") return { kind: "through_all" };
  if (end.kind === "up_to_face") {
    if (!(end.result instanceof Uint8Array) || !isUuidV7(end.result)) throw new CurrentInvalid("up_to_face.result must be an RFC 4122 UUIDv7");
    const endNode = raw.type === "map" ? raw.entries.find(e => e.key.type === "text" && e.key.value === "end_condition")?.value : undefined;
    const faceNode = endNode && endNode.type === "map" ? endNode.entries.find(e => e.key.type === "text" && e.key.value === "face")?.value : undefined;
    if (!faceNode) throw new CurrentInvalid("up_to_face.face: missing raw node");
    const face = decodeEntityReference(end.face, "up_to_face.face", faceNode);
    if (face.kind !== 0) throw new CurrentInvalid("up_to_face.face must name a face");
    const offset = decodeExpression(end.offset_mm, "up_to_face.offset_mm");
    return { kind: "up_to_face", result: end.result, face, offset };
  }
  if (end.kind === "up_to_vertex") {
    if (!(end.result instanceof Uint8Array) || !isUuidV7(end.result)) throw new CurrentInvalid("up_to_vertex.result must be an RFC 4122 UUIDv7");
    const endNode = raw.type === "map" ? raw.entries.find(e => e.key.type === "text" && e.key.value === "end_condition")?.value : undefined;
    const vertexNode = endNode && endNode.type === "map" ? endNode.entries.find(e => e.key.type === "text" && e.key.value === "vertex")?.value : undefined;
    if (!vertexNode) throw new CurrentInvalid("up_to_vertex.vertex: missing raw node");
    const vertex = decodeEntityReference(end.vertex, "up_to_vertex.vertex", vertexNode);
    if (vertex.kind !== 2) throw new CurrentInvalid("up_to_vertex.vertex must name a vertex");
    if (vertex.selection !== 0) throw new CurrentInvalid("up_to_vertex.vertex requires selection one");
    return { kind: "up_to_vertex", result: end.result, vertex };
  }
  throw new CurrentInvalid(`unknown end_condition.kind ${JSON.stringify(end.kind)}`);
}

function validateSemantics(decoded: Map<string, DecodedPayload>, ctx: CurrentContext) {
  for (const obj of ctx.objects) {
    const id = uuidOf(obj.id), payload = decoded.get(id)!;
    const requireSupport = (support: Uint8Array | null, plane: Uint8Array | null = null) => {
      if (support) {
        const result = objectById(ctx.objects, support);
        if (!result || !isFeatureKind(result.kind)) throw new CurrentInvalid(`${obj.kind} requires a feature support result`);
        if (!hasEdge(ctx.deps, obj.id, support, "support")) throw new CurrentInvalid(`${obj.kind} has no support dependency`);
      }
      for (const dep of ctx.deps.filter(d => bytesEqual(d.dependent, obj.id))) {
        if ((dep.role === "support" && (!support || !bytesEqual(dep.dependency, support))) ||
            (payload.kind === "datum.plane" && dep.role === "plane" && (!plane || !bytesEqual(dep.dependency, plane)))) {
          throw new CurrentInvalid(`${obj.kind} has unexpected ${dep.role} dependency`);
        }
      }
    };
    if (payload.kind === "datum.plane") {
      if (payload.variant === "offset") checkPlaneRef(ctx, obj, payload.from);
      if (payload.variant === "face" && payload.face.kind !== 0) throw new CurrentInvalid("face reference must name a face");
      requireSupport(payload.variant === "face" ? payload.result : null, payload.variant === "offset" ? payload.from : null);
    } else if (payload.kind === "sketch") {
      checkPlaneRef(ctx, obj, payload.plane);
    } else if (payload.kind === "body") {
      if (payload.tip) checkBodyTipRef(ctx, obj, payload.tip);
    } else if (payload.kind === "feature.extrude" || payload.kind === "feature.revolve") {
      checkProfileRef(ctx, obj, payload.profile);
      checkExtrudeHistory(ctx, obj, { operation: payload.operation, previous: payload.previous,
        endKind: payload.kind === "feature.extrude" ? payload.end.kind : undefined });
      if (payload.kind === "feature.extrude") {
        requireSupport(payload.end.kind === "up_to_face" || payload.end.kind === "up_to_vertex" ? payload.end.result : null);
      } else if (payload.axis.kind === "line") {
        const sketch = decoded.get(uuidOf(payload.profile));
        const lineId = uuidOf(payload.axis.id);
        if (sketch?.kind !== "sketch" || !sketch.curves.some(c => c.id === lineId && c.kind === "line")) {
          throw new CurrentInvalid(`revolve.axis.line ${lineId} is not a Line of its profile`);
        }
      }
    } else if (payload.kind === "feature.fillet" || payload.kind === "feature.chamfer" || payload.kind === "feature.keep_solids") {
      checkExtrudeHistory(ctx, obj, { operation: "cut", previous: payload.previous });
    }
  }
}

/** Damage to a contract this build understands. Never an editable document. */
export class CurrentInvalid extends Error {
  readonly code = "invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "CurrentInvalid";
  }
}

/** Structurally intact, but outside the editable plate/L slice. */
export class CurrentUnsupported extends Error {
  readonly code = "unsupported" as const;
  constructor(message: string) {
    super(message);
    this.name = "CurrentUnsupported";
  }
}

export type FormatFamily = "current" | "historical" | "unknown";

type ObjectRow = {
  id: Uint8Array;
  kind: string;
  name: string | null;
  payload: Uint8Array;
  hash: Uint8Array;
  parent: Uint8Array | null;
};

type DepRow = { dependent: Uint8Array; dependency: Uint8Array; role: string };

type CurrentContext = {
  objects: ObjectRow[];
  deps: DepRow[];
  documentId: string;
  decoded: Map<string, DecodedPayload>;
  imports: Map<string, ImportedResult>;
};

export function detectFamily(db: SqlDb): FormatFamily {
  const meta = columns(db, "meta");
  const objects = columns(db, "objects");
  if (!meta.length || !objects.length) return "unknown";
  const historical = meta.includes("format_version") && objects.includes("schema_version");
  const current = !meta.includes("format_version") && !objects.includes("schema_version") && !hasTable(db, "capabilities");
  if (historical) return "historical";
  if (current && meta.includes("document_id") && meta.includes("generator") && objects.includes("payload_hash")) return "current";
  return "unknown";
}

/**
 * Shared barrier for every current document. Called by the plate reader and
 * by STEP extraction. Family detection is not this check.
 */
export function openCurrent(db: SqlDb): CurrentContext & { support: CurrentSupport } {
  const integrity = textOfPragma(db, "integrity_check");
  if (integrity !== "ok") throw new CurrentInvalid(`SQLite integrity_check: ${integrity}`);
  const applicationId = numberOfPragma(db, "application_id");
  if (applicationId !== FCAD_APPLICATION_ID) {
    throw new CurrentInvalid(
      `not a FerriteCAD document: application id is 0x${applicationId.toString(16).padStart(8, "0")}, expected 0x46434144`,
    );
  }
  checkRequiredTables(db);
  checkDisplayUnits(db);
  const meta = db.get("SELECT document_id FROM meta WHERE id = 1");
  if (!meta) throw new CurrentInvalid("reading document metadata: Query returned no rows");
  const documentId = requireUuidV7(asBlob(meta[0], "document_id"), "document_id");
  const broken = db.all("PRAGMA foreign_key_check");
  if (broken.length > 0) throw new CurrentInvalid("foreign_key_check failed");
  const objects = loadObjects(db);
  if (objects.some((row) => !hashMatches(row.payload, row.hash))) {
    throw new CurrentInvalid("an object payload does not match its BLAKE3 hash");
  }
  if (objects.some((row) => !isUuidV7(row.id))) {
    throw new CurrentInvalid("ObjectId must be an RFC 4122 UUIDv7");
  }
  const deps = loadDeps(db);
  const ctx: CurrentContext = { objects, deps, documentId, decoded: new Map(), imports: new Map() };
  checkGraphAndHierarchy(ctx);
  checkTopologyFull(db, ctx);
  checkImportedReachability(db);
  checkKnownPayloads(ctx, db);
  return { ...ctx, support: assessCurrent(ctx) };
}


type ImportedResult = { step: Uint8Array; meta: ImportedSourceMeta; scene: PortableScene | null };
type CurrentSupport = { kind: "part"; model: PartModel } | { kind: "imported"; source: ImportedResult } | { kind: "opaque"; reason: string };

function assessCurrent(ctx: CurrentContext): CurrentSupport {
  const kinds = ctx.objects.map(row => row.kind);
  if (kinds.includes("exchange.step.imported")) {
    if (kinds.length !== 1) return { kind: "opaque", reason: "imported document contains multiple objects; outside the single-import slice" };
    return { kind: "imported", source: ctx.imports.get(uuidOf(ctx.objects[0]!.id))! };
  }
  if (kinds.length !== 4 || !sameSet(kinds, ["datum.plane", "sketch", "feature.extrude", "body"])) {
    return { kind: "opaque", reason: "current document is outside the plate/L slice" };
  }
  try { return { kind: "part", model: plateModel(ctx) }; }
  catch (error) {
    if (error instanceof CurrentUnsupported) return { kind: "opaque", reason: error.message };
    throw error;
  }
}

export function readCurrent(db: SqlDb): FcadDocument {
  try {
    const { support } = openCurrent(db);
    if (support.kind === "part") return { ok: true, status: "editable", editable: true, model: support.model, summary: `current plate ${support.model.distanceSource}`, basis: "current" };
    return { ok: true, status: "unsupported", editable: false, reason: support.kind === "opaque" ? support.reason : "this current document is an imported STEP scene, not an editable plate", summary: support.kind, basis: "current" };
  } catch (error) {
    if (error instanceof CurrentUnsupported) return { ok: true, status: "unsupported", editable: false, reason: error.message, summary: "outside slice", basis: "current" };
    return { ok: false, status: "invalid", error: error instanceof Error ? error.message : String(error), basis: "current" };
  }
}

export function readCurrentImport(db: SqlDb): ImportedResult {
  const { support } = openCurrent(db);
  if (support.kind !== "imported") throw new CurrentUnsupported(support.kind === "opaque" ? support.reason : "this document has no embedded STEP source");
  return { ...support.source, step: support.source.step.slice() };
}

function plateModel(ctx: CurrentContext): PartModel {
  const plane = mustKind(ctx.objects, "datum.plane"), sketch = mustKind(ctx.objects, "sketch");
  const extrude = mustKind(ctx.objects, "feature.extrude"), body = mustKind(ctx.objects, "body");
  const p = ctx.decoded.get(uuidOf(plane.id))!, s = ctx.decoded.get(uuidOf(sketch.id))!;
  const e = ctx.decoded.get(uuidOf(extrude.id))!, b = ctx.decoded.get(uuidOf(body.id))!;
  if (p.kind !== "datum.plane" || s.kind !== "sketch" || e.kind !== "feature.extrude" || b.kind !== "body") throw new CurrentInvalid("decoded kinds do not match the document");
  if (p.variant !== "fixed" || JSON.stringify(p.placement) !== IDENTITY) throw new CurrentUnsupported("plane is not fixed identity XY");
  if (s.constraints > 0) throw new CurrentUnsupported("sketch constraints are outside this slice");
  if (!b.tip) throw new CurrentUnsupported("body has no tip feature");
  if (e.regions.length || e.operation !== "new_body" || e.end.kind !== "blind" || e.reversed || e.previous) throw new CurrentUnsupported("extrude is not Blind +Z NewBody with empty regions");
  if (!bytesEqual(b.tip, extrude.id)) throw new CurrentInvalid("body tip is not the extrude");
  const curves: SketchCurve[] = s.curves.map(c => {
    if (c.kind !== "line") throw new CurrentUnsupported("only line geometry is editable");
    return { id: c.id, construction: c.construction, kind: c.kind, start: c.start, end: c.end };
  });
  const issue = loopIssue(curves);
  if (issue) throw new CurrentUnsupported(issue);
  return { documentId: ctx.documentId, planeId: uuidOf(plane.id), planeName: plane.name ?? "XY",
    sketchId: uuidOf(sketch.id), sketchName: sketch.name ?? "Sketch", curves, area: signedArea(curves),
    extrudeId: uuidOf(extrude.id), extrudeName: extrude.name ?? "Extrude", distanceSource: e.end.distance.source,
    distanceMm: e.end.distance.value, bodyId: uuidOf(body.id), bodyName: body.name ?? "Body" };
}

function payloadNode(obj: ObjectRow): import("./cbor.ts").CborNode {
  const root = decodeCbor(obj.payload);
  if (textOf(field(root, "type"), "type") !== obj.kind) throw new CurrentInvalid(`type is not ${obj.kind}`);
  if (fieldPresent(root, "schema_version")) throw new CurrentInvalid("current envelope must not carry schema_version");
  const raw = field(root, "payload");
  if (raw.type !== "bytes") throw new CurrentInvalid("payload is not embedded CBOR");
  return decodeCbor(raw.value);
}

function loadObjects(db: SqlDb): ObjectRow[] {
  return db.all("SELECT id, kind, name, payload, payload_hash, parent_id FROM objects ORDER BY ordinal, rowid").map((row) => ({
    id: asBlob(row[0], "id"),
    kind: String(row[1]),
    name: row[2] == null ? null : String(row[2]),
    payload: asBlob(row[3], "payload"),
    hash: asBlob(row[4], "payload_hash"),
    parent: row[5] == null ? null : asBlob(row[5], "parent_id"),
  }));
}

function loadDeps(db: SqlDb): DepRow[] {
  if (!hasTable(db, "deps")) return [];
  return db.all("SELECT dependent_id, dependency_id, role FROM deps").map((row) => ({
    dependent: asBlob(row[0], "dependent_id"),
    dependency: asBlob(row[1], "dependency_id"),
    role: String(row[2]),
  }));
}

function mustKind(objects: ObjectRow[], kind: string): ObjectRow {
  const found = objects.find((row) => row.kind === kind);
  if (!found) throw new CurrentInvalid(`missing ${kind}`);
  return found;
}

function objectById(objects: ObjectRow[], id: Uint8Array): ObjectRow | undefined {
  return objects.find((row) => bytesEqual(row.id, id));
}

function hasEdge(deps: DepRow[], dependent: Uint8Array, dependency: Uint8Array, role: string): boolean {
  return deps.some((row) => row.role === role && bytesEqual(row.dependent, dependent) && bytesEqual(row.dependency, dependency));
}

function columns(db: SqlDb, table: string): string[] {
  if (!hasTable(db, table)) return [];
  return db.all(`PRAGMA table_info(${table})`).map((row) => String(row[1]));
}

function hasTable(db: SqlDb, table: string): boolean {
  const row = db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return Boolean(row);
}

function fieldPresent(node: { type: string; entries?: { key: { type: string; value?: unknown } }[] }, key: string): boolean {
  return node.type === "map" && Boolean(node.entries?.some((entry) => entry.key.type === "text" && entry.key.value === key));
}

function requireField(record: Record<string, unknown>, key: string, label: string) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new CurrentInvalid(`missing field ${key} on ${label}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) throw new CurrentInvalid(`${label}: expected map`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new CurrentInvalid(`${label}: expected array`);
  return value;
}

function asBlob(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new CurrentInvalid(`${label}: expected bytes`);
  return value;
}

function sameSet(got: string[], expected: string[]): boolean {
  return got.length === expected.length && expected.every((item) => got.includes(item));
}

function signedArea(curves: SketchCurve[]): number {
  let area = 0;
  for (const curve of curves) area += curve.start[0] * curve.end[1] - curve.end[0] * curve.start[1];
  return Math.abs(area) / 2;
}

function textOfPragma(db: SqlDb, name: string): string {
  const row = db.get(`PRAGMA ${name}`);
  const value = row?.[0];
  if (typeof value !== "string") throw new CurrentInvalid(`${name}: expected text`);
  return value;
}

function numberOfPragma(db: SqlDb, name: string): number {
  const row = db.get(`PRAGMA ${name}`);
  const value = row?.[0];
  if (typeof value !== "number" && typeof value !== "bigint") throw new CurrentInvalid(`${name}: expected number`);
  return Number(value);
}

const KNOWN_ROLES = new Set(["profile", "plane", "predecessor", "body_tip", "support", "parameter"]);
const _FEATURE_KINDS = new Set(["feature.extrude", "feature.cut", "feature.revolve", "feature.fillet", "feature.chamfer"]); // extend as known; for now extrude is the only implemented feature

function checkRequiredTables(db: SqlDb) {
  // From DOCUMENT_SCHEMA. Absence of a table is not the same as an empty table.
  for (const table of ["meta", "objects", "deps", "imported_sources", "imported_source_refs"]) {
    if (!hasTable(db, table)) throw new CurrentInvalid(`missing required table ${table}`);
  }
}

function checkDisplayUnits(db: SqlDb) {
  const row = db.get("SELECT display_length_unit, display_angle_unit FROM meta WHERE id = 1");
  if (!row) throw new CurrentInvalid("reading document metadata: Query returned no rows");
  const length = String(row[0]);
  const angle = String(row[1]);
  if (!isLengthUnit(length)) throw new CurrentInvalid(`display length unit must measure length, found ${length}`);
  if (!isAngleUnit(angle)) throw new CurrentInvalid(`display angle unit must measure angles, found ${angle}`);
}

// Rust Unicode White_Space (char::is_whitespace / str::trim). Not JS trim:
// U+0085 is included, U+FEFF is not. Stored strings are never rewritten.
function rustWhiteSpace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d
    || code === 0x20 || code === 0x85 || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}
function rustTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const code = value.codePointAt(start);
    if (code === undefined || !rustWhiteSpace(code)) break;
    start += code > 0xffff ? 2 : 1;
  }
  while (end > start) {
    const prev = end - 1;
    const c = value.codePointAt(prev);
    if (c === undefined) break;
    const step = c > 0xffff ? 2 : 1;
    if (!rustWhiteSpace(c)) break;
    end -= step;
  }
  return value.slice(start, end);
}
type UnitDim = "length" | "angle" | "unitless";
function parseUnit(raw: string): { unit: string; dimension: UnitDim } {
  const folded = rustTrim(raw).toLowerCase(); // ASCII case folding after Rust trim
  switch (folded) {
    case "mm": case "millimeter": case "millimetre": return { unit: "millimeter", dimension: "length" };
    case "cm": case "centimeter": case "centimetre": return { unit: "centimeter", dimension: "length" };
    case "m": case "meter": case "metre": return { unit: "meter", dimension: "length" };
    case "in": case "inch": return { unit: "inch", dimension: "length" };
    case "ft": case "foot": case "feet": return { unit: "foot", dimension: "length" };
    case "rad": case "radian": return { unit: "radian", dimension: "angle" };
    case "deg": case "degree": case "°": return { unit: "degree", dimension: "angle" };
    case "": case "none": case "unitless": return { unit: "unitless", dimension: "unitless" };
    default: throw new CurrentInvalid(`unknown unit ${JSON.stringify(folded)}`);
  }
}
function isLengthUnit(u: string): boolean {
  try { return parseUnit(u).dimension === "length"; } catch { return false; }
}
function isAngleUnit(u: string): boolean {
  try { return parseUnit(u).dimension === "angle"; } catch { return false; }
}

function checkGraphAndHierarchy(ctx: CurrentContext) {
  // Unknown dependency roles
  for (const dep of ctx.deps) {
    if (!KNOWN_ROLES.has(dep.role)) {
      throw new CurrentInvalid(`unknown dependency role ${JSON.stringify(dep.role)}`);
    }
  }
  // Graph cycles / dangling
  if (hasCycle(ctx.objects.map(o => o.id), ctx.deps)) {
    throw new CurrentInvalid("the feature graph contains a cycle");
  }
  // Parent checks
  const byId = new Map(ctx.objects.map(o => [uuidOf(o.id), o]));
  for (const obj of ctx.objects) {
    if (obj.parent) {
      const parentId = uuidOf(obj.parent);
      if (bytesEqual(obj.parent, obj.id)) {
        throw new CurrentInvalid(`object ${uuidOf(obj.id)} is its own parent`);
      }
      if (!byId.has(parentId)) {
        throw new CurrentInvalid(`object ${uuidOf(obj.id)} names missing parent ${parentId}`);
      }
    }
  }
  // Parent cycles
  if (hasParentCycle(ctx.objects)) {
    throw new CurrentInvalid("object hierarchy contains a parent cycle");
  }
}

function hasCycle(nodes: Uint8Array[], deps: DepRow[]): boolean {
  const adj = new Map<string, string[]>();
  const idSet = new Set(nodes.map(uuidOf));
  for (const n of nodes) adj.set(uuidOf(n), []);
  for (const d of deps) {
    const dep = uuidOf(d.dependency);
    const dent = uuidOf(d.dependent);
    if (!idSet.has(dep)) return true; // dangling
    if (adj.has(dent)) adj.get(dent)!.push(dep);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function dfs(u: string): boolean {
    if (visiting.has(u)) return true;
    if (visited.has(u)) return false;
    visiting.add(u);
    for (const v of adj.get(u) || []) if (dfs(v)) return true;
    visiting.delete(u);
    visited.add(u);
    return false;
  }
  for (const n of nodes) if (dfs(uuidOf(n))) return true;
  return false;
}

function hasParentCycle(objects: ObjectRow[]): boolean {
  const parents = new Map(objects.map(o => [uuidOf(o.id), o.parent ? uuidOf(o.parent) : null]));
  for (const start of parents.keys()) {
    let current: string | null = start;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = parents.get(current) || null;
    }
  }
  return false;
}

function checkTopologyFull(db: SqlDb, _ctx: CurrentContext) {
  // Current format derives output names from features. Any sqlite_schema object
  // named topology_refs (table, view, index) is historical and unsupported.
  const entry = db.get("SELECT type FROM sqlite_schema WHERE name = 'topology_refs'");
  if (entry) {
    throw new CurrentUnsupported(`unsupported document schema object topology_refs (${entry[0]}): output names must be derived from features`);
  }
}

function checkImportedReachability(db: SqlDb) {
  if (!hasTable(db, "imported_sources") || !hasTable(db, "imported_source_refs")) return;
  const orphan = db.get(`
    SELECT count(*) FROM imported_sources s
    WHERE NOT EXISTS (SELECT 1 FROM imported_source_refs r WHERE r.source_id = s.id)
  `);
  if (orphan && Number(orphan[0]) > 0) {
    throw new CurrentInvalid(`this document has ${orphan[0]} imported source row(s) with no owning object; refusing to edit because automatic cleanup could destroy recoverable source bytes`);
  }
}

function checkKnownPayloads(ctx: CurrentContext, db: SqlDb) {
  for (const obj of ctx.objects) {
    try {
      if (!KNOWN_KINDS.has(obj.kind)) throw new CurrentInvalid(`unknown object kind ${JSON.stringify(obj.kind)}`);
      ctx.decoded.set(uuidOf(obj.id), decodeKnownPayload(obj));
    } catch (error) {
      if (error instanceof CurrentInvalid) throw error;
      throw new CurrentInvalid(error instanceof Error ? error.message : String(error));
    }
  }
  validateSemantics(ctx.decoded, ctx);
  for (const obj of ctx.objects) {
    const payload = ctx.decoded.get(uuidOf(obj.id))!;
    if (payload.kind === "exchange.step.imported") ctx.imports.set(uuidOf(obj.id), validateImportedObject(db, obj, payload.imported));
  }
  checkFeatureHistory(ctx);
  checkOccurrenceUniqueness(ctx);
}

type Point2 = [number, number];
type CurveGeom = { id: string; construction: boolean } & (
  | { kind: "point"; at: Point2 }
  | { kind: "line"; start: Point2; end: Point2 }
  | { kind: "circle"; center: Point2; radius: number }
  | { kind: "arc"; center: Point2; radius: number; startAngle: number; endAngle: number }
);
type DecodedCurrentSketch = { plane: Uint8Array; curves: CurveGeom[]; constraints: number };

function decodeSketchCurrent(inner: Record<string, unknown>): DecodedCurrentSketch {
  requireField(inner, "constraints", "sketch");
  if (!Array.isArray(inner.constraints)) throw new CurrentInvalid("constraints: expected array");
  const curves = asArray(inner.curves, "curves");
  const curveIds = new Set<string>();
  const geoms: CurveGeom[] = [];
  for (const curve of curves) {
    const c = asRecord(curve, "curve");
    requireField(c, "construction", "curve");
    if (typeof c.construction !== "boolean") throw new CurrentInvalid("curve.construction: expected bool");
    const id = asBlob(c.id, "curve.id");
    if (!isUuidV7(id)) throw new CurrentInvalid(`curve id ${uuidOf(id)} must be an RFC 4122 UUIDv7`);
    const idStr = uuidOf(id);
    if (curveIds.has(idStr)) throw new CurrentInvalid(`sketch contains duplicate curve id ${idStr}`);
    curveIds.add(idStr);
    const geometry = asRecord(c.geometry, "geometry");
    if (typeof geometry.kind !== "string") throw new CurrentInvalid(`geometry.kind: expected string, found ${typeof geometry.kind}`);
    const kind = geometry.kind;
    if (!["point", "line", "circle", "arc"].includes(kind)) {
      throw new CurrentInvalid(`unknown geometry kind ${JSON.stringify(kind)}`);
    }
    const point = (key: string): Point2 => {
      const p = asRecord(geometry[key], key);
      if (typeof p.x !== "number" || !Number.isFinite(p.x)) throw new CurrentInvalid(`${key}.x: expected finite number`);
      if (typeof p.y !== "number" || !Number.isFinite(p.y)) throw new CurrentInvalid(`${key}.y: expected finite number`);
      return [p.x, p.y];
    };
    const base = { id: idStr, construction: c.construction };
    if (kind === "point") geoms.push({ ...base, kind, at: point("at") });
    else if (kind === "line") geoms.push({ ...base, kind, start: point("start"), end: point("end") });
    else {
      const center = point("center"), radius = geometry.radius;
      if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) throw new CurrentInvalid(`${kind} radius must be positive and finite`);
      if (kind === "circle") geoms.push({ ...base, kind, center, radius });
      else {
        const startAngle = geometry.start_angle, endAngle = geometry.end_angle;
        if (typeof startAngle !== "number" || !Number.isFinite(startAngle)) throw new CurrentInvalid("start_angle: expected finite number");
        if (typeof endAngle !== "number" || !Number.isFinite(endAngle)) throw new CurrentInvalid("end_angle: expected finite number");
        geoms.push({ ...base, kind: "arc", center, radius, startAngle, endAngle });
      }
    }
  }
  const constraintIds = new Set<string>();
  for (const item of inner.constraints) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item instanceof Uint8Array) {
      throw new CurrentInvalid("invalid type: null, expected map for constraint");
    }
    const cons = item as Record<string, unknown>;
    if (!("id" in cons)) throw new CurrentInvalid("missing field id on constraint");
    const cid = asBlob(cons.id, "constraint.id");
    if (!isUuidV7(cid)) throw new CurrentInvalid(`constraint id ${uuidOf(cid)} must be an RFC 4122 UUIDv7`);
    const cidStr = uuidOf(cid);
    if (constraintIds.has(cidStr)) throw new CurrentInvalid(`sketch contains duplicate constraint id ${cidStr}`);
    constraintIds.add(cidStr);
    if (!("rule" in cons) || !cons.rule || typeof cons.rule !== "object") {
      throw new CurrentInvalid("missing field rule on constraint");
    }
    const rule = cons.rule as Record<string, unknown>;
    if (!("kind" in rule) || typeof rule.kind !== "string") throw new CurrentInvalid("missing field kind on constraint.rule");
    validateConstraintRule(rule, geoms, cidStr);
  }
  return { plane: currentUuid(inner.plane, "sketch.plane"), curves: geoms, constraints: inner.constraints.length };
}

function validateConstraintRule(rule: Record<string, unknown>, geoms: CurveGeom[], constraintId: string) {
  const kind = String(rule.kind);
  const byId = new Map(geoms.map((g) => [g.id, g]));
  const pointRef = (key: string): { curve: string; at: string } => {
    const ref = asRecord(rule[key], key);
    const curve = asBlob(ref.curve, `${key}.curve`);
    if (!isUuidV7(curve)) throw new CurrentInvalid(`constraint point curve must be an RFC 4122 UUIDv7`);
    const curveStr = uuidOf(curve);
    const geom = byId.get(curveStr);
    if (!geom) throw new CurrentInvalid(`constraint ${constraintId} refers to curve ${curveStr}, which is not a curve of this sketch`);
    if (typeof ref.at !== "string") throw new CurrentInvalid(`point selector: expected string, found ${typeof ref.at}`);
    const at = ref.at;
    if (!["at", "start", "end", "center"].includes(at)) throw new CurrentInvalid(`unknown point selector ${JSON.stringify(at)}`);
    const fits = (at === "at" && geom.kind === "point") || ((at === "start" || at === "end") && geom.kind === "line") || (at === "center" && geom.kind === "circle");
    if (!fits) throw new CurrentInvalid(`constraint ${constraintId} names the ${at} of ${curveStr}, which is a ${geom.kind} and has no such point`);
    return { curve: curveStr, at };
  };
  const segmentRef = (key: string) => {
    const ref = asRecord(rule[key], key);
    const from = pointRefFrom(ref, "from", byId, constraintId);
    const to = pointRefFrom(ref, "to", byId, constraintId);
    if (from.curve === to.curve && from.at === to.at) {
      throw new CurrentInvalid(`a segment runs between two points, but this one names ${from.curve}:${from.at} twice`);
    }
    return { from, to };
  };
  const expr = (key: string) => {
    const e = asRecord(rule[key], key);
    if (typeof e.source !== "string") throw new CurrentInvalid(`${key}.source: expected text`);
    if (typeof e.value !== "number" || !Number.isFinite(e.value)) throw new CurrentInvalid(`${key}.value: expected finite number`);
    return Number(e.value);
  };
  if (kind === "fixed") {
    pointRef("point");
    expr("x");
    expr("y");
  } else if (kind === "distance") {
    pointRef("a");
    pointRef("b");
    const d = expr("distance");
    if (!(d > 0)) throw new CurrentInvalid("constraint distance must be positive");
  } else if (kind === "radius") {
    const curve = asBlob(rule.curve, "curve");
    if (!isUuidV7(curve)) throw new CurrentInvalid("constraint radius curve must be an RFC 4122 UUIDv7");
    const curveStr = uuidOf(curve);
    const geom = byId.get(curveStr);
    if (!geom) throw new CurrentInvalid(`constraint ${constraintId} refers to curve ${curveStr}, which is not a curve of this sketch`);
    if (geom.kind !== "circle") throw new CurrentInvalid(`constraint ${constraintId} gives a radius to ${curveStr}, which is a ${geom.kind} and has none`);
    const r = expr("radius");
    if (!(r > 0)) throw new CurrentInvalid("constraint radius must be positive");
  } else if (kind === "directed_angle") {
    segmentRef("a");
    segmentRef("b");
    const ang = expr("angle");
    if (ang <= -Math.PI || ang > Math.PI) throw new CurrentInvalid("a directed angle is canonical in (-pi, pi] radians");
  } else if (["coincident", "horizontal", "vertical"].includes(kind)) {
    pointRef("a");
    pointRef("b");
  } else if (["equal_length", "perpendicular", "parallel", "collinear"].includes(kind)) {
    segmentRef("a");
    segmentRef("b");
  } else {
    throw new CurrentInvalid(`unknown constraint kind ${JSON.stringify(kind)}`);
  }
}
function pointRefFrom(ref: Record<string, unknown>, key: string, byId: Map<string, CurveGeom>, constraintId: string): { curve: string; at: string } {
  const at = asRecord(ref[key], key);
  const curve = asBlob(at.curve, `${key}.curve`);
  if (!isUuidV7(curve)) throw new CurrentInvalid(`constraint point curve must be an RFC 4122 UUIDv7`);
  const curveStr = uuidOf(curve);
  const geom = byId.get(curveStr);
  if (!geom) throw new CurrentInvalid(`constraint ${constraintId} refers to curve ${curveStr}, which is not a curve of this sketch`);
  if (typeof at.at !== "string") throw new CurrentInvalid(`point selector: expected string, found ${typeof at.at}`);
  const selector = at.at;
  if (!["at", "start", "end", "center"].includes(selector)) throw new CurrentInvalid(`unknown point selector ${JSON.stringify(selector)}`);
  const fits = (selector === "at" && geom.kind === "point") || ((selector === "start" || selector === "end") && geom.kind === "line") || (selector === "center" && geom.kind === "circle");
  if (!fits) throw new CurrentInvalid(`constraint ${constraintId} names the ${selector} of ${curveStr}, which is a ${geom.kind} and has no such point`);
  return { curve: curveStr, at: selector };
}


const FEATURE_KINDS = new Set(["feature.extrude", "feature.revolve", "feature.fillet", "feature.chamfer", "feature.keep_solids"]);
function isFeatureKind(kind: string): boolean {
  return FEATURE_KINDS.has(kind);
}
function checkExtrudeHistory(ctx: CurrentContext, extrude: ObjectRow, decoded: { operation: string; previous: Uint8Array | null; endKind?: string }) {
  const op = decoded.operation;
  const prev = decoded.previous;
  // ThroughAll is only valid for Cut/Intersect
  if (decoded.endKind === "through_all" && (op === "new_body" || op === "add")) {
    throw new CurrentInvalid(`feature ${uuidOf(extrude.id)} uses through_all with ${op}; only cut or intersect may run through everything`);
  }
  if (op === "new_body") {
    if (prev) throw new CurrentInvalid(`feature ${uuidOf(extrude.id)} starts a body and also names ${uuidOf(prev)} as the result it modifies`);
    return;
  }
  if (!prev) throw new CurrentInvalid(`feature ${uuidOf(extrude.id)} modifies an existing solid but names no earlier feature`);
  if (bytesEqual(prev, extrude.id)) throw new CurrentInvalid(`feature ${uuidOf(extrude.id)} names itself as the result it modifies`);
  if (!isUuidV7(prev)) throw new CurrentInvalid(`feature previous must be an RFC 4122 UUIDv7`);
  const target = objectById(ctx.objects, prev);
  if (!target) throw new CurrentInvalid(`feature ${uuidOf(extrude.id)} modifies missing feature ${uuidOf(prev)}`);
  if (!isFeatureKind(target.kind)) throw new CurrentInvalid(`feature ${uuidOf(extrude.id)} modifies ${uuidOf(prev)}, which is not a feature`);
  if (!hasEdge(ctx.deps, extrude.id, target.id, "predecessor")) {
    throw new CurrentInvalid(`feature ${uuidOf(extrude.id)} refers to ${uuidOf(prev)} but no predecessor dependency records it`);
  }
}
function checkFeatureHistory(ctx: CurrentContext) {
  const predecessors = new Map<string, string | null>(), consumers = new Map<string, string>();
  for (const [id, payload] of ctx.decoded) {
    if (!("previous" in payload)) continue;
    const previous = payload.previous ? uuidOf(payload.previous) : null;
    predecessors.set(id, previous);
    if (previous) {
      if (consumers.has(previous)) throw new CurrentInvalid(`feature ${previous} has forked history`);
      consumers.set(previous, id);
    }
  }
  const owners = new Map<string, string>();
  for (const [id, payload] of ctx.decoded) {
    if (payload.kind !== "body") continue;
    let current = payload.tip ? uuidOf(payload.tip) : null;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) throw new CurrentInvalid("cycle in feature history");
      seen.add(current);
      if (owners.has(current) && owners.get(current) !== id) throw new CurrentInvalid(`feature ${current} is owned by multiple bodies`);
      owners.set(current, id); current = predecessors.get(current) ?? null;
    }
  }
}
function checkOccurrenceUniqueness(ctx: CurrentContext) {
  const owners = new Map<string, string>();
  for (const [id, payload] of ctx.decoded) {
    if (payload.kind !== "exchange.step.imported") continue;
    for (const instance of payload.imported.scene?.instances ?? []) {
      if (!instance.occurrence) continue;
      const occurrence = uuidOf(instance.occurrence);
      if (owners.has(occurrence) && owners.get(occurrence) !== id) throw new CurrentInvalid(`occurrence ${occurrence} is claimed by multiple imports`);
      owners.set(occurrence, id);
    }
  }
}

function checkPlaneRef(ctx: CurrentContext, sketch: ObjectRow, planeId: Uint8Array) {
  const target = objectById(ctx.objects, planeId);
  if (!target) throw new CurrentInvalid(`sketch refers to missing object ${uuidOf(planeId)}`);
  if (target.kind !== "datum.plane") {
    throw new CurrentInvalid(`sketch expects ${uuidOf(planeId)} to be a datum.plane, found ${target.kind}`);
  }
  if (!hasEdge(ctx.deps, sketch.id, target.id, "plane")) {
    throw new CurrentInvalid(`sketch ${uuidOf(sketch.id)} refers to ${uuidOf(planeId)} but no plane dependency records it`);
  }
}
function checkProfileRef(ctx: CurrentContext, extrude: ObjectRow, profileId: Uint8Array) {
  const target = objectById(ctx.objects, profileId);
  if (!target) throw new CurrentInvalid(`extrude refers to missing object ${uuidOf(profileId)}`);
  if (target.kind !== "sketch") {
    throw new CurrentInvalid(`extrude expects ${uuidOf(profileId)} to be a sketch, found ${target.kind}`);
  }
  if (!hasEdge(ctx.deps, extrude.id, target.id, "profile")) {
    throw new CurrentInvalid(`extrude ${uuidOf(extrude.id)} refers to ${uuidOf(profileId)} but no profile dependency records it`);
  }
}
function checkBodyTipRef(ctx: CurrentContext, body: ObjectRow, tipId: Uint8Array) {
  const target = objectById(ctx.objects, tipId);
  if (!target) throw new CurrentInvalid(`body refers to missing tip ${uuidOf(tipId)}`);
  if (!isFeatureKind(target.kind)) {
    throw new CurrentInvalid(`body expects tip ${uuidOf(tipId)} to be a known feature, found ${target.kind}`);
  }
  if (!hasEdge(ctx.deps, body.id, target.id, "body_tip")) {
    throw new CurrentInvalid(`body ${uuidOf(body.id)} refers to tip feature ${uuidOf(tipId)} but no body_tip dependency records it`);
  }
}
function validateImportedObject(db: SqlDb, obj: ObjectRow, decoded: DecodedImport): ImportedResult {
  if (!decoded.scene) throw new CurrentInvalid("current imported scene has no keyed occurrences");
  const source = db.get("SELECT format, bytes, content_hash, byte_len FROM imported_sources WHERE id = ?", [decoded.source]);
  if (!source) throw new CurrentInvalid("imported source row is missing");
  const format = String(source[0]);
  const bytes = source[1] as Uint8Array;
  const hash = source[2] as Uint8Array;
  const byteLen = Number(source[3]);
  if (format !== "exchange.step") throw new CurrentInvalid(`embedded source format ${format} is not STEP`);
  if (byteLen !== bytes.byteLength || byteLen !== decoded.sourceByteLen) throw new CurrentInvalid("source byte_len does not match the stored STEP");
  if (!bytesEqual(hash, decoded.sourceHash) || !bytesEqual(blake3(bytes), hash)) {
    throw new CurrentInvalid("BLAKE3 imported_sources hash does not match");
  }
  const link = db.get("SELECT source_id FROM imported_source_refs WHERE object_id = ?", [obj.id]);
  if (!link || !bytesEqual(link[0] as Uint8Array, decoded.source)) {
    throw new CurrentInvalid("imported source link does not match the payload");
  }
  const step = bytes.slice();
  return { step, scene: decoded.scene, meta: { format, byteLen, blobBytes: step.byteLength,
    contentHashHex: blake3Hex(step), hashOk: true, objectName: obj.name, sourceName: decoded.sourceName,
    sourceByteLen: byteLen, sourceId: uuidOf(decoded.source), payloadSourceId: uuidOf(decoded.source),
    refSourceId: uuidOf(decoded.source), sourceLinkOk: true, hasStoredScene: true } };

}
