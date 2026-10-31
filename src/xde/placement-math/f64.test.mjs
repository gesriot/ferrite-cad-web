// @ts-nocheck
// Accepted placement arithmetic. Operation order must not be altered for the type checker.
import assert from "node:assert/strict";
import test from "node:test";
import { bitsOf, fma, fromBits, hexOf, neg } from "./f64.mjs";

function bits(hex) {
  return fromBits(BigInt(`0x${hex}`));
}

test("fused cancellation keeps a product bit that separate rounding loses", () => {
  const hi = 1 + 2 ** -52;
  const lo = 1 - 2 ** -52;
  const fused = fma(hi, lo, -1);
  assert.equal(hexOf(fused), hexOf(-(2 ** -104)));
  assert.equal(hexOf(hi * lo - 1), "0000000000000000");
});

test("ties to even on an inexact fused sum", () => {
  assert.equal(fma(2 ** 53, 1, 1), 2 ** 53);
  assert.equal(fma(2 ** 53, 1, 3), 2 ** 53 + 4);
  assert.equal(fma(2 ** 53, 1, 2), 2 ** 53 + 2);
});

test("signed zeros follow exact fused addition", () => {
  assert.equal(hexOf(fma(-0, 1, 0)), "0000000000000000");
  assert.equal(hexOf(fma(-0, 1, -0)), "8000000000000000");
  assert.equal(hexOf(fma(0, -1, 0)), "0000000000000000");
  assert.equal(hexOf(fma(-0, -1, -0)), "0000000000000000");
  assert.equal(hexOf(fma(1, -1, 1)), "0000000000000000");
  assert.equal(hexOf(neg(0)), "8000000000000000");
  assert.equal(hexOf(neg(-0)), "0000000000000000");
});

test("subnormals and the underflow boundary round ties to even", () => {
  const min = bits("0000000000000001");
  assert.equal(hexOf(fma(min, 1, 0)), "0000000000000001");
  assert.equal(hexOf(fma(min, 0.5, 0)), "0000000000000000");
  assert.equal(hexOf(fma(-min, 0.5, 0)), "8000000000000000");
  assert.equal(hexOf(fma(min, 0.5, min)), "0000000000000002");
  assert.equal(hexOf(fma(min, 0.25, 0)), "0000000000000000");
});

test("overflow, infinity and the stated NaN contract", () => {
  assert.equal(hexOf(fma(1e308, 1e308, 0)), "7ff0000000000000");
  assert.equal(hexOf(fma(-1e308, 1e308, 0)), "fff0000000000000");
  assert.equal(hexOf(fma(Infinity, 2, 5)), "7ff0000000000000");
  assert.equal(hexOf(fma(Infinity, -2, -5)), "fff0000000000000");
  assert.equal(hexOf(fma(Infinity, 0, 1)), "7ff8000000000000");
  assert.equal(hexOf(fma(0, Infinity, 1)), "7ff8000000000000");
  assert.equal(hexOf(fma(Infinity, 1, -Infinity)), "7ff8000000000000");
  assert.equal(hexOf(fma(NaN, 1, 2)), "7ff8000000000000");
  assert.equal(bitsOf(fma(1, 2, NaN)) & 0x7fffffffffffffffn, 0x7ff8000000000000n);
});

test("ordinary values match a rounded product plus addend when the product is exact", () => {
  assert.equal(fma(2, 3, 4), 10);
  assert.equal(fma(-1.5, 4, 0.5), -5.5);
  assert.equal(hexOf(fma(0.5, 0.5, 0.5)), hexOf(0.75));
});
