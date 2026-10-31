// @ts-nocheck
// Accepted placement arithmetic. Operation order must not be altered for the type checker.
/**
 * Placement arithmetic measured from the reviewer's Apple Clang 17 arm64
 * assembly of the inline OCCT 8.0.1 headers. Audit only.
 *
 * `contracted` follows probe-fast.s / the default Release probe:
 *   square sums start with y*y, then fused x*x, then fused z*z;
 *   each cross component a*b - c*d rounds c*d on its own, then fuses a*b - that.
 * `separate` follows probe-off.s: every multiply and add/sub rounds alone,
 * in the order that assembly actually emitted.
 *
 * SetTransformation is the installed TKMath dylib, not the probe translation unit.
 * `native-tkmath-transforms.s` fuses both overloads. See ORDER.md.
 * Signed zero is preserved in these raw gp_Trsf bits.
 */
import { fma, neg } from "./f64.mjs";

function squareContracted(x, y, z) {
  return fma(z, z, fma(x, x, y * y));
}

function squareSeparate(x, y, z) {
  return x * x + y * y + z * z;
}

function crossTerm(a, b, c, d, mode) {
  if (mode === "separate") return a * b - c * d;
  return fma(a, b, neg(c * d));
}

function dirFrom(x, y, z, square) {
  const sq = square(x, y, z);
  if (!(sq > 0)) throw new Error("gp_Dir input has no positive square modulus");
  if (sq === 1) return [x, y, z];
  const scale = Math.sqrt(sq);
  return [x / scale, y / scale, z / scale];
}

function crossCross(nx, ny, nz, vx, vy, vz, mode) {
  const cx = crossTerm(vy, nz, vz, ny, mode);
  const cy = crossTerm(vz, nx, vx, nz, mode);
  const cz = crossTerm(vx, ny, vy, nx, mode);
  const x = crossTerm(ny, cz, nz, cy, mode);
  const y = crossTerm(nz, cx, nx, cz, mode);
  const z = crossTerm(nx, cy, ny, cx, mode);
  const square = mode === "separate" ? squareSeparateResult : squareContracted;
  return dirFrom(x, y, z, square);
}

function squareSeparateResult(x, y, z) {
  return z * z + (x * x + y * y);
}

function cross(ax, ay, az, vx, vy, vz, mode) {
  const x = crossTerm(ay, vz, az, vy, mode);
  const y = crossTerm(az, vx, ax, vz, mode);
  const z = crossTerm(ax, vy, ay, vx, mode);
  const square = mode === "separate" ? squareSeparateResult : squareContracted;
  return dirFrom(x, y, z, square);
}

export function axisPlacement(location, axis, ref, mode) {
  const square = mode === "separate" ? squareSeparate : squareContracted;
  const [nx, ny, nz] = dirFrom(axis[0], axis[1], axis[2], square);
  const [rx, ry, rz] = dirFrom(ref[0], ref[1], ref[2], square);
  const [xx, xy, xz] = crossCross(nx, ny, nz, rx, ry, rz, mode);
  const [yx, yy, yz] = cross(nx, ny, nz, xx, xy, xz, mode);
  return {
    location: [location[0], location[1], location[2]],
    normalizedAxis: [nx, ny, nz],
    normalizedRef: [rx, ry, rz],
    x: [xx, xy, xz],
    y: [yx, yy, yz],
    z: [nx, ny, nz],
  };
}

/**
 * Installed TKMath dot, from both SetTransformation overloads:
 * `fma(row[2], v[2], fma(row[0], v[0], row[1] * v[1]))`.
 * The middle product is a separate multiply. The other two products are fused.
 */
function dotContracted(row, vector) {
  return fma(row[2], vector[2], fma(row[0], vector[0], row[1] * vector[1]));
}

/**
 * Translation of SetTransformation(ax3): the same dot, with the last product
 * fused into the negation (`fnmadd`), not a separate negate after rounding.
 */
function dotNegated(row, vector) {
  const head = fma(row[0], vector[0], row[1] * vector[1]);
  return fma(neg(row[2]), vector[2], neg(head));
}

function multiplyMatrixVector(matrix, vector) {
  return [dotContracted(matrix[0], vector), dotContracted(matrix[1], vector), dotContracted(matrix[2], vector)];
}

function multiplyMatrices(left, right) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const otherColumn = [right[0][column], right[1][column], right[2][column]];
      out[row][column] = dotContracted(left[row], otherColumn);
    }
  }
  return out;
}

function rowsOf(system) {
  return [system.x.slice(), system.y.slice(), system.z.slice()];
}

function columnsOf(system) {
  return [
    [system.x[0], system.y[0], system.z[0]],
    [system.x[1], system.y[1], system.z[1]],
    [system.x[2], system.y[2], system.z[2]],
  ];
}

/** gp_Trsf::SetTransformation(const gp_Ax3&). Rows are X,Y,Z. Translation is the fused negation of M * location. */
export function setTransformationOne(system) {
  const matrix = rowsOf(system);
  const translated = [dotNegated(matrix[0], system.location), dotNegated(matrix[1], system.location), dotNegated(matrix[2], system.location)];
  return pack(matrix, translated);
}

/**
 * gp_Trsf::SetTransformation(From, To). The probe label SetTransformation(item2, item1)
 * passes From=item2 and To=item1. Matrix products use dotContracted. The added
 * translation is a separate fadd, matching the dylib's fadd instructions.
 */
export function setTransformationPair(from, to) {
  const matrix = rowsOf(to);
  let loc = [dotNegated(matrix[0], to.location), dotNegated(matrix[1], to.location), dotNegated(matrix[2], to.location)];
  const fromMatrix = columnsOf(from);
  const shifted = multiplyMatrixVector(matrix, from.location);
  loc = [loc[0] + shifted[0], loc[1] + shifted[1], loc[2] + shifted[2]];
  return pack(multiplyMatrices(matrix, fromMatrix), loc);
}

/** Empty TopLoc_Location / free-shape root. Built here, not copied from an oracle. */
export function emptyLocationMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
}

function pack(matrix, loc) {
  const values = [];
  for (let row = 0; row < 3; row += 1) {
    values.push(matrix[row][0], matrix[row][1], matrix[row][2], loc[row]);
  }
  return values;
}

/** @param {{ index: number, item1?: { present?: boolean, location: number[], axis: number[], ref: number[] }, item2?: { present?: boolean, location: number[], axis: number[], ref: number[] } }} item @param {string} mode @returns {Record<string, number[]>} */
export function evaluateCase(item, mode) {
  const out = { index: item.index };
  const systems = [];
  for (const name of ["item1", "item2"]) {
    const side = item[name];
    if (!side?.present) continue;
    const system = axisPlacement(side.location, side.axis, side.ref, mode);
    systems.push(system);
    out[`${name}.normalizedAxis`] = system.normalizedAxis;
    out[`${name}.normalizedRef`] = system.normalizedRef;
    out[`${name}.ax3.x`] = system.x;
    out[`${name}.ax3.y`] = system.y;
    out[`${name}.ax3.z`] = system.z;
    out[`${name}.setTransformation`] = setTransformationOne(system);
  }
  if (systems.length === 2) {
    out["SetTransformation(item2, item1)"] = setTransformationPair(systems[1], systems[0]);
    out["SetTransformation(item1, item2)"] = setTransformationPair(systems[0], systems[1]);
  }
  return out;
}
