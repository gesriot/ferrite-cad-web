/**
 * @typedef {import("./occt-surface").Oc} Oc
 * @typedef {import("./occt-surface").OcHandle} OcHandle
 * @typedef {import("./occt-surface").PlacementPlan} PlacementPlan
 * @typedef {import("./occt-surface").PlacementRow} PlacementRow
 * @typedef {Error & { placement?: { stage: string, index: number, entry: string, parent: number, element: number, expected: string, actual: string } }} PlacementError
 */

/**
 * Write an accepted placement plan into the open XDE document.
 *
 * Transport is the public path that preserved all 5124 probed numbers:
 * gp_Mat → gp_GTrsf → SetForm → Trsf → SetScaleFactor(1) → TopLoc_Location.
 * The scale is 1 only because every matrix here is a rigid SetTransformation.
 * XCAFDoc_Location.Set replaces the attribute. ShapeTool.SetLocation is not
 * used: on a reference it multiplies and can round again.
 * A mismatch at any stage throws before the caller publishes the document.
 */
import { hexOf } from "./placement-math/f64.mjs";
import { composeWorld } from "./placement-math/transform.mjs";

/** @param {OcHandle} transform */
function bitsOf(transform) {
  const values = [];
  for (let row = 1; row <= 3; row += 1) {
    for (let column = 1; column <= 4; column += 1) values.push(hexOf(transform.Value(row, column)));
  }
  return values;
}

/** @param {string[]} got @param {string[]} expected @param {string} stage @param {PlacementRow} row */
function same(got, expected, stage, row) {
  for (let element = 0; element < 12; element += 1) {
    if (got[element] !== expected[element]) {
      const error = /** @type {PlacementError} */ (new Error(
        `placement ${stage} changed occurrence ${row.index} ${row.entry} element ${element}: expected ${expected[element]} actual ${got[element]}`,
      ));
      error.placement = { stage, index: row.index, entry: row.entry, parent: row.parent, element, expected: expected[element], actual: got[element] };
      throw error;
    }
  }
}

/** @param {Oc} oc @param {number[]} values */
function rigidLocation(oc, values) {
  const matrix = new oc.gp_Mat();
  for (let row = 1; row <= 3; row += 1) {
    for (let column = 1; column <= 3; column += 1) matrix.SetValue(row, column, values[(row - 1) * 4 + column - 1]);
  }
  const translation = new oc.gp_XYZ(values[3], values[7], values[11]);
  const general = new oc.gp_GTrsf(matrix, translation);
  general.SetForm();
  const trsf = general.Trsf();
  trsf.SetScaleFactor(1);
  const location = new oc.TopLoc_Location(trsf);
  matrix.delete?.();
  translation.delete?.();
  general.delete?.();
  return { trsf, location };
}

/**
 * Install every covered occurrence. Shared labels are written once.
 * Returns the readback. Throws on the first exact difference.
 */
/** @param {Oc} oc @param {OcHandle} doc @param {PlacementPlan} plan */
export function installPlacements(oc, doc, plan) {
  if (!plan || plan.refused) throw new Error(plan?.refused || "placement plan is empty");
  if (!plan.rows?.length) throw new Error("placement plan has no occurrences");
  const expected = new Map();
  for (const row of plan.rows) {
    if (!row.covered || !row.candidate || row.candidate.length !== 12) {
      throw new Error(row.reason || `occurrence ${row.index} is not covered`);
    }
    const bits = row.candidate.map(hexOf);
    const previous = expected.get(row.labelKey);
    if (!previous) {
      expected.set(row.labelKey, { row, bits, occurrences: [row.index] });
      continue;
    }
    previous.occurrences.push(row.index);
    for (let element = 0; element < 12; element += 1) {
      if (previous.bits[element] !== bits[element]) {
        throw new Error(`shared label ${row.entry} has different placements for occurrences ${previous.occurrences[0]} and ${row.index}; nothing was written`);
      }
    }
  }

  const shapes = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main());
  const kept = [];
  for (const item of expected.values()) {
    if (!item.row.candidate) throw new Error("covered row has no candidate");
    const built = rigidLocation(oc, item.row.candidate);
    kept.push(built.trsf, built.location);
    const candidate = item.bits;
    same(bitsOf(built.trsf), candidate, "gp_Trsf", item.row);
    same(bitsOf(built.location.Transformation()), candidate, "TopLoc_Location", item.row);
    oc.XCAFDoc_Location.Set(item.row.label, built.location);
    const stored = oc.XCAFDoc_ShapeTool.GetLocation(item.row.label);
    same(bitsOf(stored.Transformation()), candidate, "GetLocation-before-update", item.row);
  }
  shapes.UpdateAssemblies();

  const readback = [];
  for (const row of plan.rows) {
    if (!row.candidate) throw new Error("row has no candidate");
    const candidate = row.candidate.map(hexOf);
    const located = oc.XCAFDoc_ShapeTool.GetLocation(row.label);
    const shaped = oc.XCAFDoc_ShapeTool.GetShape(row.label).Location();
    const getLocation = bitsOf(located.Transformation());
    const shapeLocation = bitsOf(shaped.Transformation());
    same(getLocation, candidate, "GetLocation", row);
    same(shapeLocation, candidate, "GetShape.Location", row);
    readback.push({
      index: row.index,
      parent: row.parent,
      entry: row.entry,
      kind: row.kind,
      candidate,
      gpTrsf: candidate,
      topLoc: candidate,
      getLocation,
      shapeLocation,
    });
  }
  const world = composeWorld(readback.map((row) => ({
    index: row.index,
    parent: row.parent,
    entry: row.entry,
    bits: row.getLocation,
  })));
  return {
    mode: "experimental-placement-compatibility",
    occurrences: plan.rows.length,
    labelsWritten: expected.size,
    kept,
    rows: readback,
    world: world.nodes.map((node) => ({ index: node.index, parent: node.parent, entry: node.entry, world: node.world, boundary: node.boundary, raw: node.raw })),
    rawBoundaryDifferences: world.rawBoundaryDifferences,
  };
}
