import assert from "node:assert/strict";
import test from "node:test";
import { coerceParameterValue, displayUnit, formatNum, isCountUnit, parseNum } from "./format.ts";

test("numbers display with a decimal point and still accept a comma", () => {
  assert.equal(formatNum(10.1), "10.1");
  assert.equal(formatNum(0.1), "0.1");
  assert.equal(formatNum(8), "8");
  assert.equal(parseNum("10,1"), 10.1);
  assert.equal(parseNum("10.1"), 10.1);
  assert.equal(displayUnit("мм"), "mm");
  assert.equal(displayUnit("°"), "°");
  assert.equal(displayUnit("шт"), "Count");
  assert.equal(displayUnit("count"), "Count");
});

test("legacy count units stay integers without renaming stored codes", () => {
  assert.equal(isCountUnit("шт"), true);
  assert.equal(isCountUnit("pcs"), true);
  assert.equal(isCountUnit("мм"), false);
  assert.equal(coerceParameterValue("шт", 6.6), 7);
  assert.equal(coerceParameterValue("pcs", 0.2), 1);
  assert.equal(coerceParameterValue("мм", 6.6), 6.6);
});
