import type { Constraint, Doc, Feature, Point, Sketch } from "./types";

function P(id: string, x: number, y: number): Point {
  return { id, x, y };
}

export function makeSamples(): Doc[] {
  return [flange(), plate(), bracket(), shaft()];
}

function flange(): Doc {
  const parameters = [
    { id: "od", name: "Outside Ø", value: 72, unit: "мм" },
    { id: "bore", name: "Bore Ø", value: 18, unit: "мм" },
    { id: "thick", name: "Thickness", value: 8, unit: "мм" },
    { id: "hubD", name: "Hub Ø", value: 32, unit: "мм" },
    { id: "hubH", name: "Hub Height", value: 10, unit: "мм" },
    { id: "boltD", name: "Bolt Ø", value: 5.5, unit: "мм" },
    { id: "boltN", name: "Bolt Count", value: 6, unit: "шт" },
    { id: "pcd", name: "Bolt Circle", value: 54, unit: "мм" },
  ];
  const disk = circleSketch("sk-disk", "Base Sketch", 0, "c-disk", 36, 9, [
    { id: "fix-disk", type: "fixed", pointId: "c-disk", x: 0, y: 0 },
    { id: "rad-od", type: "radius", loopId: "loop-od", value: 36, ref: { paramId: "od", scale: 0.5 }, display: "diameter" },
    { id: "rad-bore", type: "radius", loopId: "loop-bore", value: 9, ref: { paramId: "bore", scale: 0.5 }, display: "diameter" },
  ]);
  const hub = circleSketch("sk-hub", "Hub Sketch", 7.6, "c-hub", 16, 9, [
    { id: "fix-hub", type: "fixed", pointId: "c-hub", x: 0, y: 0 },
    { id: "rad-hub", type: "radius", loopId: "loop-hub", value: 16, ref: { paramId: "hubD", scale: 0.5 }, display: "diameter" },
    { id: "rad-hub-bore", type: "radius", loopId: "loop-hub-bore", value: 9, ref: { paramId: "bore", scale: 0.5 }, display: "diameter" },
  ]);
  hub.offsetRef = { paramId: "thick", offset: -0.4 };
  const features: Feature[] = [
    {
      id: "solid-flange",
      kind: "solid",
      name: "Base Extrude",
      sketchId: "sk-disk",
      mode: "extrude",
      depth: 8,
      depthRef: { paramId: "thick" },
      symmetric: false,
      flipped: false,
      angle: 360,
      axis: "Y",
      operation: "new",
    },
    {
      id: "solid-hub",
      kind: "solid",
      name: "Hub Extrude",
      sketchId: "sk-hub",
      mode: "extrude",
      depth: 10.4,
      depthRef: { paramId: "hubH", offset: 0.4 },
      symmetric: false,
      flipped: false,
      angle: 360,
      axis: "Y",
      operation: "new",
    },
    {
      id: "hole-bolts",
      kind: "hole",
      name: "Bolt Holes",
      plane: "XY",
      offset: 0,
      travel: -1,
      diameter: 5.5,
      diameterRef: { paramId: "boltD" },
      depth: null,
      places: [
        {
          mode: "pcd",
          cx: 0,
          cy: 0,
          pcd: 54,
          count: 6,
          pcdRef: { paramId: "pcd" },
          countRef: { paramId: "boltN" },
          startDeg: 0,
        },
      ],
    },
  ];
  return { id: "doc-flange", name: "Flange", unit: "mm", parameters, sketches: [disk, hub], features };
}

function circleSketch(
  id: string,
  name: string,
  offset: number,
  centerId: string,
  outerR: number,
  innerR: number,
  constraints: Constraint[],
): Sketch {
  return {
    id,
    name,
    plane: "XY",
    offset,
    points: [P(centerId, 0, 0)],
    loops: [
      { id: id === "sk-hub" ? "loop-hub" : "loop-od", kind: "circle", centerId, radius: outerR },
      { id: id === "sk-hub" ? "loop-hub-bore" : "loop-bore", kind: "circle", centerId, radius: innerR },
    ],
    constraints,
  };
}

function plate(): Doc {
  const parameters = [
    { id: "len", name: "Length", value: 90, unit: "мм" },
    { id: "wid", name: "Width", value: 56, unit: "мм" },
    { id: "thick", name: "Thickness", value: 8, unit: "мм" },
    { id: "fil", name: "Fillet", value: 6, unit: "мм" },
    { id: "hd", name: "Hole Ø", value: 7, unit: "мм" },
    { id: "ix", name: "Inset X", value: 16, unit: "мм" },
    { id: "iy", name: "Inset Y", value: 14, unit: "мм" },
  ];
  const sketch: Sketch = {
    id: "sk-plate",
    name: "Sketch",
    plane: "XY",
    offset: 0,
    points: [P("p0", -45, -28), P("p1", 45, -28), P("p2", 45, 28), P("p3", -45, 28)],
    loops: [{ id: "loop-plate", kind: "poly", pointIds: ["p0", "p1", "p2", "p3"] }],
    constraints: [
      { id: "h0", type: "h", a: "p0", b: "p1" },
      { id: "v1", type: "v", a: "p1", b: "p2" },
      { id: "h2", type: "h", a: "p2", b: "p3" },
      { id: "v3", type: "v", a: "p3", b: "p0" },
      { id: "dw", type: "dist", a: "p0", b: "p1", value: 90, ref: { paramId: "len" } },
      { id: "dh", type: "dist", a: "p0", b: "p3", value: 56, ref: { paramId: "wid" } },
      { id: "sx", type: "sum0", axis: "x", a: "p0", b: "p1" },
      { id: "sy", type: "sum0", axis: "y", a: "p0", b: "p3" },
    ],
  };
  const features: Feature[] = [
    {
      id: "solid-plate",
      kind: "solid",
      name: "Extrude",
      sketchId: "sk-plate",
      mode: "extrude",
      depth: 8,
      depthRef: { paramId: "thick" },
      symmetric: false,
      flipped: false,
      angle: 360,
      axis: "Y",
      operation: "new",
    },
    {
      id: "fil-plate",
      kind: "fillet",
      name: "Fillet",
      targetId: "solid-plate",
      radius: 6,
      radiusRef: { paramId: "fil" },
    },
    {
      id: "hole-plate",
      kind: "hole",
      name: "Holes",
      plane: "XY",
      offset: 0,
      travel: -1,
      diameter: 7,
      diameterRef: { paramId: "hd" },
      depth: null,
      places: ([-1, 1] as const).flatMap((sx) =>
        ([-1, 1] as const).map((sy) => ({
          mode: "inset" as const,
          sketchId: "sk-plate",
          sx,
          sy,
          insetX: 16,
          insetY: 14,
          insetXRef: { paramId: "ix" },
          insetYRef: { paramId: "iy" },
        })),
      ),
    },
  ];
  return { id: "doc-plate", name: "Plate", unit: "mm", parameters, sketches: [sketch], features };
}

function bracket(): Doc {
  const parameters = [
    { id: "len", name: "Length", value: 70, unit: "мм" },
    { id: "ht", name: "Height", value: 52, unit: "мм" },
    { id: "leg", name: "Leg", value: 16, unit: "мм" },
    { id: "thick", name: "Thickness", value: 8, unit: "мм" },
    { id: "fil", name: "Fillet", value: 3, unit: "мм" },
    { id: "hd", name: "Hole Ø", value: 6.5, unit: "мм" },
  ];
  const sketch: Sketch = {
    id: "sk-br",
    name: "Sketch",
    plane: "XY",
    offset: 0,
    points: [P("a", 0, 0), P("b", 70, 0), P("c", 70, 16), P("d", 16, 16), P("e", 16, 52), P("f", 0, 52)],
    loops: [{ id: "loop-br", kind: "poly", pointIds: ["a", "b", "c", "d", "e", "f"] }],
    constraints: [
      { id: "fix", type: "fixed", pointId: "a", x: 0, y: 0 },
      { id: "h-ab", type: "h", a: "a", b: "b" },
      { id: "v-bc", type: "v", a: "b", b: "c" },
      { id: "h-cd", type: "h", a: "c", b: "d" },
      { id: "v-de", type: "v", a: "d", b: "e" },
      { id: "h-ef", type: "h", a: "e", b: "f" },
      { id: "v-fa", type: "v", a: "f", b: "a" },
      { id: "d-len", type: "dist", a: "a", b: "b", value: 70, ref: { paramId: "len" } },
      { id: "d-ht", type: "dist", a: "a", b: "f", value: 52, ref: { paramId: "ht" } },
      { id: "d-leg", type: "dist", a: "b", b: "c", value: 16, ref: { paramId: "leg" } },
      { id: "eq", type: "equal", a: "b", b: "c", c: "e", d: "f" },
    ],
  };
  const features: Feature[] = [
    {
      id: "solid-br",
      kind: "solid",
      name: "Extrude",
      sketchId: "sk-br",
      mode: "extrude",
      depth: 8,
      depthRef: { paramId: "thick" },
      symmetric: false,
      flipped: false,
      angle: 360,
      axis: "Y",
      operation: "new",
    },
    { id: "fil-br", kind: "fillet", name: "Fillet", targetId: "solid-br", radius: 3, radiusRef: { paramId: "fil" } },
    {
      id: "hole-br",
      kind: "hole",
      name: "Holes",
      plane: "XY",
      offset: 0,
      travel: -1,
      diameter: 6.5,
      diameterRef: { paramId: "hd" },
      depth: null,
      places: [
        { mode: "abs", x: 52, y: 8, xRef: { paramId: "len", offset: -18 }, yRef: { paramId: "leg", scale: 0.5 } },
        { mode: "abs", x: 8, y: 36, xRef: { paramId: "leg", scale: 0.5 }, yRef: { paramId: "ht", offset: -16 } },
      ],
    },
  ];
  return { id: "doc-br", name: "Bracket", unit: "mm", parameters, sketches: [sketch], features };
}

function shaft(): Doc {
  const len = 100;
  const r1 = 8;
  const r2 = 14;
  const c0 = 36;
  const c1 = 56;
  const parameters = [
    { id: "len", name: "Length", value: len, unit: "мм" },
    { id: "d1", name: "Neck Ø", value: r1 * 2, unit: "мм" },
    { id: "d2", name: "Collar Ø", value: r2 * 2, unit: "мм" },
    { id: "c0", name: "Collar From", value: c0, unit: "мм" },
    { id: "c1", name: "Collar To", value: c1, unit: "мм" },
    { id: "fil", name: "Fillet", value: 1.2, unit: "мм" },
  ];
  const ids = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"] as const;
  const sketch: Sketch = {
    id: "sk-shaft",
    name: "Profile",
    plane: "XY",
    offset: r2,
    offsetRef: { paramId: "d2", scale: 0.5 },
    points: [
      P("s0", 0, 0),
      P("s1", r1, 0),
      P("s2", r1, c0),
      P("s3", r2, c0),
      P("s4", r2, c1),
      P("s5", r1, c1),
      P("s6", r1, len),
      P("s7", 0, len),
    ],
    loops: [{ id: "loop-shaft", kind: "poly", pointIds: [...ids] }],
    constraints: [
      { id: "fix0", type: "fixed", pointId: "s0", x: 0, y: 0 },
      { id: "s1x", type: "coord", pointId: "s1", axis: "x", value: r1, ref: { paramId: "d1", scale: 0.5 } },
      { id: "s1y", type: "coord", pointId: "s1", axis: "y", value: 0 },
      { id: "s2x", type: "coord", pointId: "s2", axis: "x", value: r1, ref: { paramId: "d1", scale: 0.5 } },
      { id: "s2y", type: "coord", pointId: "s2", axis: "y", value: c0, ref: { paramId: "c0" } },
      { id: "s3x", type: "coord", pointId: "s3", axis: "x", value: r2, ref: { paramId: "d2", scale: 0.5 } },
      { id: "s3y", type: "coord", pointId: "s3", axis: "y", value: c0, ref: { paramId: "c0" } },
      { id: "s4x", type: "coord", pointId: "s4", axis: "x", value: r2, ref: { paramId: "d2", scale: 0.5 } },
      { id: "s4y", type: "coord", pointId: "s4", axis: "y", value: c1, ref: { paramId: "c1" } },
      { id: "s5x", type: "coord", pointId: "s5", axis: "x", value: r1, ref: { paramId: "d1", scale: 0.5 } },
      { id: "s5y", type: "coord", pointId: "s5", axis: "y", value: c1, ref: { paramId: "c1" } },
      { id: "s6x", type: "coord", pointId: "s6", axis: "x", value: r1, ref: { paramId: "d1", scale: 0.5 } },
      { id: "s6y", type: "coord", pointId: "s6", axis: "y", value: len, ref: { paramId: "len" } },
      { id: "s7x", type: "coord", pointId: "s7", axis: "x", value: 0 },
      { id: "s7y", type: "coord", pointId: "s7", axis: "y", value: len, ref: { paramId: "len" } },
    ],
  };
  const features: Feature[] = [
    {
      id: "solid-shaft",
      kind: "solid",
      name: "Revolve",
      sketchId: "sk-shaft",
      mode: "revolve",
      depth: 10,
      symmetric: false,
      flipped: false,
      angle: 360,
      axis: "Y",
      operation: "new",
    },
    { id: "fil-shaft", kind: "fillet", name: "Fillet", targetId: "solid-shaft", radius: 1.2, radiusRef: { paramId: "fil" } },
  ];
  return { id: "doc-shaft", name: "Shaft", unit: "mm", parameters, sketches: [sketch], features };
}
