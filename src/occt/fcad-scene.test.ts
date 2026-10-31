import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readEmbeddedStep, readFcad } from "./fcad-doc.ts";
import { writeImportedDocument } from "./fcad-import.ts";
import { bindImportedScene } from "./fcad-scene.ts";
import { FCAD_APPLICATION_ID } from "./fcad.ts";
import { wrapSql, type SqlDb } from "./sql.ts";
import { uuidV7 } from "./uuid.ts";
import type { PortableScene } from "../xde/types.ts";

const require = createRequire(import.meta.url);
const wasm = readFileSync(new URL("../../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url));
const initSqlJs = require("sql.js") as (opts: { wasmBinary: Uint8Array }) => Promise<{
  Database: new (data?: Uint8Array) => Parameters<typeof wrapSql>[0];
}>;
const projectRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const goldenDir = process.env.FERRITE_GOLDENS ?? join(projectRoot, "test-data/writer-goldens");

function emptyScene(): PortableScene {
  return {
    sourceUnit: "millimetre",
    schema: "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF {1 0 10303 442 1 1 4 }",
    definitions: [
      { key: "step.product_definition#5", name: "Plate", solids: 1 },
      { key: "step.product_definition#31", name: "Other", solids: 1 },
    ],
    instances: [
      {
        occurrence: uuidV7(),
        definition: "step.product_definition#5",
        parent: null,
        name: "Plate",
        placement: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        colourSource: "none",
        colour: [0, 0, 0],
      },
      {
        occurrence: uuidV7(),
        definition: "step.product_definition#31",
        parent: 0,
        name: "Other",
        placement: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        colourSource: "definition",
        colour: [0.1, 0.2, 0.3],
      },
    ],
    diagnostics: [],
  };
}

function uuidV4() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

async function write(scene: PortableScene, trustScene = false) {
  const SQL = await initSqlJs({ wasmBinary: wasm });
  const db = wrapSql(new SQL.Database());
  const step = new TextEncoder().encode("ISO-10303-21; END-ISO-10303-21;");
  let bytes: Uint8Array;
  try {
    bytes = writeImportedDocument(db, { step, sourceName: "probe.step", objectName: "probe", scene, trustScene });
  } finally {
    db.close();
  }
  const opened = wrapSql(new SQL.Database(bytes));
  opened.exec("PRAGMA foreign_keys = ON");
  return opened;
}

function reject(db: SqlDb, pattern: RegExp) {
  const result = readFcad(db);
  assert.equal(result.ok, false, "invalid scene was confirmed");
  if (!result.ok) assert.match(result.error, pattern);
  assert.throws(() => readEmbeddedStep(db), pattern);
}

test("sqlite_master matches the native schema text", async () => {
  const db = await write(emptyScene());
  try {
    const userVersion = db.get("PRAGMA user_version");
    const application = db.get("PRAGMA application_id");
    assert.equal(Number(userVersion?.[0]), 0);
    assert.equal(Number(application?.[0]), FCAD_APPLICATION_ID);
    const { CURRENT_SCHEMA } = await import("./fcad-import.ts");
    const rows = db.all("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL");
    const expected = CURRENT_SCHEMA.split(";").map((statement) => statement.trim()).filter(Boolean).sort();
    const got = rows.map((row) => String(row[1]).trim()).sort();
    assert.equal(got.length, expected.length);
    expected.forEach((statement, index) => assert.equal(got[index], statement));
    const counts = db.get("SELECT (SELECT COUNT(*) FROM deps), (SELECT COUNT(*) FROM checkpoints)");
    assert.deepEqual(counts, [0, 0]);
  } finally {
    db.close();
  }
});

test("a structurally valid scene is not editable and keeps its bytes", async () => {
  const scene = emptyScene();
  const db = await write(scene);
  try {
    const opened = readFcad(db);
    assert.equal(opened.ok, true);
    if (opened.ok) assert.equal(opened.editable, false);
    const extracted = readEmbeddedStep(db);
    assert.equal(extracted.meta.sourceLinkOk, true);
    assert.ok(extracted.scene);
    const bound = bindImportedScene(extracted.scene, scene);
    assert.equal(bound.confirmed, true, bound.error ?? "");
  } finally {
    db.close();
  }
});

test("recalculated hashes do not hide a bad scene", async () => {
  const missing = emptyScene();
  missing.instances[0]!.definition = "step.product_definition#999";
  const forward = emptyScene();
  forward.instances[0]!.parent = 1;
  const cyclic = emptyScene();
  cyclic.instances[1]!.parent = 1;
  const repeated = emptyScene();
  repeated.instances[1]!.occurrence = repeated.instances[0]!.occurrence;
  const version4 = emptyScene();
  version4.instances[0]!.occurrence = uuidV4();
  const cases: Array<[string, PortableScene, RegExp]> = [
    ["missing key", missing, /missing definition/],
    ["forward parent", forward, /parent is not an earlier instance/],
    ["cyclic parent", cyclic, /parent is not an earlier instance/],
    ["repeated occurrence", repeated, /repeats occurrence/],
    ["version 4 occurrence", version4, /not an RFC 4122 UUIDv7/],
  ];
  for (const [name, scene, pattern] of cases) {
    const db = await write(scene, true);
    try {
      reject(db, pattern);
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : error}`);
    } finally {
      db.close();
    }
  }
});

test("a wrong local placement is not a confirmed scene", async () => {
  const scene = emptyScene();
  const tampered: PortableScene = {
    ...scene,
    instances: scene.instances.map((instance, index) => (index === 0 ? { ...instance, placement: instance.placement.map((value, at) => (at === 3 ? value + 5 : value)) } : instance)),
  };
  const db = await write(tampered, true);
  try {
    const opened = readFcad(db);
    assert.equal(opened.ok, true, "the container and hashes are intact");
    const extracted = readEmbeddedStep(db);
    assert.equal(extracted.meta.hashOk, true);
    assert.equal(extracted.meta.sourceLinkOk, true);
    const bound = bindImportedScene(extracted.scene, scene);
    assert.equal(bound.confirmed, false);
    assert.match(bound.error ?? "", /placement of instance 0/);
  } finally {
    db.close();
  }
});
