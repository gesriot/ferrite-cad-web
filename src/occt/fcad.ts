import { blake3 } from "@noble/hashes/blake3";
import { cborToValue, decodeCbor, encodeBytes, encodeFloat, encodeText, field, spliceBytes, textOf, type CborNode } from "./cbor.ts";

/** ASCII "FCAD" stored in SQLite application_id. */
export const FCAD_APPLICATION_ID = 0x46434144;

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function blake3Hex(bytes: Uint8Array): string {
  return hex(blake3(bytes));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function uuidOf(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new Error(`uuid is ${bytes.byteLength} bytes`);
  const text = hex(bytes);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/** RFC 4122 variant and version 7, the only identifier form FerriteCAD stores. */
export function isUuidV7(bytes: Uint8Array): boolean {
  if (bytes.byteLength !== 16) return false;
  const version = bytes[6]! >> 4;
  const variant = bytes[8]! & 0xc0;
  return version === 7 && variant === 0x80;
}

export function requireUuidV7(bytes: Uint8Array, label: string): string {
  if (!isUuidV7(bytes)) throw new Error(`${label} is not an RFC 4122 UUIDv7`);
  return uuidOf(bytes);
}

export type Point = [number, number];

export type SketchCurve = {
  id: string;
  construction: boolean;
  kind: string;
  start: Point;
  end: Point;
};

export type PlateModel = {
  planeId: string;
  identityPlacement: boolean;
  sketchId: string;
  sketchName: string;
  curves: SketchCurve[];
  extrudeId: string;
  extrudeName: string;
  distanceSource: string;
  distanceMm: number;
  reversed: boolean;
  operation: string;
  targetBody: null;
  bodyId: string;
  bodyName: string;
  tipFeature: string;
};

type ObjectRow = {
  id: Uint8Array;
  kind: string;
  name: string | null;
  ordinal: number;
  payload: Uint8Array;
};

export function hashMatches(payload: Uint8Array, hash: Uint8Array): boolean {
  return bytesEqual(blake3(payload), hash);
}

function embeddedPayload(payload: Uint8Array, expected: string): { node: CborNode; bytes: Uint8Array; fieldNode: CborNode } {
  const root = decodeCbor(payload);
  const type = textOf(field(root, "type"), "type");
  if (type !== expected) throw new Error(`type ${type} !== ${expected}`);
  const raw = field(root, "payload");
  if (raw.type !== "bytes") throw new Error(`${expected} payload field is ${raw.type}, not embedded CBOR bytes`);
  return { node: decodeCbor(raw.value), bytes: raw.value, fieldNode: raw };
}

export function parseHeight(source: string): { ok: true; source: string; value: number } | { ok: false; error: string } {
  const text = source.trim().replace(",", ".");
  if (!text) return { ok: false, error: "Height is missing" };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    return { ok: false, error: `Height "${source}" is not a number` };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: "Height is not a finite number" };
  if (!(value > 0)) return { ok: false, error: "Height must be greater than zero" };
  return { ok: true, source: text.startsWith("+") ? text.slice(1) : text, value };
}

/** Rewrites only the blind-distance source and value, then the envelope byte string. */
export function rewriteExtrudeDistance(payload: Uint8Array, nextSource: string, nextValue: number): Uint8Array {
  const parsed = parseHeight(nextSource);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.value !== nextValue) throw new Error(`source ${nextSource} does not evaluate to ${nextValue}`);
  const embedded = embeddedPayload(payload, "feature.extrude");
  const distance = field(field(embedded.node, "end_condition"), "distance");
  const source = field(distance, "source");
  const value = field(distance, "value");
  if (source.type !== "text" || !numericToken(value)) throw new Error("distance source/value are not text and a float");
  const inner = spliceBytes(embedded.bytes, [
    { start: source.start, end: source.end, next: encodeText(parsed.source) },
    { start: value.start, end: value.end, next: encodeFloat(nextValue) },
  ]);
  const next = spliceBytes(payload, [{ start: embedded.fieldNode.start, end: embedded.fieldNode.end, next: encodeBytes(inner) }]);
  const check = embeddedPayload(next, "feature.extrude");
  const patched = field(field(check.node, "end_condition"), "distance");
  const patchedSource = textOf(field(patched, "source"), "source");
  const patchedValue = field(patched, "value");
  if (patchedValue.type !== "float" || patchedValue.value !== nextValue || patchedSource !== parsed.source) {
    const shown = patchedValue.type === "float" ? String(patchedValue.value) : patchedValue.type;
    throw new Error(`rewritten distance decoded as ${patchedSource} / ${shown}`);
  }
  return next;
}

function numericToken(node: CborNode): boolean {
  return (node.type === "uint" || node.type === "nint" || node.type === "float") && typeof node.value === "number" && Number.isFinite(node.value);
}

export function patchExtrudeDistance(payload: Uint8Array, nextSource: string): Uint8Array {
  const parsed = parseHeight(nextSource);
  if (!parsed.ok) throw new Error(parsed.error);
  return rewriteExtrudeDistance(payload, parsed.source, parsed.value);
}

export function readPlateModel(rows: ObjectRow[]): PlateModel {
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const plane = byKind.get("datum.plane");
  const sketch = byKind.get("sketch");
  const extrude = byKind.get("feature.extrude");
  const body = byKind.get("body");
  if (!plane || !sketch || !extrude || !body) {
    throw new Error(`expected plane/sketch/extrude/body, got ${rows.map((row) => row.kind).join(", ")}`);
  }
  const planePayload = valueOf(plane.payload, "datum.plane");
  const placement = asRecord(planePayload.placement, "placement");
  const rows3 = placement.rows;
  const identityPlacement = JSON.stringify(rows3) === JSON.stringify([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]);
  const sketchPayload = valueOf(sketch.payload, "sketch");
  const curves = asArray(sketchPayload.curves, "curves").map((curve) => {
    const item = asRecord(curve, "curve");
    const geometry = asRecord(item.geometry, "geometry");
    const start = asRecord(geometry.start, "start");
    const end = asRecord(geometry.end, "end");
    return {
      id: uuidOf(asBytes(item.id, "curve.id")),
      construction: boolField(item, "construction"),
      kind: kindField(geometry.kind),
      start: pointField(start, "start"),
      end: pointField(end, "end"),
    };
  });
  const extrudePayload = valueOf(extrude.payload, "feature.extrude");
  const end = asRecord(extrudePayload.end_condition, "end_condition");
  const distance = asRecord(end.distance, "distance");
  const bodyPayload = valueOf(body.payload, "body");
  if (extrudePayload.target_body != null) throw new Error("extrude names a target body");
  return {
    planeId: uuidOf(plane.id),
    identityPlacement,
    sketchId: uuidOf(sketch.id),
    sketchName: sketch.name ?? "",
    curves,
    extrudeId: uuidOf(extrude.id),
    extrudeName: extrude.name ?? "",
    distanceSource: typeof distance.source === "string" ? distance.source : bad("distance.source"),
    distanceMm: finite(distance.value, "distance.value"),
    reversed: boolField(extrudePayload, "reversed"),
    operation: String(extrudePayload.operation),
    targetBody: null,
    bodyId: uuidOf(body.id),
    bodyName: body.name ?? "",
    tipFeature: uuidOf(asBytes(bodyPayload.tip_feature, "tip_feature")),
  };
}

function valueOf(payload: Uint8Array, expected: string): Record<string, unknown> {
  return cborToValue(embeddedPayload(payload, expected).node) as Record<string, unknown>;
}

function bad(label: string): never {
  throw new Error(`${label}: expected string`);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}: expected f64`);
  return value;
}

function boolField(record: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return false;
  if (typeof record[key] !== "boolean") throw new Error(`${key}: expected bool`);
  return record[key] as boolean;
}

function kindField(value: unknown): string {
  if (typeof value !== "string") throw new Error("geometry.kind: expected string");
  return value;
}

function pointField(record: Record<string, unknown>, label: string): Point {
  return [finite(record.x, `${label}.x`), finite(record.y, `${label}.y`)];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    throw new Error(`${label} is not a map`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function asBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} is not bytes`);
  return value;
}
