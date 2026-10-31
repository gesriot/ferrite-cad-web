import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { readFcad, saveHeight } from "../src/occt/fcad-doc.ts";
import { wrapSql, type SqlDb } from "../src/occt/sql.ts";

const require = createRequire(import.meta.url);
const [savedPath, originalPath, source] = process.argv.slice(2);
if (!savedPath || !originalPath || !source) {
  console.error("usage: fcad-download-check.ts <saved.fcad> <original.fcad> <height source>");
  process.exit(2);
}

type InitSql = (opts: { wasmBinary: Uint8Array }) => Promise<{
  Database: new (data?: Uint8Array) => Parameters<typeof wrapSql>[0];
}>;
const initSqlJs = require("sql.js") as InitSql;
const wasm = readFileSync(new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url));
const SQL = await initSqlJs({ wasmBinary: wasm });

function open(bytes: Uint8Array): SqlDb {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const db = wrapSql(new SQL.Database(copy));
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

if (source === "--damage") {
  const db = open(new Uint8Array(readFileSync(originalPath)));
  const row = db.get("SELECT id, payload FROM objects WHERE kind = 'feature.extrude'");
  const payload = (row?.[1] as Uint8Array).slice();
  payload[payload.length - 1] ^= 0xff;
  db.run("UPDATE objects SET payload = ? WHERE id = ?", [payload, row?.[0]]);
  writeFileSync(savedPath, db.export());
  db.close();
  console.log(JSON.stringify({ ok: true, damaged: savedPath }));
  process.exit(0);
}

function modelOf(bytes: Uint8Array) {
  const db = open(bytes);
  try {
    const doc = readFcad(db);
    assert.equal(doc.ok, true);
    if (!doc.ok || !doc.editable) throw new Error(!doc.ok ? doc.error : doc.reason);
    return doc.model;
  } finally {
    db.close();
  }
}

const saved = new Uint8Array(readFileSync(savedPath));
const original = new Uint8Array(readFileSync(originalPath));
const savedModel = modelOf(saved);
const originalModel = modelOf(original);
assert.equal(savedModel.distanceSource, source);
assert.equal(savedModel.extrudeId, originalModel.extrudeId);
assert.equal(savedModel.sketchId, originalModel.sketchId);
assert.equal(savedModel.bodyId, originalModel.bodyId);
assert.equal(savedModel.planeId, originalModel.planeId);
assert.deepEqual(savedModel.curves, originalModel.curves);
const roundtrip = saveHeight(saved, source, open);
assert.equal(modelOf(roundtrip).distanceSource, source);
console.log(JSON.stringify({ ok: true, distance: savedModel.distanceSource, extrudeId: savedModel.extrudeId }));
