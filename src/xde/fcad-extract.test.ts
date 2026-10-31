import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readEmbeddedStep, readFcad } from "../occt/fcad-doc.ts";
import { wrapSql, type SqlDb } from "../occt/sql.ts";

const require = createRequire(import.meta.url);
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

const probes = [
  "source-hash-mismatch",
  "source-length-mismatch",
  "object-payload-hash-mismatch",
  "source-ref-mismatch",
  "wrong-application-id",
];

const opaqueProbes = ["unknown-object-schema", "unknown-import-capability", "unknown-capability-bad-source"];

test("a valid imported assembly yields its embedded STEP and stays uneditable", async () => {
  const db = await open(readFileSync(new URL("../../fixtures/original-assembly.fcad", import.meta.url)));
  try {
    const opened = readFcad(db);
    assert.equal(opened.ok, true);
    if (opened.ok) assert.equal(opened.editable, false);
    const extracted = readEmbeddedStep(db);
    const step = readFileSync(new URL("../../fixtures/step/canonical/02-flat-assembly.step", import.meta.url));
    assert.equal(extracted.step.byteLength, 23528);
    assert.equal(Buffer.compare(extracted.step, step), 0);
    assert.equal(extracted.meta.hashOk, true);
    assert.equal(extracted.meta.sourceLinkOk, true);
    assert.equal(extracted.meta.sourceName, "02-flat-assembly.step");
    assert.equal(extracted.meta.format, "exchange.step");
    assert.equal(extracted.meta.hasStoredScene, true);
  } finally {
    db.close();
  }
});

test("an editable plate has no embedded STEP", async () => {
  const db = await open(readFileSync(new URL("../../fixtures/original-plate.fcad", import.meta.url)));
  try {
    assert.throws(() => readEmbeddedStep(db), /no embedded STEP/);
  } finally {
    db.close();
  }
});

test("an unknown schema is not treated as a known STEP source", async () => {
  const db = await open(readFileSync(new URL("../../fixtures/original-assembly.fcad", import.meta.url)));
  db.exec("PRAGMA user_version = 99");
  const bytes = db.export();
  db.close();
  const again = await open(bytes);
  try {
    const opened = readFcad(again);
    assert.equal(opened.ok, true);
    if (opened.ok) assert.equal(opened.status, "unsupported");
    assert.throws(() => readEmbeddedStep(again), /unknown/);
  } finally {
    again.close();
  }
});

for (const name of probes) {
  test(`${name} is rejected before any STEP bytes are returned`, async () => {
    const db = await open(readFileSync(new URL(`../../test-data/import-integrity/${name}.fcad`, import.meta.url)));
    try {
      const opened = readFcad(db);
      assert.equal(opened.ok, false, name);
      assert.throws(() => readEmbeddedStep(db), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(message.length > 0, true);
        assert.equal(/BLAKE3 matches|25963/.test(message), false, message);
        return true;
      });
    } finally {
      db.close();
    }
  });
}

for (const name of opaqueProbes) {
  test(`${name} stays unsupported and does not yield STEP bytes`, async () => {
    const db = await open(readFileSync(new URL(`../../test-data/import-capabilities/${name}.fcad`, import.meta.url)));
    try {
      const opened = readFcad(db);
      assert.equal(opened.ok, true, name);
      if (opened.ok) {
        assert.equal(opened.status, "unsupported");
        assert.equal(opened.editable, false);
      }
      assert.throws(() => readEmbeddedStep(db), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(/sourceLinkOk|23528|25963|payload source does not match/.test(message), false, message);
        return true;
      });
    } finally {
      db.close();
    }
  });
}

test("a known import contract with a bad source link is invalid", async () => {
  const db = await open(readFileSync(new URL("../../test-data/import-capabilities/known-schema-bad-source.fcad", import.meta.url)));
  try {
    const opened = readFcad(db);
    assert.equal(opened.ok, false);
    if (!opened.ok) {
      assert.equal(opened.status, "invalid");
      assert.match(opened.error, /payload source does not match/);
    }
    assert.throws(() => readEmbeddedStep(db), /payload source does not match/);
  } finally {
    db.close();
  }
});
