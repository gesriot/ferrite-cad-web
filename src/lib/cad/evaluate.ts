import { solveSketch } from "./solver.ts";
import { resolveRef, type Constraint, type Doc, type Feature, type HolePlace, type Parameter, type Sketch, type SolveReport } from "./types.ts";

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function concreteConstraints(constraints: Constraint[], params: Parameter[]): Constraint[] {
  return constraints.map((c) => {
    if (c.type === "dist" || c.type === "radius" || c.type === "coord") {
      return { ...c, value: resolveRef(c.value, c.ref, params), ref: undefined };
    }
    return c;
  });
}

function concreteSketch(sketch: Sketch, params: Parameter[]): Sketch {
  return {
    ...sketch,
    offset: resolveRef(sketch.offset, sketch.offsetRef, params),
    offsetRef: undefined,
    points: sketch.points.map((p) => ({ ...p })),
    loops: sketch.loops.map((l) => ({ ...l })),
    constraints: concreteConstraints(sketch.constraints, params),
  };
}

function concretePlace(place: HolePlace, params: Parameter[]): HolePlace {
  if (place.mode === "abs") {
    return {
      mode: "abs",
      x: resolveRef(place.x, place.xRef, params),
      y: resolveRef(place.y, place.yRef, params),
    };
  }
  if (place.mode === "pcd") {
    return {
      mode: "pcd",
      cx: place.cx,
      cy: place.cy,
      pcd: Math.max(0, resolveRef(place.pcd, place.pcdRef, params)),
      count: clamp(Math.round(resolveRef(place.count, place.countRef, params)), 1, 36),
      startDeg: place.startDeg ?? 0,
    };
  }
  return {
    mode: "inset",
    sketchId: place.sketchId,
    sx: place.sx,
    sy: place.sy,
    insetX: resolveRef(place.insetX, place.insetXRef, params),
    insetY: resolveRef(place.insetY, place.insetYRef, params),
  };
}

function concreteFeature(feature: Feature, params: Parameter[]): Feature {
  if (feature.kind === "solid") {
    return {
      ...feature,
      depth: Math.max(0.05, resolveRef(feature.depth, feature.depthRef, params)),
      depthRef: undefined,
      angle: clamp(feature.angle, 0.1, 360),
    };
  }
  if (feature.kind === "hole") {
    const depth = feature.depth == null ? null : Math.max(0.1, resolveRef(feature.depth, feature.depthRef, params));
    return {
      ...feature,
      diameter: Math.max(0.2, resolveRef(feature.diameter, feature.diameterRef, params)),
      diameterRef: undefined,
      depth,
      depthRef: undefined,
      offset: resolveRef(feature.offset, undefined, params),
      places: feature.places.map((p) => concretePlace(p, params)),
    };
  }
  if (feature.kind === "fillet") {
    return {
      ...feature,
      radius: Math.max(0, resolveRef(feature.radius, feature.radiusRef, params)),
      radiusRef: undefined,
    };
  }
  return {
    ...feature,
    distance: Math.max(0, resolveRef(feature.distance, feature.distanceRef, params)),
    distanceRef: undefined,
  };
}

export function mergeSolved(original: Sketch, solved: Sketch): Sketch {
  const pos = new Map(solved.points.map((p) => [p.id, p]));
  return {
    ...original,
    points: original.points.map((p) => {
      const s = pos.get(p.id);
      return s ? { ...p, x: s.x, y: s.y } : p;
    }),
    loops: original.loops.map((loop) => {
      if (loop.kind !== "circle") return loop;
      const s = solved.loops.find((l) => l.id === loop.id);
      return s && s.kind === "circle" ? { ...loop, radius: s.radius } : loop;
    }),
  };
}

export function evaluate(
  doc: Doc,
  extra?: { sketchId: string; pins: { id: string; x: number; y: number }[] },
): { doc: Doc; reports: Record<string, SolveReport> } {
  const reports: Record<string, SolveReport> = {};
  const sketches = doc.sketches.map((sketch) => {
    const concrete = concreteSketch(sketch, doc.parameters);
    const pins = extra?.sketchId === sketch.id ? extra.pins : [];
    const solved = solveSketch(concrete, pins);
    reports[sketch.id] = solved.report;
    return solved.report.status === "conflict" ? concrete : solved.sketch;
  });
  return {
    doc: {
      ...doc,
      sketches,
      features: doc.features.map((f) => concreteFeature(f, doc.parameters)),
    },
    reports,
  };
}

export function hasConflict(reports: Record<string, SolveReport>): boolean {
  return Object.values(reports).some((r) => r.status === "conflict");
}
