// @ts-nocheck
// Accepted placement arithmetic. Operation order must not be altered for the type checker.
/**
 * Software binary64 for the placement audit. Not a CAD kernel.
 *
 * `mul`, `add`, `sub`, `div` and `sqrt` are the IEEE operations JavaScript
 * already performs. `fma` is implemented here so `a*b+c` is never treated as
 * fused. NaN payloads are not preserved: every NaN result is one quiet NaN.
 * Infinities and signed zeros follow IEEE-754 roundTiesToEven, including the
 * exact-zero sign of fusedMultiplyAdd.
 */

const buffer = new ArrayBuffer(8);
const asFloat = new Float64Array(buffer);
const asBits = new BigUint64Array(buffer);

export const QNAN = 0x7ff8000000000000n;
const POS_INF = 0x7ff0000000000000n;
const NEG_INF = 0xfff0000000000000n;
const POS_ZERO = 0n;
const NEG_ZERO = 0x8000000000000000n;
const M52 = 1n << 52n;

export function bitsOf(value) {
  asFloat[0] = value;
  return asBits[0];
}

export function fromBits(bits) {
  asBits[0] = bits;
  return asFloat[0];
}

export function hexOf(value) {
  return bitsOf(value).toString(16).padStart(16, "0");
}

export function fromHex(hex) {
  return fromBits(BigInt(`0x${hex.padStart(16, "0")}`));
}

function bitLength(value) {
  if (value <= 0n) return 0;
  const hex = value.toString(16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(Number.parseInt(hex[0], 16)));
}

function classify(bits) {
  const sign = bits >> 63n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & (M52 - 1n);
  if (exp === 0x7ff) return frac === 0n ? { kind: "inf", sign } : { kind: "nan" };
  if (exp === 0) {
    if (frac === 0n) return { kind: "zero", sign };
    return { kind: "finite", sign, sig: frac, exp: -1074 };
  }
  return { kind: "finite", sign, sig: frac | M52, exp: exp - 1023 - 52 };
}

/** Round a positive magnitude whose value is mag * 2^exp. */
function roundPositive(mag, exp, sign) {
  const width = bitLength(mag);
  const msbExp = exp + BigInt(width - 1);
  if (msbExp > 1023n) return sign ? NEG_INF : POS_INF;
  if (msbExp >= -1022n) {
    const shift = BigInt(width) - 53n;
    const sig = shift >= 0n ? shiftRightTiesEven(mag, shift) : mag << -shift;
    const lsbExp = exp + shift;
    if (bitLength(sig) > 53) {
      const carried = lsbExp + 53n;
      if (carried > 1023n) return sign ? NEG_INF : POS_INF;
      return (sign << 63n) | ((carried + 1023n) << 52n);
    }
    const frac = sig & (M52 - 1n);
    return (sign << 63n) | ((lsbExp + BigInt(bitLength(sig) - 1) + 1023n) << 52n) | frac;
  }
  const shift = -1074n - exp;
  if (shift < 0n) {
    const mant = mag << -shift;
    if (mant >= M52) return roundPositive(mant, -1074n, sign);
    return (sign << 63n) | mant;
  }
  const mant = shiftRightTiesEven(mag, shift);
  if (mant === 0n) return sign ? NEG_ZERO : POS_ZERO;
  if (mant >= M52) return roundPositive(mant, -1074n, sign);
  return (sign << 63n) | mant;
}

function shiftRightTiesEven(mag, shift) {
  if (shift <= 0n) return mag;
  const rest = mag & ((1n << shift) - 1n);
  let kept = mag >> shift;
  const half = 1n << (shift - 1n);
  if (rest > half || (rest === half && (kept & 1n) === 1n)) kept += 1n;
  return kept;
}

function finiteSigned(info) {
  if (info.kind === "zero") return { sig: 0n, exp: 0n };
  const sig = info.sign === 1n ? -info.sig : info.sig;
  return { sig, exp: BigInt(info.exp) };
}

/**
 * IEEE-754 fusedMultiplyAdd, roundTiesToEven.
 * A NaN argument, or a 0*Inf product, or Inf + opposite Inf, is the canonical quiet NaN.
 */
export function fma(a, b, c) {
  const ab = classify(bitsOf(a));
  const bb = classify(bitsOf(b));
  const cb = classify(bitsOf(c));
  if (ab.kind === "nan" || bb.kind === "nan" || cb.kind === "nan") return fromBits(QNAN);
  const aZero = ab.kind === "zero";
  const bZero = bb.kind === "zero";
  const aInf = ab.kind === "inf";
  const bInf = bb.kind === "inf";
  if ((aZero && bInf) || (bZero && aInf)) return fromBits(QNAN);
  const prodSign = (ab.sign ^ bb.sign) & 1n;
  if (aInf || bInf) {
    if (cb.kind === "inf" && cb.sign !== prodSign) return fromBits(QNAN);
    return fromBits(prodSign ? NEG_INF : POS_INF);
  }
  if (cb.kind === "inf") return c;
  const left = finiteSigned(ab);
  const right = finiteSigned(bb);
  const addend = finiteSigned(cb);
  const prod = {
    sig: left.sig * right.sig,
    exp: left.exp + right.exp,
  };
  let sumSig;
  let sumExp;
  if (prod.exp === addend.exp) {
    sumSig = prod.sig + addend.sig;
    sumExp = prod.exp;
  } else if (prod.exp > addend.exp) {
    sumSig = (prod.sig << (prod.exp - addend.exp)) + addend.sig;
    sumExp = addend.exp;
  } else {
    sumSig = prod.sig + (addend.sig << (addend.exp - prod.exp));
    sumExp = prod.exp;
  }
  if (sumSig === 0n) {
    const cZero = cb.kind === "zero";
    if ((aZero || bZero) && cZero && prodSign === 1n && cb.sign === 1n) return fromBits(NEG_ZERO);
    return fromBits(POS_ZERO);
  }
  const sign = sumSig < 0n ? 1n : 0n;
  const mag = sumSig < 0n ? -sumSig : sumSig;
  return fromBits(roundPositive(mag, sumExp, sign));
}

export function neg(value) {
  return fromBits(bitsOf(value) ^ 0x8000000000000000n);
}
