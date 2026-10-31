import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { blake3 } from "@noble/hashes/blake3";
import initOpenCascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { cborToValue, decodeCbor, encodeBytes, encodeFloat, encodeMajor, encodeText, field, spliceBytes, type CborNode } from "./cbor.ts";
import { extrudeProfile, inspect, shapeFromStep, stepBytes } from "./brep.ts";
import { bytesEqual, patchExtrudeDistance } from "./fcad.ts";
import { kernelCurves, readFcad, saveHeight, type PartModel } from "./fcad-doc.ts";
import { wrapSql, type SqlDb } from "./sql.ts";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../..", import.meta.url));
const wasm = readFileSync(new URL("../../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url));

type InitSql = (opts: { wasmBinary: Uint8Array }) => Promise<{
  Database: new (data?: Uint8Array) => Parameters<typeof wrapSql>[0];
}>;
const initSqlJs = require("sql.js") as InitSql;
let SQL: Awaited<ReturnType<InitSql>> | null = null;

function fixture(name: string) {
  return new Uint8Array(readFileSync(new URL(`../../${name}`, import.meta.url)));
}

function openSync(bytes: Uint8Array): SqlDb {
  if (!SQL) throw new Error("sql.js is not ready");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const db = wrapSql(new SQL.Database(copy));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = DELETE");
  return db;
}

async function ready() {
  SQL ??= await initSqlJs({ wasmBinary: wasm });
}

function mustPart(bytes: Uint8Array): PartModel {
  const db = openSync(bytes);
  try {
    const doc = readFcad(db);
    if (!doc.ok) throw new Error(doc.error);
    if (!doc.editable) throw new Error(doc.reason);
    return doc.model;
  } finally {
    db.close();
  }
}

function near(actual: number, expected: number, tol = 0.001) {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} !~ ${expected} ±${tol}`);
}

test("fcad sqlite read, height rewrite and refusal", async () => {
  await ready();
  const plate = fixture("fixtures/original-plate.fcad");
  const profile = fixture("fixtures/additional/offset-l-profile.fcad");
  const plateModel = mustPart(plate);
  assert.equal(plateModel.distanceSource, "10");
  assert.equal(plateModel.distanceMm, 10);
  assert.equal(plateModel.curves.length, 4);
  assert.equal(plateModel.area, 2400);

  for (const value of [9, 15, 100, 10.1, 12.7]) {
    const encoded = encodeFloat(value);
    const decoded = decodeCbor(encoded);
    assert.equal(decoded.type, "float");
    if (decoded.type === "float") assert.equal(decoded.value, value);
  }
  assert.ok(encodeFloat(10.1).byteLength > encodeFloat(15).byteLength);

  const edited = saveHeight(plate, "15", openSync);
  const editedModel = mustPart(edited);
  assert.equal(editedModel.distanceSource, "15");
  assert.equal(editedModel.distanceMm, 15);
  assert.equal(editedModel.extrudeId, plateModel.extrudeId);
  assert.equal(editedModel.sketchId, plateModel.sketchId);
  assert.equal(editedModel.bodyId, plateModel.bodyId);
  assert.equal(editedModel.planeId, plateModel.planeId);
  assert.deepEqual(editedModel.curves, plateModel.curves);

  const db = openSync(plate);
  const raw = db.get("SELECT payload FROM objects WHERE kind = 'feature.extrude'");
  db.close();
  const originalPayload = (raw?.[0] as Uint8Array).slice();
  const patched = patchExtrudeDistance(originalPayload, "10.1");
  const beforeField = field(decodeCbor(originalPayload), "payload");
  const afterField = field(decodeCbor(patched), "payload");
  assert.ok(bytesEqual(originalPayload.subarray(0, beforeField.start), patched.subarray(0, afterField.start)));
  assert.ok(bytesEqual(originalPayload.subarray(beforeField.end), patched.subarray(afterField.end)));

  const wide = saveHeight(plate, "10.1", openSync);
  assert.equal(mustPart(wide).distanceMm, 10.1);
  const shorter = saveHeight(plate, "9", openSync);
  assert.equal(mustPart(shorter).distanceSource, "9");
  const longer = saveHeight(plate, "100", openSync);
  assert.equal(mustPart(longer).distanceSource, "100");

  const lModel = mustPart(profile);
  assert.equal(lModel.distanceSource, "12.7");
  assert.deepEqual(
    lModel.curves.map((curve) => curve.start),
    [
      [-10, 5],
      [50, 5],
      [50, 25],
      [10, 25],
      [10, 45],
      [-10, 45],
    ],
  );
  near(lModel.area, 1600, 1e-9);
  let current: Uint8Array<ArrayBufferLike> = profile;
  for (const [source, value] of [
    ["9", 9],
    ["100", 100],
    ["10.1", 10.1],
  ] as const) {
    current = saveHeight(current, source, openSync);
    const model = mustPart(current);
    assert.equal(model.distanceSource, source);
    assert.equal(model.distanceMm, value);
    assert.equal(model.extrudeId, lModel.extrudeId);
    assert.deepEqual(model.curves, lModel.curves);
  }

  const intact = plate.slice();
  for (const bad of ["0", "-3", "abc", ""]) {
    assert.throws(() => saveHeight(plate, bad, openSync));
  }
  assert.ok(bytesEqual(plate, intact));
  assert.equal(mustPart(plate).distanceMm, 10);

  const broken = openSync(plate.slice());
  const row = broken.get("SELECT id, payload FROM objects WHERE kind = 'feature.extrude'");
  const payload = (row?.[1] as Uint8Array).slice();
  payload[payload.length - 1] ^= 0xff;
  broken.run("UPDATE objects SET payload = ? WHERE id = ?", [payload, row?.[0] as Uint8Array]);
  const damaged = broken.export();
  broken.close();
  const damagedRead = readFcad(openSync(damaged));
  assert.equal(damagedRead.ok, false);

  const versionDb = openSync(plate.slice());
  versionDb.exec("PRAGMA user_version = 99");
  const versioned = versionDb.export();
  versionDb.close();
  assert.equal(readFcad(openSync(versioned)).ok, true);
  const versionedRead = readFcad(openSync(versioned));
  if (versionedRead.ok) assert.equal(versionedRead.editable, false);

  const depDb = openSync(plate.slice());
  depDb.exec("DELETE FROM deps WHERE role = 'profile'");
  const missingRole = depDb.export();
  depDb.close();
  const missingRoleRead = readFcad(openSync(missingRole));
  assert.equal(missingRoleRead.ok, false);
  if (!missingRoleRead.ok) assert.match(missingRoleRead.error, /reference\.missing-edge/);
  assert.throws(() => saveHeight(missingRole, "15", openSync));

  const dangling = openSync(plate.slice());
  dangling.exec("PRAGMA foreign_keys = OFF");
  dangling.run("UPDATE deps SET dependency_id = ? WHERE role = 'profile'", [new Uint8Array(16)]);
  const danglingBytes = dangling.export();
  dangling.close();
  assert.equal(readFcad(openSync(danglingBytes)).ok, false);

  const assembly = readFcad(openSync(fixture("fixtures/original-assembly.fcad")));
  assert.equal(assembly.ok, true);
  if (assembly.ok) assert.equal(assembly.editable, false);
  assert.throws(() => saveHeight(fixture("fixtures/original-assembly.fcad"), "15", openSync));
  assert.equal(root.length > 0, true);
});

test("fcad and step solids use the same extrude as the UI", async () => {
  await ready();
  setOC(await initOpenCascade());
  const plate = mustPart(fixture("fixtures/original-plate.fcad"));
  const plateBody = inspect(extrudeProfile(kernelCurves(plate.curves), plate.distanceMm));
  near(plateBody.volume, 24000);
  near(plateBody.bounds.min[0], 0);
  near(plateBody.bounds.max[2], 10);
  const raisedBytes = saveHeight(fixture("fixtures/original-plate.fcad"), "15", openSync);
  const raised = mustPart(raisedBytes);
  const raisedBody = inspect(extrudeProfile(kernelCurves(raised.curves), raised.distanceMm));
  near(raisedBody.volume, 36000);
  near(raisedBody.bounds.max[2], 15);

  let current: Uint8Array<ArrayBufferLike> = fixture("fixtures/additional/offset-l-profile.fcad");
  const original = mustPart(current);
  const volumes: Record<string, number> = { "12.7": 20320, "9": 14400, "100": 160000, "10.1": 16160 };
  near(inspect(extrudeProfile(kernelCurves(original.curves), original.distanceMm)).volume, volumes["12.7"]!);
  const bounds = inspect(extrudeProfile(kernelCurves(original.curves), original.distanceMm)).bounds;
  near(bounds.min[0], -10);
  near(bounds.min[1], 5);
  near(bounds.min[2], 0);
  near(bounds.max[0], 50);
  near(bounds.max[1], 45);
  near(bounds.max[2], 12.7);
  for (const source of ["9", "100", "10.1"]) {
    current = saveHeight(current, source, openSync);
    const model = mustPart(current);
    const info = inspect(extrudeProfile(kernelCurves(model.curves), model.distanceMm));
    near(info.volume, volumes[source]!);
    near(info.bounds.max[2], model.distanceMm);
    near(info.bounds.min[0], -10);
    near(info.bounds.max[0], 50);
    assert.equal(info.solidValid, true);
  }

  const single = new Uint8Array(readFileSync(new URL("../../fixtures/step/canonical/01-single-part.step", import.meta.url)));
  const inch = new Uint8Array(readFileSync(new URL("../../fixtures/step/canonical/05-inch-units.step", import.meta.url)));
  const singleShape = await shapeFromStep(single);
  const singleInfo = inspect(singleShape);
  near(singleInfo.volume, 24000);
  near(singleInfo.bounds.max[0] - singleInfo.bounds.min[0], 60);
  near(singleInfo.bounds.max[1] - singleInfo.bounds.min[1], 40);
  near(singleInfo.bounds.max[2] - singleInfo.bounds.min[2], 10);
  const singleOut = await stepBytes(singleShape);
  singleShape.delete();
  const singleAgain = await shapeFromStep(singleOut);
  near(inspect(singleAgain).volume, 24000);
  singleAgain.delete();

  const inchShape = await shapeFromStep(inch);
  const inchInfo = inspect(inchShape);
  near(inchInfo.volume, 16387.064);
  near(inchInfo.bounds.max[0] - inchInfo.bounds.min[0], 50.8);
  near(inchInfo.bounds.max[1] - inchInfo.bounds.min[1], 25.4);
  near(inchInfo.bounds.max[2] - inchInfo.bounds.min[2], 12.7);
  const inchOut = await stepBytes(inchShape);
  inchShape.delete();
  const inchAgain = await shapeFromStep(inchOut);
  near(inspect(inchAgain).volume, 16387.064);
  inchAgain.delete();
});

test("invalid documents are refused without a fixture-name allowlist", async () => {
  await ready();
  const plate = fixture("fixtures/original-plate.fcad");
  const intact = plate.slice();
  const probes = [
    "test-data/historical-integrity/parent-cycle.fcad",
    "test-data/historical-integrity/topology-producer-not-feature.fcad",
    "test-data/historical-integrity/topology-orphan-owner.fcad",
    "test-data/historical-integrity/missing-profile-dependency.fcad",
    "test-data/historical-integrity/not-sqlite.fcad",
  ];
  for (const name of probes) {
    const bytes = fixture(name);
    if (name.endsWith("not-sqlite.fcad")) {
      assert.throws(() => readFcad(openSync(bytes)));
      assert.throws(() => saveHeight(bytes, "15", openSync));
      continue;
    }
    const read = readFcad(openSync(bytes));
    assert.equal(read.ok, false, name);
    assert.throws(() => saveHeight(bytes, "15", openSync), name);
  }
  const orphan = readFcad(openSync(fixture("test-data/historical-integrity/topology-orphan-owner.fcad")));
  if (!orphan.ok) assert.match(orphan.error, /UUIDv7|foreign_key_check/);

  function mutate(sql: string, params?: Uint8Array[]) {
    const db = openSync(plate.slice());
    db.exec("PRAGMA foreign_keys = OFF");
    if (params) db.run(sql, params);
    else db.exec(sql);
    const bytes = db.export();
    db.close();
    return bytes;
  }

  function uuidV7(seed: number) {
    const bytes = new Uint8Array(16);
    const time = BigInt(Date.UTC(2026, 9, 17)) + BigInt(seed);
    bytes[0] = Number((time >> 40n) & 0xffn);
    bytes[1] = Number((time >> 32n) & 0xffn);
    bytes[2] = Number((time >> 24n) & 0xffn);
    bytes[3] = Number((time >> 16n) & 0xffn);
    bytes[4] = Number((time >> 8n) & 0xffn);
    bytes[5] = Number(time & 0xffn);
    bytes[6] = 0x70 | ((seed >> 8) & 0x0f);
    bytes[7] = seed & 0xff;
    bytes[8] = 0x80;
    bytes[9] = 0x11;
    bytes[15] = seed & 0xff;
    return bytes;
  }

  const variants = [
    mutate(
      "UPDATE objects SET name = 'Renamed plane' WHERE kind = 'datum.plane'; UPDATE objects SET parent_id = (SELECT id FROM objects WHERE kind = 'sketch') WHERE kind = 'datum.plane'; UPDATE objects SET parent_id = (SELECT id FROM objects WHERE kind = 'datum.plane') WHERE kind = 'sketch'",
    ),
    mutate("UPDATE topology_refs SET producer_feature = (SELECT id FROM objects WHERE kind = 'body')"),
    mutate("UPDATE topology_refs SET owner_id = ?", [uuidV7(41)]),
    mutate("DELETE FROM deps WHERE role = 'body_tip'"),
  ];
  for (const bytes of variants) {
    const read = readFcad(openSync(bytes));
    assert.equal(read.ok, false);
    assert.throws(() => saveHeight(bytes, "16", openSync));
  }
  assert.ok(bytesEqual(plate, intact));
  assert.equal(mustPart(plate).distanceMm, 10);
  const assembly = readFcad(openSync(fixture("fixtures/original-assembly.fcad")));
  assert.equal(assembly.ok, true);
  if (assembly.ok) assert.equal(assembly.editable, false);
});

test("known editable payloads reject wrong types instead of coercing them", async () => {
  await ready();
  const plate = fixture("fixtures/original-plate.fcad");
  const intact = plate.slice();
  const probes: [string, RegExp][] = [
    ["test-data/historical-field-types/extrude-reversed-string.fcad", /expected bool/],
    ["test-data/historical-field-types/curve-construction-string.fcad", /expected bool/],
    ["test-data/historical-field-types/coordinate-numeric-string.fcad", /expected f64/],
    ["test-data/historical-field-types/extrude-reversed-string-saved.fcad", /expected bool/],
    ["test-data/historical-field-types/curve-construction-string-saved.fcad", /expected bool/],
    ["test-data/historical-field-types/coordinate-numeric-string-saved.fcad", /expected f64/],
    ["test-data/historical-structure/topology-side-invalid.fcad", /unknown variant|start` or `end/],
    ["test-data/historical-structure/topology-side-invalid-saved.fcad", /unknown variant|start` or `end/],
    ["test-data/historical-structure/topology-fallback-bool.fcad", /expected map/],
    ["test-data/historical-structure/topology-fallback-bool-saved.fcad", /expected map/],
    ["test-data/historical-structure/sketch-constraints-null.fcad", /expected array/],
    ["test-data/historical-structure/sketch-constraints-null-saved.fcad", /expected array/],
  ];
  for (const [name, pattern] of probes) {
    const bytes = fixture(name);
    const read = readFcad(openSync(bytes));
    assert.equal(read.ok, false, name);
    if (!read.ok) assert.match(read.error, pattern, name);
    assert.throws(() => saveHeight(bytes, "15", openSync), name);
  }

  function retarget(where: string, path: (string | number)[], next: Uint8Array) {
    const db = openSync(plate.slice());
    db.exec("PRAGMA foreign_keys = OFF");
    const row = db.get(`SELECT id, payload FROM objects WHERE ${where}`);
    if (!row) throw new Error(`нет строки ${where}`);
    const payload = rewritePayload(row[1] as Uint8Array, path, next);
    db.run("UPDATE objects SET payload = ?, payload_hash = ? WHERE id = ?", [payload, blake3(payload), row[0] as string]);
    const bytes = db.export();
    db.close();
    return bytes;
  }

  const variants: [Uint8Array, RegExp][] = [
    [retarget("kind = 'feature.extrude'", ["reversed"], Uint8Array.of(0xf6)), /expected bool/],
    [retarget("kind = 'feature.extrude'", ["reversed"], Uint8Array.of(0x01)), /expected bool/],
    [retarget("kind = 'sketch'", ["curves", 0, "construction"], Uint8Array.of(0xf6)), /expected bool/],
    [retarget("kind = 'sketch'", ["curves", 0, "geometry", "start", "x"], Uint8Array.of(0xf6)), /expected f64/],
    [retarget("kind = 'sketch'", ["curves", 0, "geometry", "start"], Uint8Array.of(0xf6)), /карта|start/],
    [retarget("kind = 'feature.extrude'", ["operation"], encodeText("sideways")), /expected enum/],
    [retarget("kind = 'feature.extrude'", ["end_condition", "kind"], encodeText("until")), /expected enum/],
    [retarget("kind = 'feature.extrude'", ["profile"], Uint8Array.of(0xf6)), /BLOB|profile/],
    [retarget("kind = 'feature.extrude'", ["end_condition", "distance", "value"], encodeText("16")), /expected f64/],
  ];
  for (const [bytes, pattern] of variants) {
    const read = readFcad(openSync(bytes));
    assert.equal(read.ok, false, pattern.source);
    if (!read.ok) assert.match(read.error, pattern);
    assert.throws(() => saveHeight(bytes, "15", openSync));
  }
  assert.equal(readFcad(openSync(plate)).ok, true);
  assert.equal(mustPart(plate).distanceMm, 10);
  assert.ok(bytesEqual(plate, intact));
});

function rewritePayload(payload: Uint8Array, path: (string | number)[], replacement: Uint8Array) {
  const envelope = decodeCbor(payload);
  const raw = field(envelope, "payload");
  if (raw.type !== "bytes") throw new Error("payload");
  let node = decodeCbor(raw.value);
  for (const key of path) {
    if (typeof key === "number") {
      if (node.type !== "array") throw new Error("array");
      node = node.items[key]!;
    } else {
      node = field(node, key);
    }
  }
  const inner = spliceBytes(raw.value, [{ start: node.start, end: node.end, next: replacement }]);
  return spliceBytes(payload, [{ start: raw.start, end: raw.end, next: encodeBytes(inner) }]);
}

test("editable slice follows the Rust field contract", async () => {
  await ready();
  const plate = fixture("fixtures/original-plate.fcad");
  const opened = readFcad(openSync(plate));
  assert.equal(opened.ok && opened.editable, true);

  function store(table: "objects" | "topology_refs", where: string, payload: Uint8Array) {
    const db = openSync(plate.slice());
    const row = db.get(`SELECT id, payload FROM ${table} WHERE ${where}`);
    if (!row) throw new Error(where);
    db.run(`UPDATE ${table} SET payload = ?, payload_hash = ? WHERE id = ?`, [payload, blake3(payload), row[0] as Uint8Array]);
    const bytes = db.export();
    db.close();
    return bytes;
  }
  function objectPayload(where: string) {
    const db = openSync(plate.slice());
    const row = db.get(`SELECT payload FROM objects WHERE ${where}`);
    db.close();
    if (!row) throw new Error(where);
    return row[0] as Uint8Array;
  }
  function topoPayload(where: string) {
    const db = openSync(plate.slice());
    const row = db.get(`SELECT payload FROM topology_refs WHERE ${where}`);
    db.close();
    if (!row) throw new Error(where);
    return row[0] as Uint8Array;
  }
  const refuse = (bytes: Uint8Array, pattern: RegExp) => {
    const read = readFcad(openSync(bytes));
    assert.equal(read.ok, false, pattern.source);
    if (!read.ok) assert.match(read.error, pattern, read.error);
    assert.throws(() => saveHeight(bytes, "15", openSync));
  };
  const keepOut = (bytes: Uint8Array, pattern: RegExp) => {
    const read = readFcad(openSync(bytes));
    assert.equal(read.ok, true, read.ok ? pattern.source : read.error);
    if (read.ok) assert.equal(read.editable, false);
    if (read.ok && !read.editable) assert.match(read.reason, pattern);
    assert.throws(() => saveHeight(bytes, "15", openSync));
  };

  const withoutReversed = store("objects", "kind = 'feature.extrude'", omitField(objectPayload("kind = 'feature.extrude'"), ["reversed"]));
  assert.equal(mustPart(withoutReversed).distanceMm, 10);
  assert.equal(readFcad(openSync(saveHeight(withoutReversed, "15", openSync))).ok, true);
  const withoutConstruction = store("objects", "kind = 'sketch'", omitField(objectPayload("kind = 'sketch'"), ["curves", 0, "construction"]));
  assert.equal(mustPart(withoutConstruction).distanceMm, 10);
  const emptyConstraints = store("objects", "kind = 'sketch'", insertField(objectPayload("kind = 'sketch'"), "constraints", encodeMajor(4, 0)));
  assert.equal(mustPart(emptyConstraints).distanceMm, 10);

  const withoutTarget = store("objects", "kind = 'feature.extrude'", omitField(objectPayload("kind = 'feature.extrude'"), ["target_body"]));
  assert.equal(mustPart(withoutTarget).distanceMm, 10);
  assert.equal(mustPart(saveHeight(withoutTarget, "15", openSync)).distanceMm, 15);
  const withoutFallback = store("topology_refs", "rowid = 1", omitField(topoPayload("rowid = 1"), ["fallback_signature"]));
  assert.equal(mustPart(withoutFallback).distanceMm, 10);
  assert.equal(mustPart(saveHeight(withoutFallback, "15", openSync)).distanceMm, 15);
  refuse(store("topology_refs", "rowid = 1", omitField(topoPayload("rowid = 1"), ["output_role", "side"])), /missing output_role.side/);
  refuse(
    store("objects", "kind = 'sketch'", insertField(objectPayload("kind = 'sketch'"), "constraints", horizontalConstraints())),
    /schema v2/,
  );
  refuse(
    store("topology_refs", "rowid = 1", rewritePayload(topoPayload("rowid = 1"), ["output_role", "role"], encodeText("nope"))),
    /expected enum/,
  );
  refuse(
    store("topology_refs", "rowid = 1", rewritePayload(topoPayload("rowid = 1"), ["selection", "rule"], encodeText("many"))),
    /expected enum/,
  );
  refuse(
    store(
      "topology_refs",
      "rowid = 1",
      rewritePayload(topoPayload("rowid = 1"), ["output_role"], encodeMap([
        ["role", encodeText("fillet_face")],
        ["source_edge", Uint8Array.of(0xf6)],
      ])),
    ),
    /BLOB|source_edge/,
  );

  keepOut(
    store("objects", "kind = 'feature.extrude'", rewritePayload(objectPayload("kind = 'feature.extrude'"), ["end_condition", "kind"], encodeText("symmetric"))),
    /symmetric|Blind|торец/,
  );
  keepOut(
    store("objects", "kind = 'sketch'", rewritePayload(objectPayload("kind = 'sketch'"), ["curves", 0, "geometry"], encodeMap([
      ["kind", encodeText("point")],
      ["at", encodeMap([["x", encodeFloat(0)], ["y", encodeFloat(0)]])],
    ]))),
    /line segment/,
  );
  keepOut(
    store(
      "topology_refs",
      "rowid = 1",
      rewritePayload(topoPayload("rowid = 1"), ["output_role"], encodeMap([
        ["role", encodeText("fillet_face")],
        ["source_edge", encodeBytes(curveBytes())],
      ])),
    ),
    /without decoding|constraint/,
  );
  keepOut(
    store(
      "topology_refs",
      "rowid = 1",
      rewritePayload(topoPayload("rowid = 1"), ["fallback_signature"], encodeMap([
        ["kind", encodeText("face")],
        ["measure", encodeFloat(60)],
        ["centroid", encodeMap([["x", encodeFloat(0)], ["y", encodeFloat(0)], ["z", encodeFloat(0)]])],
      ])),
    ),
    /without decoding/,
  );
});

function curveBytes() {
  const db = openSync(fixture("fixtures/original-plate.fcad").slice());
  const row = db.get("SELECT payload FROM objects WHERE kind = 'sketch'");
  db.close();
  const raw = field(decodeCbor(row![0] as Uint8Array), "payload");
  if (raw.type !== "bytes") throw new Error("payload");
  const inner = cborToValue(decodeCbor(raw.value)) as { curves: { id: Uint8Array }[] };
  return inner.curves[0]!.id;
}

function horizontalConstraints() {
  const id = curveBytes();
  const point = (at: string) => encodeMap([["curve", encodeBytes(id)], ["at", encodeText(at)]]);
  return encodeArray([
    encodeMap([
      ["id", encodeBytes(id)],
      ["rule", encodeMap([["kind", encodeText("horizontal")], ["a", point("start")], ["b", point("end")]])],
    ]),
  ]);
}

function encodeMap(entries: [string, Uint8Array][]) {
  return concatBytes(encodeMajor(5, entries.length), ...entries.flatMap(([key, value]) => [encodeText(key), value]));
}

function encodeArray(items: Uint8Array[]) {
  return concatBytes(encodeMajor(4, items.length), ...items);
}

function concatBytes(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function omitField(payload: Uint8Array, path: (string | number)[]) {
  const envelope = decodeCbor(payload);
  const raw = field(envelope, "payload");
  if (raw.type !== "bytes") throw new Error("payload");
  let node = decodeCbor(raw.value);
  for (const key of path.slice(0, -1)) node = stepNode(node, key);
  if (node.type !== "map") throw new Error("map");
  const name = String(path[path.length - 1]);
  const entry = node.entries.find((item) => item.key.type === "text" && item.key.value === name);
  if (!entry || node.entries.length >= 24) throw new Error(`нельзя убрать ${name}`);
  const stripped = spliceBytes(raw.value, [{ start: entry.key.start, end: entry.value.end, next: new Uint8Array() }]);
  stripped[node.start] = (5 << 5) | (node.entries.length - 1);
  return spliceBytes(payload, [{ start: raw.start, end: raw.end, next: encodeBytes(stripped) }]);
}

function insertField(payload: Uint8Array, key: string, value: Uint8Array) {
  const envelope = decodeCbor(payload);
  const raw = field(envelope, "payload");
  if (raw.type !== "bytes") throw new Error("payload");
  const node = decodeCbor(raw.value);
  if (node.type !== "map" || node.entries.length >= 23) throw new Error("map");
  const added = spliceBytes(raw.value, [{ start: node.end, end: node.end, next: concatBytes(encodeText(key), value) }]);
  added[node.start] = (5 << 5) | (node.entries.length + 1);
  return spliceBytes(payload, [{ start: raw.start, end: raw.end, next: encodeBytes(added) }]);
}

function stepNode(node: CborNode, key: string | number) {
  if (typeof key === "number") {
    if (node.type !== "array") throw new Error("array");
    return node.items[key]!;
  }
  return field(node, key);
}

test("cbor duplicates, strict text, absent options and numeric widths", async () => {
  await ready();
  const plate = fixture("fixtures/original-plate.fcad");
  const refuse = (bytes: Uint8Array, pattern: RegExp) => {
    const read = readFcad(openSync(bytes));
    assert.equal(read.ok, false, read.ok ? "editable" : read.error);
    if (!read.ok) assert.match(read.error, pattern, read.error);
    assert.throws(() => saveHeight(bytes, "15", openSync));
  };
  const negatives: [string, RegExp][] = [
    ["duplicate-target-body", /duplicate field `target_body`/],
    ["duplicate-topology-side", /duplicate field `side`/],
    ["invalid-utf8-unknown-field", /UTF-8/],
  ];
  for (const [name, pattern] of negatives) {
    refuse(fixture(`test-data/cbor-codec/${name}.fcad`), pattern);
    refuse(fixture(`test-data/cbor-codec/${name}-saved.fcad`), pattern);
  }
  for (const name of ["missing-target-body", "missing-fallback-signature", "integer-distance"]) {
    const bytes = fixture(`test-data/cbor-codec/${name}.fcad`);
    assert.equal(mustPart(bytes).distanceMm, 10, name);
    const raised = saveHeight(bytes, "15", openSync);
    assert.equal(mustPart(raised).distanceMm, 15, name);
    const fine = saveHeight(raised, "10.1", openSync);
    const again = mustPart(fine);
    assert.equal(again.distanceMm, 10.1, name);
    assert.equal(again.distanceSource, "10.1", name);
  }

  function payloadOf(table: "objects" | "topology_refs", where: string) {
    const db = openSync(plate.slice());
    const row = db.get(`SELECT payload FROM ${table} WHERE ${where}`);
    db.close();
    if (!row) throw new Error(where);
    return row[0] as Uint8Array;
  }
  function store(table: "objects" | "topology_refs", where: string, payload: Uint8Array) {
    const db = openSync(plate.slice());
    const row = db.get(`SELECT id FROM ${table} WHERE ${where}`);
    if (!row) throw new Error(where);
    db.run(`UPDATE ${table} SET payload = ?, payload_hash = ? WHERE id = ?`, [payload, blake3(payload), row[0] as Uint8Array]);
    const bytes = db.export();
    db.close();
    return bytes;
  }
  const extrude = () => payloadOf("objects", "kind = 'feature.extrude'");
  const topology = () => payloadOf("topology_refs", "rowid = 1");
  refuse(store("objects", "kind = 'feature.extrude'", appendInner(extrude(), [], "target_body", Uint8Array.of(0xf6))), /duplicate field `target_body`/);
  refuse(store("objects", "kind = 'feature.extrude'", appendInner(extrude(), ["end_condition", "distance"], "source", encodeText("10"))), /duplicate field `source`/);
  refuse(store("objects", "kind = 'feature.extrude'", appendRoot(extrude(), "type", encodeText("feature.extrude"))), /duplicate field `type`/);
  refuse(store("topology_refs", "rowid = 1", appendInner(topology(), ["output_role"], "side", encodeText("start"))), /duplicate field `side`/);
  refuse(store("topology_refs", "rowid = 1", appendInner(topology(), ["selection"], "rule", encodeText("exact"))), /duplicate field `rule`/);
  refuse(
    store("objects", "kind = 'feature.extrude'", rewritePayload(extrude(), ["target_body"], Uint8Array.of(0xf4))),
    /BLOB|target_body/,
  );

  const noted = store("objects", "kind = 'feature.extrude'", appendInner(extrude(), [], "note", encodeText("высота π")));
  assert.equal(mustPart(noted).distanceMm, 10);
  const notedSaved = saveHeight(noted, "15", openSync);
  assert.equal(mustPart(notedSaved).distanceMm, 15);
  assert.equal(extrudeField(notedSaved, "note"), "высота π");

  const float64 = (value: number) => {
    const out = new Uint8Array(9);
    out[0] = 0xfb;
    new DataView(out.buffer).setFloat64(1, value, false);
    return out;
  };
  const float32 = (value: number) => {
    const out = new Uint8Array(5);
    out[0] = 0xfa;
    new DataView(out.buffer).setFloat32(1, value, false);
    return out;
  };
  for (const token of [Uint8Array.of(10), encodeFloat(10), float32(10), float64(10)]) {
    const bytes = store("objects", "kind = 'feature.extrude'", rewritePayload(extrude(), ["end_condition", "distance", "value"], token));
    assert.equal(mustPart(bytes).distanceMm, 10);
    const saved = saveHeight(bytes, "10.1", openSync);
    const model = mustPart(saved);
    assert.equal(model.distanceMm, 10.1);
    assert.equal(model.distanceSource, "10.1");
    const value = distanceValue(saved);
    assert.equal(value.type, "float");
    assert.equal(value.value, 10.1);
  }
  const wideBytes = store(
    "objects",
    "kind = 'feature.extrude'",
    rewritePayload(rewritePayload(extrude(), ["end_condition", "distance", "value"], float64(10.1)), ["end_condition", "distance", "source"], encodeText("10.1")),
  );
  assert.equal(mustPart(wideBytes).distanceMm, 10.1);
  assert.equal(mustPart(saveHeight(wideBytes, "15", openSync)).distanceMm, 15);
});

test("U+FEFF stays in CBOR text and does not collapse distinct keys", async () => {
  await ready();
  const textOf = (node: CborNode) => {
    if (node.type !== "text" || typeof node.value !== "string") throw new Error(node.type);
    return node.value;
  };
  assert.equal(textOf(decodeCbor(encodeText("\uFEFFnote"))), "\uFEFFnote");
  assert.equal(textOf(decodeCbor(encodeText("pre\uFEFFpost"))), "pre\uFEFFpost");

  const plate = fixture("fixtures/original-plate.fcad");
  const refuse = (bytes: Uint8Array, pattern: RegExp) => {
    const read = readFcad(openSync(bytes));
    assert.equal(read.ok, false, read.ok ? "editable" : read.error);
    if (!read.ok) assert.match(read.error, pattern, read.error);
    assert.throws(() => saveHeight(bytes, "10.1", openSync));
  };
  refuse(fixture("test-data/cbor-unicode/bom-operation.fcad"), /expected enum|unknown variant/);
  refuse(fixture("test-data/cbor-unicode/bom-operation-saved.fcad"), /expected enum|unknown variant/);

  const unknown = fixture("test-data/cbor-unicode/bom-unknown-key.fcad");
  assert.equal(mustPart(unknown).distanceMm, 10);
  assert.equal(extrudeField(unknown, "reversed"), false);
  assert.equal(extrudeField(unknown, "\uFEFFreversed"), true);
  const saved = saveHeight(unknown, "10.1", openSync);
  const model = mustPart(saved);
  assert.equal(model.distanceMm, 10.1);
  assert.equal(model.distanceSource, "10.1");
  assert.equal(extrudeField(saved, "reversed"), false);
  assert.equal(extrudeField(saved, "\uFEFFreversed"), true);

  function payloadOf() {
    const db = openSync(plate.slice());
    const row = db.get("SELECT payload FROM objects WHERE kind = 'feature.extrude'");
    db.close();
    return row![0] as Uint8Array;
  }
  function store(payload: Uint8Array) {
    const db = openSync(plate.slice());
    const row = db.get("SELECT id FROM objects WHERE kind = 'feature.extrude'");
    db.run("UPDATE objects SET payload = ?, payload_hash = ? WHERE id = ?", [payload, blake3(payload), row![0] as Uint8Array]);
    const bytes = db.export();
    db.close();
    return bytes;
  }
  const marked = store(appendInner(payloadOf(), [], "\uFEFFnote", encodeText("\uFEFFвысота")));
  assert.equal(mustPart(marked).distanceMm, 10);
  const markedSaved = saveHeight(marked, "15", openSync);
  assert.equal(extrudeField(markedSaved, "\uFEFFnote"), "\uFEFFвысота");
  const repeated = store(appendInner(appendInner(payloadOf(), [], "\uFEFFreversed", Uint8Array.of(0xf4)), [], "\uFEFFreversed", Uint8Array.of(0xf5)));
  refuse(repeated, /duplicate field `\uFEFFreversed`/);
});

function extrudeField(bytes: Uint8Array, key: string) {
  const db = openSync(bytes);
  const row = db.get("SELECT payload FROM objects WHERE kind = 'feature.extrude'");
  db.close();
  const raw = field(decodeCbor(row![0] as Uint8Array), "payload");
  if (raw.type !== "bytes") throw new Error("payload");
  const inner = cborToValue(decodeCbor(raw.value)) as Record<string, unknown>;
  return inner[key];
}

function distanceValue(bytes: Uint8Array) {
  const db = openSync(bytes);
  const row = db.get("SELECT payload FROM objects WHERE kind = 'feature.extrude'");
  db.close();
  const raw = field(decodeCbor(row![0] as Uint8Array), "payload");
  if (raw.type !== "bytes") throw new Error("payload");
  const distance = field(field(decodeCbor(raw.value), "end_condition"), "distance");
  const value = field(distance, "value");
  if (value.type !== "float" && value.type !== "uint") throw new Error(value.type);
  return value;
}

function appendInner(payload: Uint8Array, path: (string | number)[], key: string, value: Uint8Array) {
  const envelope = decodeCbor(payload);
  const raw = field(envelope, "payload");
  if (raw.type !== "bytes") throw new Error("payload");
  let node: CborNode = decodeCbor(raw.value);
  for (const step of path) node = stepNode(node, step);
  if (node.type !== "map" || node.entries.length >= 23) throw new Error(`map ${path.join(".")}`);
  const added = spliceBytes(raw.value, [{ start: node.end, end: node.end, next: concatBytes(encodeText(key), value) }]);
  added[node.start] = (5 << 5) | (node.entries.length + 1);
  return spliceBytes(payload, [{ start: raw.start, end: raw.end, next: encodeBytes(added) }]);
}

function appendRoot(payload: Uint8Array, key: string, value: Uint8Array) {
  const node = decodeCbor(payload);
  if (node.type !== "map" || node.entries.length >= 23) throw new Error("envelope");
  const added = spliceBytes(payload, [{ start: node.end, end: node.end, next: concatBytes(encodeText(key), value) }]);
  added[node.start] = (5 << 5) | (node.entries.length + 1);
  return added;
}
