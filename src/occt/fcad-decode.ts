import { isUuidV7, requireUuidV7, uuidOf, type Point, type SketchCurve } from "./fcad.ts";

/**
 * Strict decoder for the payloads this build claims to understand.
 * Absence, null and a wrong type are not the same thing. Defaults exist only
 * where the Rust schema has `#[serde(default)]`. No Number/String/Boolean coercion.
 * A throw is invalid. `outsideSlice` means the value decoded and is not editable.
 * `Option` fields are None when absent or null. `#[serde(default)]` is a
 * separate rule and is not applied to a present value of the wrong type.
 */

const CORE = "core.part.v1";
const OPERATIONS = ["new_body", "add", "cut", "intersect"] as const;
const END_KINDS = ["blind", "symmetric", "through_all", "up_to_face", "up_to_vertex"] as const;
const GEOMETRIES = ["line", "point", "circle", "arc"] as const;
const CAP_SIDES = ["start", "end"] as const;
const SELECTORS = ["at", "start", "end", "center"] as const;
const ENTITY_KINDS = ["face", "edge", "vertex"] as const;
const SELECTIONS = ["exact", "all_derived_from"] as const;
const CONSTRAINTS = [
  "coincident",
  "fixed",
  "distance",
  "horizontal",
  "vertical",
  "equal_length",
  "perpendicular",
  "parallel",
  "radius",
  "directed_angle",
  "collinear",
] as const;

const ROLES: Record<string, { kind: (typeof ENTITY_KINDS)[number] | null; slice: boolean }> = {
  sketch_segment: { kind: null, slice: false },
  extrude_cap: { kind: "face", slice: true },
  extrude_side: { kind: "face", slice: true },
  extrude_cap_edge: { kind: "edge", slice: false },
  extrude_sweep_edge: { kind: "edge", slice: false },
  extrude_cap_vertex: { kind: "vertex", slice: false },
  fillet_face: { kind: "face", slice: false },
  edge_fillet_face: { kind: "face", slice: false },
  edge_chamfer_face: { kind: "face", slice: false },
  carried_cap: { kind: "face", slice: false },
  carried_side: { kind: "face", slice: false },
  origin_cap: { kind: "face", slice: false },
  origin_side: { kind: "face", slice: false },
  origin_fillet_face: { kind: "face", slice: false },
  revolve_face: { kind: "face", slice: false },
  revolve_cap: { kind: "face", slice: false },
};

export const TOPOLOGY_CAPS = new Set([
  CORE,
  "topology.extrude-cap-edge.v1",
  "topology.extrude-sweep-edge.v1",
  "topology.extrude-cap-vertex.v1",
  "topology.carried-face.v1",
  "topology.origin-face.v1",
]);

export type DecodedPlane = { rows: number[][] };
export type DecodedSketch = { plane: Uint8Array; curves: SketchCurve[]; constraints: number };
export type DecodedExtrude = {
  profile: Uint8Array;
  reversed: boolean;
  operation: (typeof OPERATIONS)[number];
  endKind: (typeof END_KINDS)[number];
  distanceSource: string | null;
  distanceValue: number | null;
  target: Uint8Array | null;
  previous: Uint8Array | null;
};
export type DecodedBody = { tip: Uint8Array | null };
export type DecodedTopology = { entityKind: string | null; outsideSlice: boolean };
type ConstraintVocab = { version: number; caps: string[] };

export function decodePlane(inner: unknown): DecodedPlane {
  const record = asRecord(inner, "plane");
  const placement = asRecord(required(record, "placement", "placement"), "placement");
  const rows = required(placement, "rows", "placement.rows");
  if (!Array.isArray(rows) || rows.length !== 3) throw new Error("placement.rows: expected 3x4 f64");
  const parsed = rows.map((row) => {
    if (!Array.isArray(row) || row.length !== 4) throw new Error("placement.rows: expected 3x4 f64");
    return row.map((cell) => finite(cell, "placement"));
  });
  return { rows: parsed };
}

export function decodeSketch(inner: unknown): DecodedSketch {
  const record = asRecord(inner, "sketch");
  const plane = blob(required(record, "plane", "sketch.plane"), "sketch.plane");
  const curves = decodeCurves(required(record, "curves", "curves"));
  const constraints = decodeConstraints(record);
  return { plane, curves, constraints: constraints.length };
}

export function sketchContract(schema: number, caps: string[], rules: ConstraintVocab): void {
  if (schema !== rules.version || caps.join("|") !== rules.caps.join("|")) {
    throw new Error(
      `a sketch holding constraints belongs at schema v${rules.version} requiring ${rules.caps.join(", ")}, but its envelope says schema v${schema} requiring ${caps.join(", ") || "none"}`,
    );
  }
}

export function constraintContractOf(inner: unknown): ConstraintVocab {
  const record = asRecord(inner, "sketch");
  const rules = decodeConstraints(record);
  if (rules.length === 0) return { version: 1, caps: [CORE] };
  if (rules.some((rule) => rule.kind === "collinear")) {
    return { version: 5, caps: [CORE, "sketch.constraints.v1", "sketch.constraints.collinear.v1"] };
  }
  if (rules.some((rule) => rule.kind === "directed_angle")) {
    return { version: 4, caps: [CORE, "sketch.constraints.v1", "sketch.constraints.angle.v1"] };
  }
  if (rules.some((rule) => rule.circle)) {
    return { version: 3, caps: [CORE, "sketch.constraints.v1", "sketch.constraints.circle.v1"] };
  }
  return { version: 2, caps: [CORE, "sketch.constraints.v1"] };
}

export function decodeExtrude(inner: unknown): DecodedExtrude {
  const record = asRecord(inner, "extrude");
  const profile = blob(required(record, "profile", "profile"), "profile");
  const reversed = optionalBool(record, "reversed", "reversed");
  const operation = enumField(required(record, "operation", "operation"), OPERATIONS, "operation");
  const end = asRecord(required(record, "end_condition", "end_condition"), "end_condition");
  const endKind = enumField(required(end, "kind", "end_condition.kind"), END_KINDS, "end_condition.kind");
  let distanceSource: string | null = null;
  let distanceValue: number | null = null;
  if (endKind === "blind" || endKind === "symmetric") {
    const distance = asRecord(required(end, "distance", "distance"), "distance");
    distanceSource = text(required(distance, "source", "distance.source"), "distance.source");
    distanceValue = finite(required(distance, "value", "distance.value"), "distance.value");
  }
  if (endKind === "up_to_face" || endKind === "up_to_vertex") {
    if (!(end.result instanceof Uint8Array)) throw new Error("up_to result must be UUID");
    if (endKind === "up_to_face" && !end.face) throw new Error("up_to_face requires face");
    if (endKind === "up_to_vertex" && !end.vertex) throw new Error("up_to_vertex requires vertex");
  }
  const target = optionalBlob(record, "target_body", "target_body");
  const previous = optionalBlob(record, "previous", "previous");
  return { profile, reversed, operation, endKind, distanceSource, distanceValue, target, previous };
}

export function extrudeContract(schema: number, caps: string[], decoded: DecodedExtrude): void {
  const version = decoded.previous && decoded.endKind === "through_all" ? 3 : decoded.previous ? 2 : 1;
  const expected =
    version === 3
      ? [CORE, "feature.predecessor.v1", "feature.through-all.v1"]
      : version === 2
        ? [CORE, "feature.predecessor.v1"]
        : [CORE];
  if (schema !== version || caps.join("|") !== expected.join("|")) {
    throw new Error(
      `feature.extrude belongs at schema v${version} requiring ${expected.join(", ")}, but its envelope says schema v${schema} requiring ${caps.join(", ") || "none"}`,
    );
  }
}

export function decodeBody(inner: unknown): DecodedBody {
  const record = asRecord(inner, "body");
  return { tip: optionalBlob(record, "tip_feature", "tip_feature") };
}

export function decodeTopology(inner: unknown): DecodedTopology {
  const record = asRecord(inner, "topology");
  const role = asRecord(required(record, "output_role", "output_role"), "output_role");
  const name = enumField(required(role, "role", "output_role.role"), Object.keys(ROLES), "output_role.role");
  decodeRole(name, role);
  decodeSelection(required(record, "selection", "selection"));
  const fallback = Object.prototype.hasOwnProperty.call(record, "fallback_signature") ? record.fallback_signature : null;
  let outside = !ROLES[name]!.slice;
  if (fallback !== null) {
    decodeSignature(fallback);
    outside = true;
  }
  return { entityKind: ROLES[name]!.kind, outsideSlice: outside };
}

function decodeRole(name: string, role: Record<string, unknown>) {
  const side = () => {
    const value = required(role, "side", "output_role.side");
    if (typeof value !== "string") throw new Error("output_role.side: expected enum");
    if (!CAP_SIDES.includes(value as (typeof CAP_SIDES)[number])) {
      throw new Error(`unknown variant \`${value}\`, expected \`start\` or \`end\``);
    }
  };
  const segment = (key: string) => uuidBlob(required(role, key, key), key);
  const joint = () => {
    const value = required(role, "joint", "joint");
    if (!Array.isArray(value) || value.length !== 2) throw new Error("joint: expected array");
    const pair = value.map((item, index) => uuidBlob(item, `joint[${index}]`));
    if (pair[0]! >= pair[1]!) throw new Error("a stored profile joint names its segments in canonical order");
  };
  if (name === "sketch_segment") segment("segment");
  else if (name === "extrude_cap" || name === "carried_cap" || name === "revolve_cap") side();
  else if (name === "extrude_side" || name === "carried_side" || name === "revolve_face") segment("profile_segment");
  else if (name === "extrude_cap_edge") {
    side();
    segment("profile_segment");
  } else if (name === "extrude_sweep_edge") joint();
  else if (name === "extrude_cap_vertex") {
    side();
    joint();
  } else if (name === "fillet_face") segment("source_edge");
  else if (name === "edge_fillet_face" || name === "edge_chamfer_face") {
    uuidBlob(required(role, "edge_feature", "edge_feature"), "edge_feature");
    joint();
  } else if (name === "origin_cap") {
    uuidBlob(required(role, "origin_feature", "origin_feature"), "origin_feature");
    side();
  } else if (name === "origin_side") {
    uuidBlob(required(role, "origin_feature", "origin_feature"), "origin_feature");
    segment("profile_segment");
  } else if (name === "origin_fillet_face") {
    uuidBlob(required(role, "origin_feature", "origin_feature"), "origin_feature");
    uuidBlob(required(role, "edge_feature", "edge_feature"), "edge_feature");
    joint();
  }
}

function decodeSelection(value: unknown) {
  const record = asRecord(value, "selection");
  const rule = enumField(required(record, "rule", "selection.rule"), SELECTIONS, "selection.rule");
  if (rule === "all_derived_from") uuidBlob(required(record, "ancestor", "ancestor"), "ancestor");
}

function decodeSignature(value: unknown) {
  if (value === null) return;
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    throw new Error(`invalid type: ${typeName(value)}, expected map`);
  }
  const record = value as Record<string, unknown>;
  enumField(required(record, "kind", "fallback_signature.kind"), ENTITY_KINDS, "fallback_signature.kind");
  const measure = finite(required(record, "measure", "measure"), "measure");
  if (measure < 0) throw new Error("geometric signature measure must not be negative");
  const centroid = asRecord(required(record, "centroid", "centroid"), "centroid");
  finite(required(centroid, "x", "centroid.x"), "centroid.x");
  finite(required(centroid, "y", "centroid.y"), "centroid.y");
  finite(required(centroid, "z", "centroid.z"), "centroid.z");
}

function decodeCurves(value: unknown): SketchCurve[] {
  if (!Array.isArray(value)) throw new Error("curves: expected array");
  return value.map((curve) => {
    const item = asRecord(curve, "curve");
    const id = uuidBlob(required(item, "id", "curve.id"), "curve.id");
    const construction = optionalBool(item, "construction", "construction");
    const geometry = asRecord(required(item, "geometry", "geometry"), "geometry");
    const kind = enumField(required(geometry, "kind", "geometry.kind"), GEOMETRIES, "geometry.kind");
    if (kind === "line") {
      const start = point2(required(geometry, "start", "start"), "start");
      const end = point2(required(geometry, "end", "end"), "end");
      return { id, construction, kind, start, end };
    }
    if (kind === "point") point2(required(geometry, "at", "at"), "at");
    if (kind === "circle") {
      point2(required(geometry, "center", "center"), "center");
      positive(required(geometry, "radius", "radius"), "circle radius");
    }
    if (kind === "arc") {
      point2(required(geometry, "center", "center"), "center");
      positive(required(geometry, "radius", "radius"), "arc radius");
      finite(required(geometry, "start_angle", "start_angle"), "start_angle");
      finite(required(geometry, "end_angle", "end_angle"), "end_angle");
    }
    return { id, construction, kind, start: [0, 0] as Point, end: [1, 0] as Point };
  });
}

function decodeConstraints(record: Record<string, unknown>): { kind: string; circle: boolean }[] {
  if (!Object.prototype.hasOwnProperty.call(record, "constraints")) return [];
  const value = record.constraints;
  if (!Array.isArray(value)) throw new Error(`invalid type: ${typeName(value)}, expected array`);
  return value.map((item) => {
    const constraint = asRecord(item, "constraint");
    uuidBlob(required(constraint, "id", "constraint.id"), "constraint.id");
    const rule = asRecord(required(constraint, "rule", "rule"), "rule");
    const kind = enumField(required(rule, "kind", "rule.kind"), CONSTRAINTS, "rule.kind");
    let circle = kind === "radius";
    const point = (key: string) => {
      const ref = asRecord(required(rule, key, key), key);
      uuidBlob(required(ref, "curve", `${key}.curve`), `${key}.curve`);
      const at = enumField(required(ref, "at", `${key}.at`), SELECTORS, `${key}.at`);
      if (at === "center") circle = true;
    };
    const segment = (key: string) => {
      const ref = asRecord(required(rule, key, key), key);
      for (const end of ["from", "to"] as const) {
        const at = asRecord(required(ref, end, `${key}.${end}`), `${key}.${end}`);
        uuidBlob(required(at, "curve", `${key}.${end}.curve`), `${key}.${end}.curve`);
        const selector = enumField(required(at, "at", `${key}.${end}.at`), SELECTORS, `${key}.${end}.at`);
        if (selector === "center") circle = true;
      }
    };
    if (kind === "fixed") {
      point("point");
      finite(required(rule, "x", "fixed.x"), "fixed.x");
      finite(required(rule, "y", "fixed.y"), "fixed.y");
    } else if (kind === "distance") {
      point("a");
      point("b");
      positive(required(rule, "distance", "distance"), "constraint distance");
    } else if (kind === "radius") {
      uuidBlob(required(rule, "curve", "curve"), "curve");
      positive(required(rule, "radius", "radius"), "constraint radius");
    } else if (kind === "directed_angle") {
      segment("a");
      segment("b");
      const angle = finite(required(rule, "angle", "angle"), "angle");
      if (angle <= -Math.PI || angle > Math.PI) throw new Error("a directed angle is canonical in (-pi, pi] radians");
    } else if (kind === "equal_length" || kind === "perpendicular" || kind === "parallel" || kind === "collinear") {
      segment("a");
      segment("b");
    } else {
      point("a");
      point("b");
    }
    return { kind, circle };
  });
}

function point2(value: unknown, label: string): Point {
  const record = asRecord(value, label);
  return [finite(required(record, "x", `${label}.x`), `${label}.x`), finite(required(record, "y", `${label}.y`), `${label}.y`)];
}

function optionalBool(record: Record<string, unknown>, key: string, label: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return false;
  if (typeof record[key] !== "boolean") throw new Error(`${label}: expected bool`);
  return record[key] as boolean;
}

function optionalBlob(record: Record<string, unknown>, key: string, label: string): Uint8Array | null {
  if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] == null) return null;
  return blob(record[key], label);
}

function required(record: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`missing ${label}`);
  return record[key];
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}: expected f64`);
  return Object.is(value, -0) ? 0 : value;
}

function positive(value: unknown, label: string): number {
  const number = finite(value, label);
  if (!(number > 0)) throw new Error(`${label} must be positive`);
  return number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}: expected string`);
  return value;
}

function enumField<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label}: expected enum`);
  return value as T;
}

function blob(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} is not a BLOB`);
  return value;
}

function uuidBlob(value: unknown, label: string): string {
  const bytes = blob(value, label);
  if (!isUuidV7(bytes)) {
    const shown = bytes.byteLength === 16 ? uuidOf(bytes) : `${bytes.byteLength} bytes`;
    throw new Error(`ObjectId must be an RFC 4122 UUIDv7, found ${shown}`);
  }
  return requireUuidV7(bytes, label);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    throw new Error(`${label} is not a CBOR map`);
  }
  return value as Record<string, unknown>;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "text";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "bytes";
  return typeof value;
}
