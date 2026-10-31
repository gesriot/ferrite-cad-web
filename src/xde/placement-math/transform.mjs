// @ts-nocheck
// Accepted placement arithmetic. Operation order must not be altered for the type checker.
/**
 * World composition. This is FerriteCAD's Rust `Transform`, not
 * TKMath `gp_Trsf::Multiply`. The experimental XDE read uses `then`.
 * The audit compares the same functions with the native world dumps.
 *
 * `from_rows` refuses a non-finite value and stores exact `-0` as `+0`
 * (`normalize_f64` in reference/hash.rs). `then` is `local.then(parentWorld)`:
 * for each row i and column j, start at `+0` and add `outer[i][k] * self[k][j]`
 * for k = 0..3 as separate multiply-adds, then add `outer[i][3]` when j is 3.
 * The sum is passed through `from_rows`. No FMA and no 1e-12 flush.
 */
import { fromHex, hexOf } from "./f64.mjs";

export function normalizeF64(value) {
  if (!Number.isFinite(value)) {
    throw new Error(`model values must be finite, found ${value}`);
  }
  return value === 0 ? 0 : value;
}

export function fromRows(rows) {
  return rows.map((row) => row.map((value) => normalizeF64(value)));
}

/** `self.then(outer)` — apply self, then outer. Both arguments are 3×4 rows. */
export function then(self, outer) {
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    const row = [];
    for (let j = 0; j < 4; j += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        sum += outer[i][k] * self[k][j];
      }
      if (j === 3) sum += outer[i][3];
      row.push(sum);
    }
    rows.push(row);
  }
  return fromRows(rows);
}

function unflat(values) {
  if (values.length !== 12) throw new Error(`a placement row has ${values.length} elements, not 12`);
  return [values.slice(0, 4), values.slice(4, 8), values.slice(8, 12)];
}

function negZeros(values) {
  return values.reduce((count, value) => count + (hexOf(value) === "8000000000000000" ? 1 : 0), 0);
}

/**
 * Parent-before-child walk. `nodes` are raw local hex rows in walk order.
 * Returns raw bits, bits after `from_rows`, and world bits, separately.
 */
export function composeWorld(nodes) {
  const placed = [];
  const out = [];
  let rawNegZeros = 0;
  let boundaryNegZeros = 0;
  let rawBoundaryDifferences = 0;
  for (const node of nodes) {
    if (node.index !== placed.length) {
      throw new Error(`world walk index ${node.index} is not the next parent-first slot ${placed.length}`);
    }
    if (node.parent >= node.index) {
      throw new Error(`occurrence ${node.index} names parent ${node.parent}, which is not before it`);
    }
    const raw = node.bits.map((hex) => fromHex(hex));
    rawNegZeros += negZeros(raw);
    const local = fromRows(unflat(raw));
    const boundary = local.flat();
    boundaryNegZeros += negZeros(boundary);
    const rawHex = raw.map(hexOf);
    const boundaryHex = boundary.map(hexOf);
    for (let element = 0; element < 12; element += 1) {
      if (rawHex[element] !== boundaryHex[element]) rawBoundaryDifferences += 1;
    }
    const world = node.parent < 0 ? local : then(local, placed[node.parent]);
    placed.push(world);
    out.push({
      index: node.index,
      parent: node.parent,
      entry: node.entry,
      raw: rawHex,
      boundary: boundaryHex,
      world: world.flat().map(hexOf),
    });
  }
  return { nodes: out, rawNegZeros, boundaryNegZeros, rawBoundaryDifferences };
}

/** Compare a composed walk with one native-world-results scene. */
export function diffWorld(composed, oracleNodes) {
  const differences = [];
  let elements = 0;
  let mismatches = 0;
  if (!Array.isArray(oracleNodes)) {
    differences.push({ kind: "oracle", reason: "world oracle has no node list" });
    mismatches += 12;
    elements += 12;
    oracleNodes = [];
  }
  if (composed.nodes.length !== oracleNodes.length) {
    const extra = Math.abs(composed.nodes.length - oracleNodes.length);
    mismatches += extra * 12;
    elements += extra * 12;
    differences.push({
      kind: "length",
      actual: composed.nodes.length,
      expected: oracleNodes.length,
    });
  }
  const count = Math.min(composed.nodes.length, oracleNodes.length);
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const got = composed.nodes[index];
    const want = oracleNodes[index];
    const identity = `${want?.index}|${want?.parent}|${want?.entry}`;
    if (want && seen.has(identity)) {
      mismatches += 12;
      elements += 12;
      if (differences.length < 8) differences.push({ kind: "duplicate-oracle-occurrence", identity });
    }
    if (want) seen.add(identity);
    if (!want || got.index !== want.index || got.parent !== want.parent || got.entry !== want.entry || got.index !== index || (want.parent >= want.index && want.parent >= 0)) {
      mismatches += 12;
      elements += 12;
      if (differences.length < 8) {
        differences.push({
          kind: "occurrence",
          index,
          actual: { index: got.index, parent: got.parent, entry: got.entry },
          expected: want ? { index: want.index, parent: want.parent, entry: want.entry } : null,
        });
      }
      continue;
    }
    if (!Array.isArray(want.world) || want.world.length !== 12) {
      mismatches += 12;
      elements += 12;
      if (differences.length < 8) differences.push({ kind: "width", index, actual: want.world?.length ?? null, expected: 12 });
      continue;
    }
    for (let element = 0; element < 12; element += 1) {
      elements += 1;
      if (got.world[element] === want.world[element]) continue;
      mismatches += 1;
      if (differences.length < 8) {
        differences.push({
          kind: "element",
          index: got.index,
          parent: got.parent,
          entry: got.entry,
          element,
          actual: got.world[element],
          expected: want.world[element],
          rawLocal: got.raw,
          localAfterFromRows: got.boundary,
        });
      }
    }
  }
  return {
    occurrences: composed.nodes.length,
    oracleOccurrences: oracleNodes.length,
    elements,
    mismatches,
    rawNegZeros: composed.rawNegZeros,
    boundaryNegZeros: composed.boundaryNegZeros,
    rawBoundaryDifferences: composed.rawBoundaryDifferences,
    first: differences[0] ?? null,
    differences,
  };
}
