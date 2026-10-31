import * as THREE from "three";
import { ADDITION, Brush, Evaluator, SUBTRACTION } from "three-bvh-csg";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  chamferLoop,
  circleInsideOutline,
  circlePoints,
  ensureCCW,
  ensureCW,
  filletLoop,
  loopOutline,
  outlineArea,
  outlineInside,
  sketchBBox,
  type Outline,
} from "./geom2d.ts";
import type { Axis, Doc, HoleFeature, Plane, SolidFeature, Vec2 } from "./types";

export type BuiltBody = {
  ids: string[];
  name: string;
  geometry: THREE.BufferGeometry;
};

export type BuildResult = {
  bodies: BuiltBody[];
  issues: string[];
};

const evaluator = new Evaluator();
evaluator.attributes = ["position", "normal"];
evaluator.useGroups = false;

export function planeMatrix(plane: Plane, offset: number): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (plane === "XY") {
    m.makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1));
    m.setPosition(0, 0, offset);
  } else if (plane === "XZ") {
    m.makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0));
    m.setPosition(0, -offset, 0);
  } else {
    m.makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
    m.setPosition(offset, 0, 0);
  }
  return m;
}

export function sketchPoint(plane: Plane, offset: number, x: number, y: number): THREE.Vector3 {
  const v = new THREE.Vector3(x, y, 0).applyMatrix4(planeMatrix(plane, offset));
  return v;
}

type Center = { key: string; hole: HoleFeature; x: number; y: number; r: number };

function holeCenters(doc: Doc, hole: HoleFeature): Center[] {
  const r = hole.diameter / 2;
  const out: Center[] = [];
  hole.places.forEach((place, pi) => {
    if (place.mode === "abs") {
      out.push({ key: `${hole.id}:${pi}`, hole, x: place.x, y: place.y, r });
      return;
    }
    if (place.mode === "pcd") {
      const n = Math.max(1, Math.round(place.count));
      const rad = place.pcd / 2;
      const start = ((place.startDeg ?? 0) * Math.PI) / 180;
      for (let i = 0; i < n; i++) {
        const a = start + (i / n) * Math.PI * 2;
        out.push({
          key: `${hole.id}:${pi}:${i}`,
          hole,
          x: place.cx + rad * Math.cos(a),
          y: place.cy + rad * Math.sin(a),
          r,
        });
      }
      return;
    }
    const sk = doc.sketches.find((s) => s.id === place.sketchId);
    const box = sk ? sketchBBox(sk) : null;
    if (!box) return;
    out.push({
      key: `${hole.id}:${pi}`,
      hole,
      x: place.sx > 0 ? box.maxX - place.insetX : box.minX + place.insetX,
      y: place.sy > 0 ? box.maxY - place.insetY : box.minY + place.insetY,
      r,
    });
  });
  return out;
}

function clusters(outlines: Outline[]): { outer: Outline; holes: Outline[] }[] {
  const sorted = outlines
    .map((o, i) => ({ o, i, area: outlineArea(o) }))
    .filter((item) => item.area > 1e-4)
    .sort((a, b) => b.area - a.area);
  const used = new Set<number>();
  const groups: { outer: Outline; holes: Outline[] }[] = [];
  for (const item of sorted) {
    if (used.has(item.i)) continue;
    let consumed = false;
    for (const group of groups) {
      if (outlineInside(group.outer, item.o)) {
        group.holes.push(item.o);
        used.add(item.i);
        consumed = true;
        break;
      }
    }
    if (consumed) continue;
    const holes: Outline[] = [];
    for (const other of sorted) {
      if (other.i === item.i || used.has(other.i)) continue;
      if (outlineInside(item.o, other.o)) {
        holes.push(other.o);
        used.add(other.i);
      }
    }
    used.add(item.i);
    groups.push({ outer: item.o, holes });
  }
  return groups;
}

function appendLoop(path: THREE.Path, outline: Outline, hole: boolean) {
  if (outline.kind === "circle") {
    path.absarc(outline.cx, outline.cy, Math.max(0.05, outline.r), 0, Math.PI * 2, hole);
    return;
  }
  const pts = hole ? ensureCW(outline.pts) : ensureCCW(outline.pts);
  if (pts.length < 3) return;
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  path.closePath();
}

function modifyOuter(outer: Outline, fillet: number, chamfer: number, axis: Axis | null): Outline {
  if (outer.kind !== "poly") return outer;
  const skip = (index: number) => {
    if (!axis) return false;
    const p = outer.pts[index];
    return axis === "Y" ? Math.abs(p.x) < 0.2 : Math.abs(p.y) < 0.2;
  };
  if (fillet > 0.05) return { kind: "poly", pts: filletLoop(outer.pts, fillet, skip) };
  if (chamfer > 0.05) return { kind: "poly", pts: chamferLoop(outer.pts, chamfer, skip) };
  return outer;
}

function extrudeShape(
  outer: Outline,
  holes: Outline[],
  circles: { x: number; y: number; r: number }[],
  depth: number,
  symmetric: boolean,
  flipped: boolean,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  appendLoop(shape, outer, false);
  for (const hole of holes) {
    const path = new THREE.Path();
    appendLoop(path, hole, true);
    shape.holes.push(path);
  }
  for (const c of circles) {
    const path = new THREE.Path();
    path.absarc(c.x, c.y, c.r, 0, Math.PI * 2, true);
    shape.holes.push(path);
  }
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.05, depth),
    bevelEnabled: false,
    curveSegments: 56,
    steps: 1,
  });
  if (symmetric) geom.translate(0, 0, -depth / 2);
  else if (flipped) geom.translate(0, 0, -depth);
  return geom;
}

function axisFix(axis: Axis): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (axis === "Y") {
    m.set(0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1);
  } else {
    m.set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  }
  return m;
}

function asPoly(outline: Outline): Vec2[] {
  if (outline.kind === "poly") return ensureCCW(outline.pts);
  return circlePoints(outline.cx, outline.cy, outline.r, 56);
}

function revolvePoly(pts: Vec2[], axis: Axis, angleDeg: number): THREE.BufferGeometry | string {
  for (const p of pts) {
    if (axis === "Y" && p.x < -0.05) return "Profile crosses the revolve axis";
    if (axis === "X" && p.y < -0.05) return "Profile crosses the revolve axis";
  }
  const ring = [...pts, pts[0]];
  const lathePts = ring.map((p) =>
    axis === "Y" ? new THREE.Vector2(Math.max(0, p.x), p.y) : new THREE.Vector2(Math.max(0, p.y), p.x),
  );
  const full = angleDeg >= 359.5;
  const phi = full ? Math.PI * 2 : (angleDeg * Math.PI) / 180;
  const segs = Math.max(16, Math.round((full ? 72 : 48) * (angleDeg / 360)));
  const geom = new THREE.LatheGeometry(lathePts, segs, 0, phi);
  geom.applyMatrix4(axisFix(axis));
  if (full) return geom;
  const shape = new THREE.Shape(ensureCCW(pts).map((p) => new THREE.Vector2(p.x, p.y)));
  const start = new THREE.ShapeGeometry(shape, 8);
  if (axis === "X") start.scale(1, 1, -1);
  const end = start.clone();
  if (axis === "Y") end.rotateY(phi);
  else end.rotateX(phi);
  start.computeVertexNormals();
  end.computeVertexNormals();
  const merged = mergeGeometries([geom, start, end], false);
  start.dispose();
  end.dispose();
  if (!merged) return geom;
  geom.dispose();
  return merged;
}

function signedVolume(geom: THREE.BufferGeometry): number {
  const pos = geom.getAttribute("position");
  if (!pos) return 0;
  const idx = geom.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let vol = 0;
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const ia = idx ? idx.getX(i) : i;
    const ib = idx ? idx.getX(i + 1) : i + 1;
    const ic = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    vol += a.dot(cross.crossVectors(b, c));
  }
  return vol / 6;
}

function finiteGeometry(geom: THREE.BufferGeometry): boolean {
  const pos = geom.getAttribute("position");
  if (!pos || pos.count < 3) return false;
  for (let i = 0; i < pos.count; i++) {
    if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) return false;
  }
  return true;
}

function outward(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!finiteGeometry(geom)) return geom;
  if (signedVolume(geom) < 0) {
    const idx = geom.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        const b = idx.getX(i + 1);
        const c = idx.getX(i + 2);
        idx.setX(i + 1, c);
        idx.setX(i + 2, b);
      }
      idx.needsUpdate = true;
    }
  }
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  return geom;
}

function csg(a: THREE.BufferGeometry, b: THREE.BufferGeometry, op: typeof SUBTRACTION | typeof ADDITION): THREE.BufferGeometry {
  const ga = a.clone();
  const gb = b.clone();
  ga.clearGroups();
  gb.clearGroups();
  ga.computeVertexNormals();
  gb.computeVertexNormals();
  const ba = new Brush(ga);
  const bb = new Brush(gb);
  ba.updateMatrixWorld(true);
  bb.updateMatrixWorld(true);
  const result = evaluator.evaluate(ba, bb, op);
  const out = result.geometry.clone();
  ga.dispose();
  gb.dispose();
  result.geometry.dispose();
  return outward(out);
}

function bboxHits2d(doc: Doc, sketchId: string, x: number, y: number, r: number): boolean {
  const sk = doc.sketches.find((s) => s.id === sketchId);
  if (!sk) return true;
  const box = sketchBBox(sk);
  if (!box) return true;
  return x + r >= box.minX - 0.2 && x - r <= box.maxX + 0.2 && y + r >= box.minY - 0.2 && y - r <= box.maxY + 0.2;
}

function holeCylinder(hole: HoleFeature, x: number, y: number, r: number, through: boolean): THREE.BufferGeometry {
  const travel = hole.travel || -1;
  const z0 = through ? -400 : -0.4 * travel;
  const z1 = through ? 400 : travel * ((hole.depth ?? 8) + 0.25);
  const length = Math.max(0.2, Math.abs(z1 - z0));
  const mid = (z0 + z1) / 2;
  const geom = new THREE.CylinderGeometry(r, r, length, 40);
  geom.rotateX(Math.PI / 2);
  geom.translate(x, y, mid);
  geom.applyMatrix4(planeMatrix(hole.plane, hole.offset));
  return geom;
}

export function buildModel(doc: Doc, hidden: ReadonlySet<string> = new Set()): BuildResult {
  const issues: string[] = [];
  const centers = doc.features.filter((f): f is HoleFeature => f.kind === "hole" && !hidden.has(f.id)).flatMap((h) => holeCenters(doc, h));
  const baked = new Set<string>();
  const bodies: BuiltBody[] = [];

  const filletOf = (id: string) => {
    let radius = 0;
    let chamfer = 0;
    for (const feature of doc.features) {
      if (hidden.has(feature.id)) continue;
      if (feature.kind === "fillet" && feature.targetId === id) radius = feature.radius;
      if (feature.kind === "chamfer" && feature.targetId === id) chamfer = feature.distance;
    }
    if (radius > 0.05 && chamfer > 0.05) issues.push("Chamfer skipped: the solid already has a fillet");
    return { radius, chamfer: radius > 0.05 ? 0 : chamfer };
  };

  for (const feature of doc.features) {
    if (feature.kind !== "solid" || hidden.has(feature.id)) continue;
    const sketch = doc.sketches.find((s) => s.id === feature.sketchId);
    if (!sketch) {
      issues.push(`No sketch for "${feature.name}"`);
      continue;
    }
    const outlines = sketch.loops.map((loop) => loopOutline(sketch, loop)).filter((o): o is Outline => !!o);
    if (!outlines.length) {
      issues.push(`Sketch "${sketch.name}" is empty`);
      continue;
    }
    const { radius, chamfer } = filletOf(feature.id);
    const groups = clusters(outlines).map((group) => ({
      outer: modifyOuter(group.outer, radius, chamfer, feature.mode === "revolve" ? feature.axis : null),
      holes: group.holes,
    }));
    let geom: THREE.BufferGeometry | null = null;
    let bakedIds: string[] = [];
    if (feature.mode === "revolve") {
      const main = groups[0];
      const revolved = revolvePoly(asPoly(main.outer), feature.axis, feature.angle);
      if (typeof revolved === "string") {
        issues.push(revolved);
        continue;
      }
      geom = revolved;
      for (const hole of main.holes) {
        const inner = revolvePoly(asPoly(hole), feature.axis, feature.angle);
        if (typeof inner === "string") continue;
        try {
          const next = csg(geom, inner, SUBTRACTION);
          geom.dispose();
          inner.dispose();
          geom = next;
        } catch {
          inner.dispose();
          issues.push("Could not subtract the revolve profile");
        }
      }
    } else {
      const parts: THREE.BufferGeometry[] = [];
      const localBaked: string[] = [];
      bakedIds = [];
      groups.forEach((group, gi) => {
        const extra = centers.filter((c) => {
          if (c.hole.plane !== sketch.plane) return false;
          if (c.hole.depth != null && c.hole.depth + 0.05 < feature.depth) return false;
          if (!circleInsideOutline(group.outer, c.x, c.y, c.r)) return false;
          if (group.holes.some((h) => circleInsideOutline(h, c.x, c.y, c.r * 0.5))) return false;
          return true;
        });
        const piece = extrudeShape(group.outer, group.holes, extra, feature.depth, feature.symmetric, feature.flipped);
        piece.applyMatrix4(planeMatrix(sketch.plane, sketch.offset));
        parts.push(piece);
        if (gi === 0) {
          for (const c of extra) {
            localBaked.push(`${c.key}:${feature.id}`);
            if (!bakedIds.includes(c.hole.id)) bakedIds.push(c.hole.id);
          }
        }
      });
      geom = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
      if (parts.length > 1) parts.forEach((p) => p.dispose());
      if (!geom) {
        issues.push(`Could not extrude "${feature.name}"`);
        continue;
      }
      for (const key of localBaked) baked.add(key);
    }

    geom = outward(geom);
    if (!finiteGeometry(geom)) {
      geom.dispose();
      issues.push(`Geometry "${feature.name}" collapsed`);
      continue;
    }

    if (feature.operation === "cut") {
      if (!bodies.length) {
        geom.dispose();
        issues.push("Cut has nothing to subtract from");
        continue;
      }
      let failed = false;
      for (const body of bodies) {
        try {
          const next = csg(body.geometry, geom, SUBTRACTION);
          body.geometry.dispose();
          body.geometry = next;
          if (!body.ids.includes(feature.id)) body.ids.push(feature.id);
        } catch {
          failed = true;
        }
      }
      geom.dispose();
      if (failed) issues.push("Boolean cut did not converge");
      continue;
    }

    if (feature.operation === "join" && bodies.length) {
      const target = bodies[bodies.length - 1];
      try {
        const next = csg(target.geometry, geom, ADDITION);
        target.geometry.dispose();
        geom.dispose();
        target.geometry = next;
        target.ids.push(feature.id);
        target.name = feature.name;
      } catch {
        bodies.push({ ids: [feature.id], name: feature.name, geometry: geom });
        issues.push("Join did not converge — the solid was left separate");
      }
      continue;
    }

    bodies.push({ ids: [feature.id, ...bakedIds], name: feature.name, geometry: geom });
  }

  for (const center of centers) {
    for (const body of bodies) {
      const pair = `${center.key}:${body.ids[0]}`;
      if (baked.has(pair)) continue;
      const ownerId = body.ids[0];
      const owner = doc.features.find((f) => f.id === ownerId && f.kind === "solid") as SolidFeature | undefined;
      if (!owner) continue;
      if (center.hole.plane === "XY" || center.hole.plane === "XZ" || center.hole.plane === "YZ") {
        const sketch = doc.sketches.find((s) => s.id === owner.sketchId);
        if (sketch && center.hole.plane === sketch.plane && !bboxHits2d(doc, sketch.id, center.x, center.y, center.r)) continue;
      }
      const through = center.hole.depth == null;
      const tool = holeCylinder(center.hole, center.x, center.y, center.r, through);
      try {
        const next = csg(body.geometry, tool, SUBTRACTION);
        body.geometry.dispose();
        body.geometry = next;
        if (!body.ids.includes(center.hole.id)) body.ids.push(center.hole.id);
      } catch {
        issues.push("Could not subtract the hole");
      }
      tool.dispose();
    }
  }

  const unique = [...new Set(issues)];
  return { bodies, issues: unique };
}

export function disposeBodies(bodies: BuiltBody[]) {
  for (const body of bodies) body.geometry.dispose();
}
