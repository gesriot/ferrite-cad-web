export type Plane = "XY" | "XZ" | "YZ";
export type Axis = "X" | "Y";

export type Parameter = {
  id: string;
  name: string;
  value: number;
  /** "мм" | "°" | "шт" */
  unit: string;
};

export type ParamRef = { paramId: string; scale?: number; offset?: number };

export type Point = { id: string; x: number; y: number };

export type Loop =
  | { id: string; kind: "poly"; pointIds: string[] }
  | { id: string; kind: "circle"; centerId: string; radius: number };

export type Constraint =
  | { id: string; type: "fixed"; pointId: string; x: number; y: number }
  | { id: string; type: "h"; a: string; b: string }
  | { id: string; type: "v"; a: string; b: string }
  | { id: string; type: "dist"; a: string; b: string; value: number; ref?: ParamRef }
  | { id: string; type: "radius"; loopId: string; value: number; ref?: ParamRef; display?: "radius" | "diameter" }
  | { id: string; type: "equal"; a: string; b: string; c: string; d: string }
  | { id: string; type: "parallel"; a: string; b: string; c: string; d: string }
  | { id: string; type: "perp"; a: string; b: string; c: string; d: string }
  | { id: string; type: "coincident"; a: string; b: string }
  | { id: string; type: "sum0"; axis: "x" | "y"; a: string; b: string }
  | { id: string; type: "coord"; pointId: string; axis: "x" | "y"; value: number; ref?: ParamRef };

export type Sketch = {
  id: string;
  name: string;
  plane: Plane;
  offset: number;
  offsetRef?: ParamRef;
  points: Point[];
  loops: Loop[];
  constraints: Constraint[];
};

export type SolidFeature = {
  id: string;
  kind: "solid";
  name: string;
  sketchId: string;
  mode: "extrude" | "revolve";
  depth: number;
  depthRef?: ParamRef;
  symmetric: boolean;
  flipped: boolean;
  angle: number;
  axis: Axis;
  operation: "new" | "join" | "cut";
};

export type HolePlace =
  | { mode: "abs"; x: number; y: number; xRef?: ParamRef; yRef?: ParamRef }
  | {
      mode: "pcd";
      cx: number;
      cy: number;
      pcd: number;
      count: number;
      pcdRef?: ParamRef;
      countRef?: ParamRef;
      startDeg?: number;
    }
  | {
      mode: "inset";
      sketchId: string;
      sx: -1 | 1;
      sy: -1 | 1;
      insetX: number;
      insetY: number;
      insetXRef?: ParamRef;
      insetYRef?: ParamRef;
    };

export type HoleFeature = {
  id: string;
  kind: "hole";
  name: string;
  plane: Plane;
  offset: number;
  /** +1 travels along the plane normal into the material, -1 against it. */
  travel: 1 | -1;
  diameter: number;
  diameterRef?: ParamRef;
  /** null = through all */
  depth: number | null;
  depthRef?: ParamRef;
  places: HolePlace[];
};

export type FilletFeature = {
  id: string;
  kind: "fillet";
  name: string;
  targetId: string;
  radius: number;
  radiusRef?: ParamRef;
};

export type ChamferFeature = {
  id: string;
  kind: "chamfer";
  name: string;
  targetId: string;
  distance: number;
  distanceRef?: ParamRef;
};

export type Feature = SolidFeature | HoleFeature | FilletFeature | ChamferFeature;

export type Doc = {
  id: string;
  name: string;
  unit: "mm";
  parameters: Parameter[];
  sketches: Sketch[];
  features: Feature[];
};

export type SolveStatus = "defined" | "under" | "conflict";

export type SolveReport = {
  status: SolveStatus;
  dof: number;
  error: number;
};

export type Sel =
  | { kind: "sketch"; id: string }
  | { kind: "feature"; id: string }
  | { kind: "point"; sketchId: string; pointId: string }
  | { kind: "edge"; sketchId: string; loopId: string; index: number };

export type Tool = "select" | "rect" | "circle" | "poly" | "hole";

export type Vec2 = { x: number; y: number };

export function uid(prefix = "id"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 5)}`;
}

export function resolveRef(fallback: number, ref: ParamRef | undefined, params: Parameter[]): number {
  if (!ref) return fallback;
  const p = params.find((q) => q.id === ref.paramId);
  if (!p || !Number.isFinite(p.value)) return fallback;
  const scale = ref.scale ?? 1;
  const offset = ref.offset ?? 0;
  return p.value * scale + offset;
}

export function paramIdOf(ref: ParamRef | undefined): string | undefined {
  return ref?.paramId;
}
