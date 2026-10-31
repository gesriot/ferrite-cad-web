import {
  cast,
  draw,
  drawCircle,
  getOC,
  makeBox,
  measureVolume,
  type AnyShape,
  type Shape3D,
} from "replicad";

/** Exact tube used by the proof. Coaxial through-hole, base on z = 0. */
export const TUBE = { radius: 10, hole: 4, height: 20 } as const;

export const EXPECTED_TUBE_VOLUME =
  Math.PI * (TUBE.radius ** 2 - TUBE.hole ** 2) * TUBE.height;

const ANALYTIC = new Set(["PLANE", "CYLINDRE"]);

export type Bounds = { min: [number, number, number]; max: [number, number, number] };

export type Inspect = {
  valid: boolean;
  solidValid: boolean;
  shapeType: string;
  solidType: string;
  solids: number;
  volume: number;
  bounds: Bounds;
  surfaces: Record<string, number>;
  analyticOnly: boolean;
};

export type MeshPayload = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

export function buildTube(): Shape3D {
  const outer = drawCircle(TUBE.radius).sketchOnPlane("XY").extrude(TUBE.height).asShape3D();
  const cutter = drawCircle(TUBE.hole).sketchOnPlane("XY", [0, 0, -1]).extrude(TUBE.height + 2).asShape3D();
  const body = outer.cut(cutter).asShape3D();
  cutter.delete();
  outer.delete();
  return body;
}

/** Second session edit: a radial hole through the wall, not a copy of the input. */
export function cutRadialHole(shape: Shape3D): Shape3D {
  const cutter = drawCircle(3).sketchOnPlane("YZ", [-16, 0, 10]).extrude(32).asShape3D();
  const next = shape.cut(cutter).asShape3D();
  cutter.delete();
  shape.delete();
  return next;
}

export function inspect(shape: Shape3D): Inspect {
  const oc = getOC();
  const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
  const valid = analyzer.IsValid();
  analyzer.delete();
  const solid = shape.solids[0];
  let solidValid = false;
  let solidType = "missing";
  if (solid) {
    const solidAnalyzer = new oc.BRepCheck_Analyzer(solid.wrapped, true, false, false);
    solidValid = solidAnalyzer.IsValid();
    solidAnalyzer.delete();
    solidType = String(solid.wrapped.ShapeType());
  }
  const [min, max] = shape.boundingBox.bounds;
  const surfaces: Record<string, number> = {};
  for (const face of shape.faces) {
    const kind = face.geomType;
    surfaces[kind] = (surfaces[kind] ?? 0) + 1;
  }
  const analyticOnly = Object.keys(surfaces).every((kind) => ANALYTIC.has(kind));
  return {
    valid,
    solidValid,
    shapeType: String(shape.wrapped.ShapeType()),
    solidType,
    solids: shape.solids.length,
    volume: measureVolume(shape),
    bounds: { min: [...min], max: [...max] },
    surfaces,
    analyticOnly,
  };
}

export function inspectSolids(shape: Shape3D): Inspect[] {
  return shape.solids.map((solid) => inspect(solid));
}

export function meshOf(shape: Shape3D): MeshPayload {
  const mesh = shape.mesh({ tolerance: 0.05, angularTolerance: 0.15 });
  return {
    positions: Float32Array.from(mesh.vertices),
    normals: Float32Array.from(mesh.normals),
    indices: Uint32Array.from(mesh.triangles),
  };
}

export async function stepBytes(shape: Shape3D): Promise<Uint8Array> {
  const blob = shape.blobSTEP();
  return new Uint8Array(await blob.arrayBuffer());
}

export async function shapeFromStep(bytes: Uint8Array): Promise<Shape3D> {
  return (await openStep(bytes)).shape;
}

export type StepRead = {
  shape: Shape3D;
  readStatus: string;
  roots: number;
  transferred: number;
  systemLengthUnit: number | null;
  fileLengthUnits: string[];
  fileAngleUnits: string[];
  unitError: string | null;
};

/** A new STEPControl_Reader. Does not reuse a previously imported shape. */
export async function openStep(bytes: Uint8Array): Promise<StepRead> {
  const oc = getOC();
  const name = `in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.step`;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  oc.FS.writeFile(`/${name}`, copy);
  const reader = new oc.STEPControl_Reader();
  let readStatus = "";
  try {
    readStatus = String(reader.ReadFile(name));
    if (readStatus !== "IFSelect_RetDone") {
      throw new Error(`STEP ReadFile returned ${readStatus}`);
    }
    let systemLengthUnit: number | null = null;
    let fileLengthUnits: string[] = [];
    let fileAngleUnits: string[] = [];
    let unitError: string | null = null;
    try {
      systemLengthUnit = reader.SystemLengthUnit();
    } catch (error) {
      unitError = error instanceof Error ? error.message : String(error);
    }
    try {
      const lengths = new oc.NCollection_Sequence_TCollection_AsciiString();
      const angles = new oc.NCollection_Sequence_TCollection_AsciiString();
      const solidAngles = new oc.NCollection_Sequence_TCollection_AsciiString();
      reader.FileUnits(lengths, angles, solidAngles);
      fileLengthUnits = sequenceText(lengths);
      fileAngleUnits = sequenceText(angles);
      lengths.delete();
      angles.delete();
      solidAngles.delete();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unitError = unitError ? `${unitError}; ${message}` : message;
    }
    const roots = reader.NbRootsForTransfer();
    const transferred = reader.TransferRoots();
    const shape = cast(reader.OneShape()).asShape3D();
    return { shape, readStatus, roots, transferred, systemLengthUnit, fileLengthUnits, fileAngleUnits, unitError };
  } finally {
    oc.FS.unlink(`/${name}`);
    reader.delete();
  }
}

function sequenceText(sequence: { Upper: () => number; Value: (index: number) => unknown; Length?: () => number }): string[] {
  const upper = sequence.Upper();
  const out: string[] = [];
  for (let index = 1; index <= upper; index++) out.push(ocString(sequence.Value(index)));
  return out;
}

function ocString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const bag = value as { ToCString?: () => string; String?: () => string; delete?: () => void };
    const text = bag.ToCString?.() ?? bag.String?.();
    bag.delete?.();
    if (typeof text === "string") return text;
  }
  return String(value);
}

/** Rectangular profile on the identity XY plane, extruded along +Z. No stored mesh. */
export function extrudeProfile(curves: { kind: string; start: [number, number]; end: [number, number] }[], height: number): Shape3D {
  if (curves.length < 3) throw new Error(`profile has ${curves.length} curves`);
  for (const curve of curves) {
    if (curve.kind !== "line") throw new Error(`profile curve ${curve.kind} is not a line`);
  }
  let pen = draw().movePointerTo(curves[0]!.start);
  const last = curves[curves.length - 1]!;
  const closes = Math.hypot(last.end[0] - curves[0]!.start[0], last.end[1] - curves[0]!.start[1]) < 1e-9;
  const through = closes ? curves.length - 1 : curves.length;
  for (let i = 0; i < through; i++) pen = pen.lineTo(curves[i]!.end);
  return pen.close().sketchOnPlane("XY").extrude(height).asShape3D();
}

/** Add a box. The input shape is deleted; the result is a new B-rep, not a copy of the STEP bytes. */
export function fuseSlab(shape: Shape3D, min: [number, number, number], max: [number, number, number]): Shape3D {
  const slab = makeBox(min, max);
  const fused: AnyShape = shape.fuse(slab);
  slab.delete();
  shape.delete();
  return fused.asShape3D();
}
