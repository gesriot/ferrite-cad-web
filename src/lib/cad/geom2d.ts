import type { Loop, Sketch, Vec2 } from "./types";

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function mul(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

export function snap(v: number, step: number): number {
  if (step <= 0) return v;
  return Math.round(v / step) * step;
}

export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function ensureCCW(pts: Vec2[]): Vec2[] {
  return signedArea(pts) < 0 ? pts.slice().reverse() : pts.slice();
}

export function ensureCW(pts: Vec2[]): Vec2[] {
  return signedArea(pts) > 0 ? pts.slice().reverse() : pts.slice();
}

export function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const hit = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y + 1e-18) + a.x;
    if (hit) inside = !inside;
  }
  return inside;
}

export function cleanPoly(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(prev.x - p.x, prev.y - p.y) > 1e-6) out.push({ x: p.x, y: p.y });
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) out.pop();
  }
  return out;
}

function cornerArc(
  prev: Vec2,
  curr: Vec2,
  next: Vec2,
  radius: number,
  poly: Vec2[],
  samples: number,
): Vec2[] | null {
  const e1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
  const e2 = Math.hypot(next.x - curr.x, next.y - curr.y);
  if (e1 < 1e-6 || e2 < 1e-6) return null;
  const v1 = { x: (prev.x - curr.x) / e1, y: (prev.y - curr.y) / e1 };
  const v2 = { x: (next.x - curr.x) / e2, y: (next.y - curr.y) / e2 };
  const dot = clamp(v1.x * v2.x + v1.y * v2.y, -1, 1);
  const angle = Math.acos(dot);
  if (angle < 0.14 || Math.abs(Math.PI - angle) < 0.08) return null;
  const maxDist = Math.min(e1, e2) * 0.45;
  const dist = Math.min(radius / Math.tan(angle / 2), maxDist);
  if (dist < 0.05) return null;
  const r = dist * Math.tan(angle / 2);
  const p1 = { x: curr.x + v1.x * dist, y: curr.y + v1.y * dist };
  const p2 = { x: curr.x + v2.x * dist, y: curr.y + v2.y * dist };
  const bisLen = Math.hypot(v1.x + v2.x, v1.y + v2.y);
  if (bisLen < 1e-6) return null;
  const bis = { x: (v1.x + v2.x) / bisLen, y: (v1.y + v2.y) / bisLen };
  const centerDist = r / Math.sin(angle / 2);
  const c = { x: curr.x + bis.x * centerDist, y: curr.y + bis.y * centerDist };
  const a0 = Math.atan2(p1.y - c.y, p1.x - c.x);
  const a1 = Math.atan2(p2.y - c.y, p2.x - c.x);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  const midAng = a0 + sweep / 2;
  const mid = { x: c.x + r * Math.cos(midAng), y: c.y + r * Math.sin(midAng) };
  if (!pointInPoly(mid, poly)) {
    sweep += sweep > 0 ? -Math.PI * 2 : Math.PI * 2;
  }
  const pts: Vec2[] = [];
  const n = Math.max(2, samples);
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    pts.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  return pts;
}

export function filletLoop(ptsIn: Vec2[], radius: number, skip?: (index: number) => boolean): Vec2[] {
  const poly = cleanPoly(ptsIn);
  if (radius <= 0.05 || poly.length < 3) return poly;
  const out: Vec2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    if (skip?.(i)) {
      out.push(poly[i]);
      continue;
    }
    const prev = poly[(i + n - 1) % n];
    const curr = poly[i];
    const next = poly[(i + 1) % n];
    const arc = cornerArc(prev, curr, next, radius, poly, 6);
    if (!arc) out.push(curr);
    else {
      for (const p of arc) {
        const last = out[out.length - 1];
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-4) out.push(p);
      }
    }
  }
  return cleanPoly(out);
}

export function chamferLoop(ptsIn: Vec2[], distance: number, skip?: (index: number) => boolean): Vec2[] {
  const poly = cleanPoly(ptsIn);
  if (distance <= 0.05 || poly.length < 3) return poly;
  const out: Vec2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const curr = poly[i];
    if (skip?.(i)) {
      out.push(curr);
      continue;
    }
    const prev = poly[(i + n - 1) % n];
    const next = poly[(i + 1) % n];
    const e1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const e2 = Math.hypot(next.x - curr.x, next.y - curr.y);
    if (e1 < 1e-6 || e2 < 1e-6) {
      out.push(curr);
      continue;
    }
    const v1 = { x: (prev.x - curr.x) / e1, y: (prev.y - curr.y) / e1 };
    const v2 = { x: (next.x - curr.x) / e2, y: (next.y - curr.y) / e2 };
    const dot = clamp(v1.x * v2.x + v1.y * v2.y, -1, 1);
    const angle = Math.acos(dot);
    if (angle < 0.14 || Math.abs(Math.PI - angle) < 0.08) {
      out.push(curr);
      continue;
    }
    const d = Math.min(distance, e1 * 0.45, e2 * 0.45);
    out.push({ x: curr.x + v1.x * d, y: curr.y + v1.y * d });
    out.push({ x: curr.x + v2.x * d, y: curr.y + v2.y * d });
  }
  return cleanPoly(out);
}

export function circlePoints(cx: number, cy: number, r: number, segs = 48): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

export type Outline =
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "poly"; pts: Vec2[] };

export function pointMap(sketch: Sketch): Map<string, Vec2> {
  return new Map(sketch.points.map((p) => [p.id, { x: p.x, y: p.y }]));
}

export function loopOutline(sketch: Sketch, loop: Loop): Outline | null {
  const pm = pointMap(sketch);
  if (loop.kind === "circle") {
    const c = pm.get(loop.centerId);
    if (!c || loop.radius <= 0.01) return null;
    return { kind: "circle", cx: c.x, cy: c.y, r: loop.radius };
  }
  const pts: Vec2[] = [];
  for (const id of loop.pointIds) {
    const p = pm.get(id);
    if (p) pts.push(p);
  }
  const clean = cleanPoly(pts);
  if (clean.length < 3) return null;
  return { kind: "poly", pts: clean };
}

export function outlineArea(o: Outline): number {
  if (o.kind === "circle") return Math.PI * o.r * o.r;
  return Math.abs(signedArea(o.pts));
}

export function outlinePoints(o: Outline, segs = 32): Vec2[] {
  if (o.kind === "poly") return o.pts;
  return circlePoints(o.cx, o.cy, o.r, segs);
}

export function pointInsideOutline(o: Outline, p: Vec2, margin = 0): boolean {
  if (o.kind === "circle") return Math.hypot(p.x - o.cx, p.y - o.cy) < o.r - margin;
  if (margin > 0 && !pointInPoly(p, o.pts)) return false;
  if (!pointInPoly(p, o.pts)) return false;
  return true;
}

export function circleInsideOutline(o: Outline, cx: number, cy: number, r: number): boolean {
  if (r <= 0) return false;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const p = { x: cx + Math.cos(a) * r * 0.98, y: cy + Math.sin(a) * r * 0.98 };
    if (!pointInsideOutline(o, p, 0.05)) return false;
  }
  return pointInsideOutline(o, { x: cx, y: cy }, 0.05);
}

export function outlineInside(outer: Outline, inner: Outline): boolean {
  const pts = outlinePoints(inner, 24);
  return pts.every((p) => pointInsideOutline(outer, p, 0.05));
}

export function bboxOf(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!pts.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function sketchBBox(sketch: Sketch): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const pts: Vec2[] = [];
  for (const loop of sketch.loops) {
    const o = loopOutline(sketch, loop);
    if (o) pts.push(...outlinePoints(o, 24));
  }
  return bboxOf(pts);
}

export type SketchEdge = { loopId: string; index: number; a: string; b: string; p: Vec2; q: Vec2 };

export function sketchEdges(sketch: Sketch): SketchEdge[] {
  const pm = pointMap(sketch);
  const edges: SketchEdge[] = [];
  for (const loop of sketch.loops) {
    if (loop.kind !== "poly") continue;
    const ids = loop.pointIds;
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      const p = pm.get(a);
      const q = pm.get(b);
      if (!p || !q) continue;
      edges.push({ loopId: loop.id, index: i, a, b, p, q });
    }
  }
  return edges;
}
