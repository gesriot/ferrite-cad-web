import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { blake3 } from "@noble/hashes/blake3";
import { decodeCbor, encodeArray, encodeBytes, encodeFloat, encodeMap, encodeText, encodeUint, field, spliceBytes, type CborNode } from "./cbor.ts";
import { readEmbeddedStep, readFcad } from "./fcad-doc.ts";
import { writeImportedDocument } from "./fcad-import.ts";
import { bindImportedScene, decodeImportedPayload, rustTrimmedEmpty } from "./fcad-scene.ts";
import { wrapSql, type SqlDb } from "./sql.ts";
import { uuidV7 } from "./uuid.ts";
import type { PortableScene } from "../xde/types.ts";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../..", import.meta.url));
const probeDir = join(root, "test-data/scene-type-probes");
const wireDir = join(root, "test-data/wire-probes");
const wasm = readFileSync(new URL("../../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url));
const initSqlJs = require("sql.js") as (opts: { wasmBinary: Uint8Array }) => Promise<{
  Database: new (data?: Uint8Array) => Parameters<typeof wrapSql>[0];
}>;
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function open(bytes: Uint8Array): Promise<SqlDb> {
  SQL ??= await initSqlJs({ wasmBinary: wasm });
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const db = wrapSql(new SQL.Database(copy));
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function text(value: string): CborNode {
  return { type: "text", start: 0, end: 0, value };
}
function uint(value: number): CborNode {
  return { type: "uint", start: 0, end: 0, value };
}
function float(value: number): CborNode {
  return { type: "float", start: 0, end: 0, value };
}
function bytes(value: Uint8Array): CborNode {
  return { type: "bytes", start: 0, end: 0, value };
}
function map(entries: Array<[string, CborNode]>): CborNode {
  return { type: "map", start: 0, end: 0, entries: entries.map(([key, value]) => ({ key: text(key), value })) };
}
function arr(items: CborNode[]): CborNode {
  return { type: "array", start: 0, end: 0, items };
}
function nil(): CborNode {
  return { type: "null", start: 0, end: 0, value: null };
}
function child(node: CborNode, key: string): any {
  if (node.type !== "map") throw new Error(key);
  const found = node.entries.find((entry) => entry.key.type === "text" && entry.key.value === key);
  if (!found) throw new Error(`missing ${key}`);
  return found.value;
}
function at(node: CborNode, index: number): any {
  if (node.type !== "array") throw new Error("array");
  return node.items[index]!;
}

function identityPlacement(): CborNode[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].map((value) => float(value));
}

function validPayload(): CborNode {
  return map([
    ["source", bytes(uuidV7())],
    ["source_hash", bytes(new Uint8Array(32))],
    ["source_byte_len", uint(12)],
    ["scene", map([
      ["source_unit", text("millimetre")],
      ["schema", text("AP242")],
      ["definitions", arr([
        map([
          ["key", text("step.product_definition#5")],
          ["name", text("Plate")],
          ["solids", uint(1)],
          ["kept", text("unknown")],
        ]),
      ])],
      ["instances", arr([
        map([
          ["occurrence", bytes(uuidV7())],
          ["definition", text("step.product_definition#5")],
          ["name", text("Plate\uFEFF")],
          ["placement", arr(identityPlacement())],
          ["colour_source", text("none")],
          ["colour", arr([float(0), float(0), float(0)])],
        ]),
      ])],
    ])],
    ["imported_by", map([
      ["id", text("opencascade.js")],
      ["version", text("3.0.0-beta.3")],
      ["build", text("")],
    ])],
    ["diagnostics_at_import", arr([
      map([
        ["stage", text("validation")],
        ["severity", text("warning")],
        ["entity", text("solid")],
        ["message", text("historical\uFEFF")],
      ]),
    ])],
    ["review_note", text("kept")],
  ]);
}

function instance(payload: CborNode): CborNode {
  return at(child(child(payload, "scene"), "instances"), 0);
}
function definition(payload: CborNode): CborNode {
  return at(child(child(payload, "scene"), "definitions"), 0);
}

test("a known payload keeps token types, a missing option, an unknown field and historical diagnostics", () => {
  const payload = validPayload();
  const decoded = decodeImportedPayload(payload, 3);
  assert.equal(decoded.scene?.instances[0]?.parent, null);
  assert.equal(decoded.scene?.instances[0]?.name, "Plate\uFEFF");
  assert.equal(decoded.diagnostics[0]?.message, "historical\uFEFF");
  assert.equal(decoded.scene?.diagnostics[0]?.message, "historical\uFEFF");
  assert.equal(decoded.importer.build, "");
  assert.equal(child(payload, "review_note").type === "text" && (child(payload, "review_note") as { value: string }).value, "kept");
  assert.equal(child(definition(payload), "kept").type, "text");
});

test("fixed arrays reject non-floats while a missing parent stays None", () => {
  const cases: Array<[string, (payload: CborNode) => void, RegExp]> = [
    ["placement uint", (payload) => { at(child(instance(payload), "placement"), 0).type = "uint"; }, /expected float/],
    ["placement bool", (payload) => { const item = at(child(instance(payload), "placement"), 0); item.type = "bool"; item.value = true; }, /expected float/],
    ["placement null", (payload) => { const item = at(child(instance(payload), "placement"), 0); item.type = "null"; item.value = null; }, /expected float/],
    ["placement text", (payload) => { const item = at(child(instance(payload), "placement"), 0); item.type = "text"; item.value = "1"; }, /expected float/],
    ["colour null", (payload) => { const item = at(child(instance(payload), "colour"), 0); item.type = "null"; item.value = null; }, /expected float/],
    ["solids float", (payload) => { const item = child(definition(payload), "solids"); item.type = "float"; item.value = 1; }, /expected u32/],
    ["solids text", (payload) => { const item = child(definition(payload), "solids"); item.type = "text"; item.value = "1"; }, /expected u32/],
    ["solids nint", (payload) => { const item = child(definition(payload), "solids"); item.type = "nint"; item.value = -1; }, /expected u32/],
    ["importer null", (payload) => { const item = child(payload, "imported_by"); item.type = "null"; item.value = null; }, /expected map/],
    ["diagnostics text", (payload) => { const item = child(payload, "diagnostics_at_import"); item.type = "text"; item.value = "warning"; }, /expected array/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const payload = validPayload();
    mutate(payload);
    assert.throws(() => decodeImportedPayload(payload, 3), pattern, name);
  }
  const missingParent = validPayload();
  assert.equal(decodeImportedPayload(missingParent, 3).scene?.instances[0]?.parent, null);
  const explicitNull = validPayload();
  (instance(explicitNull) as { entries: { key: CborNode; value: CborNode }[] }).entries.push({ key: text("parent"), value: nil() });
  assert.equal(decodeImportedPayload(explicitNull, 3).scene?.instances[0]?.parent, null);
});

test("importer, diagnostics, ranges and duplicate keys follow the stored contract", () => {
  const missingImporter = validPayload();
  (missingImporter as { entries: { key: CborNode; value: CborNode }[] }).entries = (missingImporter as { entries: { key: CborNode; value: CborNode }[] }).entries.filter((entry) => entry.key.type !== "text" || entry.key.value !== "imported_by");
  assert.throws(() => decodeImportedPayload(missingImporter, 3), /missing imported_by/);

  const blankId = validPayload();
  child(child(blankId, "imported_by"), "id").value = "   ";
  assert.throws(() => decodeImportedPayload(blankId, 3), /imported_by.id is empty/);

  const blankVersion = validPayload();
  child(child(blankVersion, "imported_by"), "version").value = "";
  assert.throws(() => decodeImportedPayload(blankVersion, 3), /imported_by.version is empty/);

  const missingBuild = validPayload();
  const importer = child(missingBuild, "imported_by");
  if (importer.type === "map") importer.entries = importer.entries.filter((entry: { key: CborNode; value: CborNode }) => entry.key.type !== "text" || entry.key.value !== "build");
  assert.throws(() => decodeImportedPayload(missingBuild, 3), /missing build/);

  const badStage = validPayload();
  child(at(child(badStage, "diagnostics_at_import"), 0), "stage").value = "mesh";
  assert.throws(() => decodeImportedPayload(badStage, 3), /expected load\|transfer\|identity\|validation/);

  const wide = validPayload();
  child(definition(wide), "solids").value = 0xffffffff;
  assert.equal(decodeImportedPayload(wide, 3).scene?.definitions[0]?.solids, 0xffffffff);

  const tooWide = validPayload();
  child(definition(tooWide), "solids").value = 0x1_0000_0000;
  assert.throws(() => decodeImportedPayload(tooWide, 3), /expected u32/);

  const forward = validPayload();
  (instance(forward) as { entries: { key: CborNode; value: CborNode }[] }).entries.push({ key: text("parent"), value: uint(0) });
  assert.throws(() => decodeImportedPayload(forward, 3), /parent is not an earlier instance/);

  const repeated = validPayload();
  const defs = child(child(repeated, "scene"), "definitions");
  if (defs.type === "array") defs.items.push(defs.items[0]!);
  assert.throws(() => decodeImportedPayload(repeated, 3), /repeats key/);

  const nan = validPayload();
  at(child(instance(nan), "placement"), 3).value = Number.NaN;
  assert.throws(() => decodeImportedPayload(nan, 3), /not finite/);

  const withoutName = validPayload();
  if (withoutName.type === "map") withoutName.entries = withoutName.entries.filter((entry) => entry.key.type !== "text" || entry.key.value !== "source_name");
  assert.equal(decodeImportedPayload(withoutName, 3).sourceName, null);
  const nullName = validPayload();
  if (nullName.type === "map") nullName.entries.push({ key: text("source_name"), value: nil() });
  assert.equal(decodeImportedPayload(nullName, 3).sourceName, null);
  const badName = validPayload();
  if (badName.type === "map") badName.entries.push({ key: text("source_name"), value: uint(1) });
  assert.throws(() => decodeImportedPayload(badName, 3), /source_name is integer 1, expected text/);
});

test("schema 1 decodes its own layout and schema 2 binds by key without occurrences", () => {
  const legacy = validPayload();
  const scene = child(legacy, "scene");
  const def = definition(legacy);
  if (def.type === "map") def.entries = def.entries.filter((entry) => entry.key.type !== "text" || entry.key.value !== "key");
  const row = instance(legacy);
  if (row.type === "map") {
    row.entries = row.entries.filter((entry) => entry.key.type !== "text" || (entry.key.value !== "occurrence" && entry.key.value !== "definition"));
    row.entries.push({ key: text("definition"), value: uint(0) });
  }
  const decoded = decodeImportedPayload(legacy, 1);
  assert.equal(decoded.scene, null);
  assert.equal(decoded.diagnostics[0]?.message, "historical\uFEFF");
  assert.equal(scene.type, "map");
  const badIndex = validPayload();
  const badRow = instance(badIndex);
  if (badRow.type === "map") {
    badRow.entries = badRow.entries.filter((entry) => entry.key.type !== "text" || (entry.key.value !== "occurrence" && entry.key.value !== "definition"));
    badRow.entries.push({ key: text("definition"), value: float(0) });
  }
  const badDef = definition(badIndex);
  if (badDef.type === "map") badDef.entries = badDef.entries.filter((entry) => entry.key.type !== "text" || entry.key.value !== "key");
  assert.throws(() => decodeImportedPayload(badIndex, 1), /expected u32/);

  const keyed = validPayload();
  const keyedRow = instance(keyed);
  if (keyedRow.type === "map") keyedRow.entries = keyedRow.entries.filter((entry) => entry.key.type !== "text" || entry.key.value !== "occurrence");
  const stored = decodeImportedPayload(keyed, 2).scene;
  assert.ok(stored);
  assert.equal(stored?.instances[0]?.occurrence, undefined);
  const fresh: PortableScene = {
    sourceUnit: stored!.sourceUnit,
    schema: stored!.schema,
    definitions: stored!.definitions.map((item) => ({ ...item })),
    instances: stored!.instances.map((item) => ({ ...item, occurrence: uuidV7() })),
    diagnostics: [],
  };
  const bound = bindImportedScene(stored, fresh);
  assert.equal(bound.confirmed, true, bound.error ?? "");
});

const rejected = [
  "placement-string.fcad",
  "placement-bool.fcad",
  "placement-null.fcad",
  "placement-integer.fcad",
  "colour-null.fcad",
  "solids-string.fcad",
  "solids-float.fcad",
  "importer-null.fcad",
  "diagnostics-string.fcad",
];

test("scene-type probes match the native accept and refuse sets", async () => {
  for (const name of rejected) {
    const db = await open(readFileSync(join(probeDir, name)));
    try {
      const opened = readFcad(db);
      assert.equal(opened.ok, false, name);
      assert.throws(() => readEmbeddedStep(db), /.+/);
    } finally {
      db.close();
    }
  }
  for (const name of ["positive-control.fcad", "positive-float32-placement.fcad", "missing-root-parent.fcad"]) {
    const bytes = readFileSync(join(probeDir, name));
    const db = await open(bytes);
    try {
      const opened = readFcad(db);
      assert.equal(opened.ok, true, name);
      const extracted = readEmbeddedStep(db);
      assert.ok(extracted.step.byteLength > 0, name);
      assert.ok(extracted.scene, name);
      assert.equal(extracted.scene?.instances[0]?.parent, null, name);
      assert.equal(extracted.meta.sourceLinkOk, true);
    } finally {
      db.close();
    }
  }
  const float32 = readFileSync(join(probeDir, "positive-float32-placement.fcad"));
  const db = await open(float32);
  try {
    const payload = db.get("SELECT payload FROM objects")![0] as Uint8Array;
    const inner = decodeCbor((field(decodeCbor(payload), "payload") as { type: "bytes"; value: Uint8Array }).value);
    const placement = child(instance(inner), "placement");
    assert.equal(at(placement, 0).type, "float");
    assert.equal(at(placement, 0).end - at(placement, 0).start, 5);
  } finally {
    db.close();
  }
  const present = new Set(readdirSync(probeDir).filter((name) => name.endsWith(".fcad")));
  for (const name of [...rejected, "positive-control.fcad", "positive-float32-placement.fcad", "missing-root-parent.fcad"]) {
    assert.equal(present.has(name), true);
  }
});

test("an unknown field stays in the stored bytes and a schema 1 document is checked before its STEP is returned", async () => {
  SQL ??= await initSqlJs({ wasmBinary: wasm });
  const db = wrapSql(new SQL.Database());
  const step = new TextEncoder().encode("ISO-10303-21; END-ISO-10303-21;");
  const scene: PortableScene = {
    sourceUnit: "millimetre",
    schema: "AP242",
    definitions: [{ key: "step.product_definition#5", name: "Plate", solids: 1 }],
    instances: [{
      occurrence: uuidV7(),
      definition: "step.product_definition#5",
      parent: null,
      name: "Plate",
      placement: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      colourSource: "none",
      colour: [0, 0, 0],
    }],
    diagnostics: [{ stage: "validation", severity: "warning", entity: "solid", message: "historical" }],
  };
  const original = writeImportedDocument(db, { step, sourceName: "probe.step", objectName: "probe", scene });
  const opened = await open(original);
  try {
    const payload = opened.get("SELECT payload FROM objects")![0] as Uint8Array;
    const raw = field(decodeCbor(payload), "payload");
    if (raw.type !== "bytes") throw new Error("payload");
    const header = raw.value[0]!;
    assert.equal(header >> 5, 5);
    assert.ok((header & 31) < 24);
    const addition = concat(encodeText("review_note"), encodeText("kept"));
    const grown = concat(Uint8Array.of(header + 1), raw.value.subarray(1), addition);
    const next = spliceBytes(payload, [{ start: raw.start, end: raw.end, next: encodeBytes(grown) }]);
    const id = opened.get("SELECT id FROM objects")![0] as Uint8Array;
    opened.run("UPDATE objects SET payload = ?, payload_hash = ? WHERE id = ?", [next, blake3(next), id]);
    const read = readFcad(opened);
    assert.equal(read.ok, true);
    const extracted = readEmbeddedStep(opened);
    assert.equal(extracted.scene?.diagnostics[0]?.message, "historical");
    const stored = opened.get("SELECT payload FROM objects")![0] as Uint8Array;
    assert.equal(Buffer.from(stored).includes(Buffer.from("review_note")), true);

    const inner = decodeCbor((field(decodeCbor(next), "payload") as { type: "bytes"; value: Uint8Array }).value);
    const decoded = decodeImportedPayload(inner, 3);
    const legacy = encodeMap([
      ["source", encodeBytes(decoded.source)],
      ["source_hash", encodeBytes(decoded.sourceHash)],
      ["source_byte_len", encodeUint(decoded.sourceByteLen)],
      ["scene", encodeMap([
        ["source_unit", encodeText("millimetre")],
        ["schema", encodeText("AP242")],
        ["definitions", encodeArray([encodeMap([
          ["name", encodeText("Plate")],
          ["solids", encodeUint(1)],
        ])])],
        ["instances", encodeArray([encodeMap([
          ["definition", encodeUint(0)],
          ["name", encodeText("Plate")],
          ["placement", encodeArray([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].map((value) => encodeFloat(value)))],
          ["colour_source", encodeText("none")],
          ["colour", encodeArray([0, 0, 0].map((value) => encodeFloat(value)))],
        ])])],
      ])],
      ["imported_by", encodeMap([
        ["id", encodeText(decoded.importer.id)],
        ["version", encodeText(decoded.importer.version)],
        ["build", encodeText(decoded.importer.build)],
      ])],
      ["diagnostics_at_import", encodeArray([])],
    ]);
    const legacyEnvelope = encodeMap([
      ["type", encodeText("exchange.step.imported")],
      ["schema_version", encodeUint(1)],
      ["required_capabilities", encodeArray([encodeText("exchange.step.imported.v1")])],
      ["payload", encodeBytes(legacy)],
    ]);
    opened.run("UPDATE objects SET payload = ?, payload_hash = ? WHERE id = ?", [legacyEnvelope, blake3(legacyEnvelope), id]);
    const legacyOpened = readFcad(opened);
    assert.equal(legacyOpened.ok, false, "current contract rejects schema_version in the envelope");
    assert.match(legacyOpened.ok ? "" : legacyOpened.error, /schema_version/);

    const brokenInner = decodeCbor(legacy);
    const solids = child(definition(brokenInner), "solids");
    const floatSolids = encodeFloat(1);
    const brokenPayload = spliceBytes(legacy, [{ start: solids.start, end: solids.end, next: floatSolids }]);
    const brokenEnvelope = encodeMap([
      ["type", encodeText("exchange.step.imported")],
      ["schema_version", encodeUint(1)],
      ["required_capabilities", encodeArray([encodeText("exchange.step.imported.v1")])],
      ["payload", encodeBytes(brokenPayload)],
    ]);
    opened.run("UPDATE objects SET payload = ?, payload_hash = ? WHERE id = ?", [brokenEnvelope, blake3(brokenEnvelope), id]);
    assert.equal(readFcad(opened).ok, false);
    assert.throws(() => readEmbeddedStep(opened), /schema_version/);
  } finally {
    opened.close();
    db.close();
  }
});

test("importer emptiness follows Rust trim, not JavaScript trim", () => {
  const cases: Array<[string, boolean]> = [
    ["", true],
    ["   ", true],
    ["\t\n\r\v\f", true],
    ["\u0085", true],
    ["\u00a0", true],
    ["\u1680", true],
    ["\u2003", true],
    ["\u2028", true],
    ["\u2029", true],
    ["\u3000", true],
    ["\u0085\u00a0\u3000", true],
    ["\ufeff", false],
    ["\u200b", false],
    ["\u200e", false],
    ["\ufeff\u0085", false],
    ["\u0085id", false],
    [" id ", false],
  ];
  for (const [value, empty] of cases) assert.equal(rustTrimmedEmpty(value), empty, JSON.stringify(value));
  const nelId = validPayload();
  child(child(nelId, "imported_by"), "id").value = "\u0085";
  assert.throws(() => decodeImportedPayload(nelId, 3), /imported_by.id is empty/);
  const nelVersion = validPayload();
  child(child(nelVersion, "imported_by"), "version").value = "\u0085";
  assert.throws(() => decodeImportedPayload(nelVersion, 3), /imported_by.version is empty/);
  const bomId = validPayload();
  child(child(bomId, "imported_by"), "id").value = "\ufeff";
  const bom = decodeImportedPayload(bomId, 3);
  assert.equal(bom.importer.id, "\ufeff");
  assert.equal(bom.importer.version, "3.0.0-beta.3");
  const bomVersion = validPayload();
  child(child(bomVersion, "imported_by"), "version").value = "\ufeff";
  const kept = decodeImportedPayload(bomVersion, 3);
  assert.equal(kept.importer.version, "\ufeff");
  assert.equal(kept.importer.id, "opencascade.js");
  const blankBuild = validPayload();
  child(child(blankBuild, "imported_by"), "build").value = "\u0085";
  assert.equal(decodeImportedPayload(blankBuild, 3).importer.build, "\u0085");
  const spaced = validPayload();
  child(child(spaced, "imported_by"), "id").value = "\u0085opencascade.js\u3000";
  assert.equal(decodeImportedPayload(spaced, 3).importer.id, "\u0085opencascade.js\u3000");
});

function encodeWideUint(value: bigint): Uint8Array {
  const out = new Uint8Array(9);
  const view = new DataView(out.buffer);
  out[0] = 0x1b;
  view.setBigUint64(1, value, false);
  return out;
}

function importedOf(payload: Uint8Array): { schema: number; inner: CborNode } {
  const rootNode = decodeCbor(payload);
  const schemaNode = rootNode.type === "map" ? rootNode.entries.find((entry) => entry.key.type === "text" && entry.key.value === "schema_version") : undefined;
  const raw = field(rootNode, "payload");
  if (raw.type !== "bytes") throw new Error("payload");
  return { schema: schemaNode && schemaNode.value.type === "uint" && typeof schemaNode.value.value === "number" ? schemaNode.value.value : 0, inner: decodeCbor(raw.value) };
}

test("integer width, range and token type stay separate, and unknown nested values are not text-keyed structs", () => {
  const one = decodeCbor(encodeWideUint(1n));
  assert.equal(one.type, "uint");
  assert.equal(one.value, 1);
  const maxU32 = decodeCbor(encodeWideUint(0xffffffffn));
  assert.equal(maxU32.type, "uint");
  assert.equal(maxU32.value, 0xffffffff);
  const pastU32 = decodeCbor(encodeWideUint(0x100000000n));
  assert.equal(pastU32.type, "uint");
  assert.equal(pastU32.value, 0x100000000);
  const pastSafe = decodeCbor(encodeWideUint((1n << 53n) + 1n));
  assert.equal(pastSafe.type, "uint");
  assert.equal(typeof pastSafe.value, "bigint");
  assert.equal(pastSafe.value, (1n << 53n) + 1n);
  assert.notEqual(Number(pastSafe.value), pastSafe.value);
  const negative = decodeCbor(Uint8Array.of(0x3b, 0, 0, 0, 0, 0, 0, 0, 1));
  assert.equal(negative.type, "nint");
  assert.equal(negative.value, -2);
  assert.throws(() => decodeCbor(Uint8Array.of(0x1b, 0, 0, 0, 1)), /truncated/);
  assert.throws(() => decodeCbor(Uint8Array.of(0x9b, 0, 0, 0, 1, 0, 0, 0, 0)), /exceeds the 0 bytes left/);
  const nested = decodeCbor(Uint8Array.of(0xa1, 0x01, 0x02));
  assert.equal(nested.type, "map");
  if (nested.type !== "map") return;
  const nestedKey = nested.entries[0]?.key;
  const nestedValue = nested.entries[0]?.value;
  if (!nestedKey || nestedKey.type !== "uint" || !nestedValue || nestedValue.type !== "uint") {
    assert.fail("nested map was not {1:2}");
  }
  assert.equal(nestedKey.value, 1);
  assert.equal(nestedValue.value, 2);
  const payload = validPayload();
  if (payload.type === "map") {
    payload.entries.push({
      key: text("review_extension"),
      value: { type: "map", start: 0, end: 0, entries: [{ key: uint(1), value: uint(2) }] },
    });
  }
  const decoded = decodeImportedPayload(payload, 3);
  assert.equal(decoded.scene?.definitions[0]?.solids, 1);
  assert.equal(decoded.importer.id, "opencascade.js");
  const wideSolids = validPayload();
  child(definition(wideSolids), "solids").value = 1n;
  assert.equal(decodeImportedPayload(wideSolids, 3).scene?.definitions[0]?.solids, 1);
  const tooWide = validPayload();
  child(definition(tooWide), "solids").value = 0x100000000n;
  assert.throws(() => decodeImportedPayload(tooWide, 3), /expected u32/);
  const unsafeLen = validPayload();
  child(unsafeLen, "source_byte_len").value = (1n << 53n) + 1n;
  assert.throws(() => decodeImportedPayload(unsafeLen, 3), /expected u64/);
  const placement = validPayload();
  const placed = at(child(instance(placement), "placement"), 0);
  placed.type = "uint";
  placed.value = 1n;
  assert.throws(() => decodeImportedPayload(placement, 3), /expected float/);
});

test("attached wire probes follow the reviewer native oracle", async () => {
  const oracle = JSON.parse(readFileSync(join(wireDir, "expected-native.json"), "utf8")) as Array<{ file: string; exit: number }>;
  const byFile = new Map(oracle.map((row) => [row.file, row.exit]));
  const refused = ["importer-id-nel.fcad", "importer-version-nel.fcad"];
  const accepted = [
    "control.fcad",
    "importer-id-bom.fcad",
    "importer-version-bom.fcad",
    "solids-wide-uint.fcad",
    "source-length-wide-uint.fcad",
    "unknown-numeric-map.fcad",
  ];
  for (const name of refused) {
    assert.equal(byFile.get(name), 2, name);
    const db = await open(readFileSync(join(wireDir, name)));
    try {
      const opened = readFcad(db);
      if (opened.ok) assert.fail(`${name} was accepted`);
      assert.match(opened.error, /imported_by\.(id|version) is empty/);
      assert.throws(() => readEmbeddedStep(db), /empty/);
    } finally {
      db.close();
    }
  }
  const controlDb = await open(readFileSync(join(wireDir, "control.fcad")));
  let controlImporter: { id: string; version: string };
  try {
    const payload = controlDb.get("SELECT payload FROM objects")![0] as Uint8Array;
    const imported = importedOf(payload);
    controlImporter = decodeImportedPayload(imported.inner, imported.schema).importer;
  } finally {
    controlDb.close();
  }
  for (const name of accepted) {
    assert.equal(byFile.get(name), 0, name);
    const bytes = readFileSync(join(wireDir, name));
    const db = await open(bytes);
    try {
      const opened = readFcad(db);
      assert.equal(opened.ok, true, opened.ok ? name : opened.error);
      const extracted = readEmbeddedStep(db);
      assert.ok(extracted.step.byteLength > 0, name);
      assert.ok(extracted.scene, name);
      const payload = db.get("SELECT payload FROM objects")![0] as Uint8Array;
      const imported = importedOf(payload);
      const decoded = decodeImportedPayload(imported.inner, imported.schema);
      if (name === "importer-id-bom.fcad") {
        assert.equal(decoded.importer.id, "\ufeff");
        assert.equal(decoded.importer.version, controlImporter.version);
      }
      if (name === "importer-version-bom.fcad") {
        assert.equal(decoded.importer.version, "\ufeff");
        assert.equal(decoded.importer.id, controlImporter.id);
      }
      if (name === "solids-wide-uint.fcad") {
        assert.equal(decoded.scene?.definitions[0]?.solids, 1);
        const solids = child(definition(imported.inner), "solids");
        assert.equal(solids.type, "uint");
        assert.equal(solids.end - solids.start, 9);
      }
      if (name === "source-length-wide-uint.fcad") {
        const length = child(imported.inner, "source_byte_len");
        assert.equal(length.type, "uint");
        assert.equal(length.end - length.start, 9);
        assert.equal(decoded.sourceByteLen, extracted.step.byteLength);
      }
      if (name === "unknown-numeric-map.fcad") {
        assert.equal(Buffer.from(payload).includes(Buffer.from("review_extension")), true);
        const extension = child(imported.inner, "review_extension");
        assert.equal(extension.type, "map");
        assert.equal(extension.entries[0].key.type, "uint");
        assert.equal(extension.entries[0].key.value, 1);
        assert.equal(extension.entries[0].value.value, 2);
      }
    } finally {
      db.close();
    }
  }
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let atCursor = 0;
  for (const part of parts) {
    out.set(part, atCursor);
    atCursor += part.length;
  }
  return out;
}
