import type { Constraint, Point, Sketch, SolveReport, SolveStatus } from "./types";

type Pin = { id: string; x: number; y: number };

function hypot(x: number, y: number): number {
  return Math.hypot(x, y);
}

function residuals(constraints: Constraint[], byId: Map<string, Point>): number[] {
  const r: number[] = [];
  const p = (id: string) => byId.get(id);
  for (const c of constraints) {
    if (c.type === "h") {
      const a = p(c.a);
      const b = p(c.b);
      if (a && b) r.push(a.y - b.y);
    } else if (c.type === "v") {
      const a = p(c.a);
      const b = p(c.b);
      if (a && b) r.push(a.x - b.x);
    } else if (c.type === "dist") {
      const a = p(c.a);
      const b = p(c.b);
      if (a && b) r.push(hypot(a.x - b.x, a.y - b.y) - c.value);
    } else if (c.type === "coincident") {
      const a = p(c.a);
      const b = p(c.b);
      if (a && b) {
        r.push(a.x - b.x, a.y - b.y);
      }
    } else if (c.type === "equal") {
      const a = p(c.a);
      const b = p(c.b);
      const d = p(c.c);
      const e = p(c.d);
      if (a && b && d && e) {
        r.push(hypot(a.x - b.x, a.y - b.y) - hypot(d.x - e.x, d.y - e.y));
      }
    } else if (c.type === "parallel" || c.type === "perp") {
      const a = p(c.a);
      const b = p(c.b);
      const d = p(c.c);
      const e = p(c.d);
      if (a && b && d && e) {
        const l1 = hypot(b.x - a.x, b.y - a.y) || 1;
        const l2 = hypot(e.x - d.x, e.y - d.y) || 1;
        const ux = (b.x - a.x) / l1;
        const uy = (b.y - a.y) / l1;
        const vx = (e.x - d.x) / l2;
        const vy = (e.y - d.y) / l2;
        r.push((c.type === "parallel" ? ux * vy - uy * vx : ux * vx + uy * vy) * 10);
      }
    } else if (c.type === "sum0") {
      const a = p(c.a);
      const b = p(c.b);
      if (a && b) r.push(a[c.axis] + b[c.axis]);
    } else if (c.type === "coord") {
      const a = p(c.pointId);
      if (a) r.push(a[c.axis] - c.value);
    }
  }
  return r;
}

function norm(r: number[]): number {
  let s = 0;
  for (const v of r) s += v * v;
  return Math.sqrt(s);
}

function numericRank(J: number[][]): number {
  if (!J.length || !J[0].length) return 0;
  const m = J.length;
  const n = J[0].length;
  const A = J.map((row) => row.slice());
  const eps = 1e-8;
  let rank = 0;
  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    let piv = row;
    for (let i = row + 1; i < m; i++) if (Math.abs(A[i][col]) > Math.abs(A[piv][col])) piv = i;
    if (Math.abs(A[piv][col]) < eps) continue;
    const tmp = A[row];
    A[row] = A[piv];
    A[piv] = tmp;
    const div = A[row][col];
    for (let j = col; j < n; j++) A[row][j] /= div;
    for (let i = 0; i < m; i++) {
      if (i === row) continue;
      const f = A[i][col];
      if (f === 0) continue;
      for (let j = col; j < n; j++) A[i][j] -= f * A[row][j];
    }
    rank++;
    row++;
  }
  return rank;
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-10) return null;
    const tmp = M[c];
    M[c] = M[piv];
    M[piv] = tmp;
    const div = M[c][c];
    for (let k = c; k <= n; k++) M[c][k] /= div;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

function reportOf(error: number, dof: number): SolveReport {
  let status: SolveStatus = "defined";
  if (error > 1e-2) status = "conflict";
  else if (dof > 0) status = "under";
  return { status, dof, error };
}

export function solveSketch(sketch: Sketch, pins: Pin[] = []): { sketch: Sketch; report: SolveReport } {
  const points: Point[] = sketch.points.map((pt) => ({ ...pt }));
  const loops = sketch.loops.map((loop) => ({ ...loop }));
  const byId = new Map(points.map((pt) => [pt.id, pt]));

  for (const c of sketch.constraints) {
    if (c.type !== "radius") continue;
    const loop = loops.find((l) => l.id === c.loopId);
    if (loop && loop.kind === "circle") loop.radius = Math.max(0.05, c.value);
  }

  const locks = new Map<string, { x: number; y: number }>();
  for (const c of sketch.constraints) {
    if (c.type === "fixed") locks.set(c.pointId, { x: c.x, y: c.y });
  }
  for (const pin of pins) locks.set(pin.id, { x: pin.x, y: pin.y });
  for (const [id, v] of locks) {
    const pt = byId.get(id);
    if (pt) {
      pt.x = v.x;
      pt.y = v.y;
    }
  }

  const vars: { id: string; axis: "x" | "y" }[] = [];
  for (const pt of points) {
    if (locks.has(pt.id)) continue;
    vars.push({ id: pt.id, axis: "x" }, { id: pt.id, axis: "y" });
  }

  const res = () => residuals(sketch.constraints, byId);
  const jacobian = () => {
    const base = res();
    const eps = 1e-6;
    const J: number[][] = base.map(() => new Array<number>(vars.length).fill(0));
    vars.forEach((v, col) => {
      const pt = byId.get(v.id);
      if (!pt) return;
      const orig = pt[v.axis];
      pt[v.axis] = orig + eps;
      const next = res();
      pt[v.axis] = orig;
      for (let row = 0; row < next.length; row++) J[row][col] = (next[row] - base[row]) / eps;
    });
    return J;
  };

  if (vars.length > 0) {
    let lambda = 1e-3;
    let err = norm(res());
    for (let iter = 0; iter < 50 && err > 1e-9; iter++) {
      const J = jacobian();
      const r = res();
      const n = vars.length;
      const H: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      const g = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        for (let row = 0; row < J.length; row++) {
          g[i] += J[row][i] * r[row];
          for (let j = 0; j < n; j++) H[i][j] += J[row][i] * J[row][j];
        }
        H[i][i] += lambda;
      }
      const delta = solveLinear(H, g.map((v) => -v));
      if (!delta) {
        lambda = Math.min(1e8, lambda * 10);
        continue;
      }
      let mag = 0;
      for (const d of delta) mag += d * d;
      mag = Math.sqrt(mag);
      const scale = mag > 80 ? 80 / mag : 1;
      const saved = vars.map((v) => byId.get(v.id)?.[v.axis] ?? 0);
      vars.forEach((v, i) => {
        const pt = byId.get(v.id);
        if (pt) pt[v.axis] = saved[i] + delta[i] * scale;
      });
      const err2 = norm(res());
      if (Number.isFinite(err2) && err2 < err) {
        err = err2;
        lambda = Math.max(1e-8, lambda * 0.35);
      } else {
        vars.forEach((v, i) => {
          const pt = byId.get(v.id);
          if (pt) pt[v.axis] = saved[i];
        });
        lambda = Math.min(1e8, lambda * 8);
        if (lambda > 1e7) break;
      }
    }
  }

  let bad = false;
  for (const pt of points) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y) || Math.abs(pt.x) > 1e5 || Math.abs(pt.y) > 1e5) bad = true;
  }
  const error = bad ? 1 : norm(res());
  const dof = bad ? 0 : Math.max(0, vars.length - numericRank(jacobian()));
  const solved: Sketch = {
    ...sketch,
    points: bad ? sketch.points.map((pt) => ({ ...pt })) : points,
    loops,
  };
  return { sketch: solved, report: reportOf(error, dof) };
}
