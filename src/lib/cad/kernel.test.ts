import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "./build.ts";
import { evaluate } from "./evaluate.ts";
import { makeSamples } from "./samples.ts";
import { solveSketch } from "./solver.ts";

test("plate sketch is fully defined and stable", () => {
  const plate = makeSamples().find((d) => d.id === "doc-plate");
  assert.ok(plate);
  const sketch = plate.sketches[0];
  const before = sketch.points.map((p) => ({ ...p }));
  const solved = solveSketch(sketch);
  assert.equal(solved.report.status, "defined");
  assert.equal(solved.report.dof, 0);
  assert.ok(solved.report.error < 1e-4);
  for (const p of before) {
    const q = solved.sketch.points.find((s) => s.id === p.id);
    assert.ok(q);
    assert.ok(Math.hypot(q.x - p.x, q.y - p.y) < 1e-3, `${p.id} moved`);
  }
});

test("driving plate length recenters", () => {
  const plate = structuredClone(makeSamples().find((d) => d.id === "doc-plate")!);
  const len = plate.parameters.find((p) => p.id === "len");
  assert.ok(len);
  len.value = 120;
  const ev = evaluate(plate);
  assert.equal(ev.reports["sk-plate"].status, "defined");
  const pts = ev.doc.sketches[0].points;
  const xs = pts.map((p) => p.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 119);
  assert.ok(Math.abs(Math.min(...xs) + 60) < 0.2);
});

test("samples build watertight-ish solids", () => {
  for (const doc of makeSamples()) {
    const ev = evaluate(doc);
    for (const [id, report] of Object.entries(ev.reports)) {
      assert.notEqual(report.status, "conflict", `${doc.name} ${id} conflict ${report.error}`);
    }
    const built = buildModel(ev.doc);
    assert.ok(built.bodies.length > 0, doc.name);
    let tris = 0;
    for (const body of built.bodies) {
      const pos = body.geometry.getAttribute("position");
      assert.ok(pos.count > 30, doc.name);
      const box = body.geometry.boundingBox;
      assert.ok(box);
      const dx = box.max.x - box.min.x;
      const dy = box.max.y - box.min.y;
      const dz = box.max.z - box.min.z;
      assert.ok(dx > 1 && dy > 1 && dz > 1, `${doc.name} degenerate ${dx} ${dy} ${dz}`);
      tris += body.geometry.index ? body.geometry.index.count / 3 : pos.count / 3;
      body.geometry.dispose();
    }
    assert.ok(tris > 100, doc.name);
    assert.equal(built.issues.filter((i) => /collapsed|empty|crosses/.test(i)).length, 0, built.issues.join("; "));
  }
});

test("bracket and flange stay defined", () => {
  for (const id of ["doc-flange", "doc-br", "doc-shaft"]) {
    const doc = makeSamples().find((d) => d.id === id)!;
    const ev = evaluate(doc);
    for (const report of Object.values(ev.reports)) assert.equal(report.status, "defined");
  }
});
