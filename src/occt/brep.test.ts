import assert from "node:assert/strict";
import test from "node:test";
import initOpenCascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildTube, cutRadialHole, inspect, shapeFromStep, stepBytes } from "./brep.ts";
import { stepErrors, tubeErrors } from "./checks.ts";

test("opencascade tube, step round-trip, and a real edit", async () => {
  setOC(await initOpenCascade());
  const tube = buildTube();
  const built = inspect(tube);
  assert.deepEqual(tubeErrors(built), []);
  const step = await stepBytes(tube);
  assert.deepEqual(stepErrors(step), []);
  tube.delete();

  const reread = inspect(await shapeFromStep(step));
  assert.deepEqual(tubeErrors(reread), []);
  assert.ok(Math.abs(reread.volume - built.volume) < 1e-6);

  const modifiedShape = cutRadialHole(await shapeFromStep(step));
  const modified = inspect(modifiedShape);
  assert.equal(modified.valid, true);
  assert.equal(modified.solidValid, true);
  assert.equal(modified.solids, 1);
  assert.equal(modified.analyticOnly, true);
  assert.ok(modified.volume < built.volume - 100);
  const edited = await stepBytes(modifiedShape);
  assert.deepEqual(stepErrors(edited), []);
  assert.ok(edited.byteLength !== step.byteLength || edited.some((byte, index) => byte !== step[index]));
  modifiedShape.delete();

  const rereadEdited = inspect(await shapeFromStep(edited));
  assert.ok(Math.abs(rereadEdited.volume - modified.volume) < 1e-4);
  assert.equal(rereadEdited.solidValid, true);
});
