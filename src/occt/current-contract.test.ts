import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { readFcad, readEmbeddedStep, saveHeight } from "./fcad-doc.ts";
import { wrapSql } from "./sql.ts";

const require = createRequire(import.meta.url);
type InitSql = (opts: { wasmBinary: Uint8Array }) => Promise<{ Database: new (data: Uint8Array) => Parameters<typeof wrapSql>[0] }>;
const SQL = await (require("sql.js") as InitSql)({ wasmBinary: readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm")) });
const open = (bytes: Uint8Array) => wrapSql(new SQL.Database(bytes));

for (const folder of ["current-contract", "semantic-regressions"]) {
  const base = new URL(`../../test-data/${folder}/`, import.meta.url);
  const cases = JSON.parse(readFileSync(new URL("expected.json", base), "utf8")) as Record<string, string>;
  for (const [name, expected] of Object.entries(cases)) {
    test(`${folder}: ${name} is ${expected}`, () => {
      const bytes = readFileSync(new URL(`${name}.fcad`, base)), db = open(bytes);
      try {
        const before = db.export(), doc = readFcad(db);
        if (expected === "imported") {
          assert.ok(doc.ok);
          assert.ok(readEmbeddedStep(db).step.length > 0);
        } else {
          assert.equal(doc.status, expected, "reason" in doc ? doc.reason : name);
          assert.throws(() => readEmbeddedStep(db));
        }
        assert.deepEqual(db.export(), before, "reading must not mutate the document");
        if (expected !== "editable") assert.throws(() => saveHeight(bytes, "10.1", open));
        else {
          assert.ok(doc.ok && doc.editable);
          const saved = open(saveHeight(bytes, "10.1", open));
          try {
            const again = readFcad(saved);
            assert.ok(again.ok && again.editable);
            assert.equal(again.model.distanceMm, 10.1);
            assert.equal(again.model.documentId, doc.model.documentId);
            assert.equal(again.model.sketchId, doc.model.sketchId);
            assert.equal(saved.get("SELECT name FROM sqlite_schema WHERE name='topology_refs'"), undefined);
          } finally { saved.close(); }
        }
      } finally { db.close(); }
    });
  }
}
