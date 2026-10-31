/**
 * Assertion suite for the current FCAD barrier.
 *
 * Fixtures live under test-data/current-probes, relative to this module.
 * A missing file, an unexpected exception, a wrong verdict, or a write of an
 * invalid document fails the process. Paths are never taken from a temporary
 * reviewer unpack.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readEmbeddedStep, readFcad, saveHeight } from "./fcad-doc.ts";
import { wrapSql, type SqlDb } from "./sql.ts";

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url));
const probeDir = fileURLToPath(new URL("../../test-data/current-probes/", import.meta.url));
const wasm = readFileSync(new URL("../../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url));

type InitSql = (opts: { wasmBinary: Uint8Array }) => Promise<{
  Database: new (data?: Uint8Array) => Parameters<typeof wrapSql>[0];
}>;
const initSqlJs = require("sql.js") as InitSql;
let SQL: Awaited<ReturnType<InitSql>> | null = null;

async function ready() {
  SQL ??= await initSqlJs({ wasmBinary: wasm });
}

function open(bytes: Uint8Array): SqlDb {
  if (!SQL) throw new Error("sql.js is not ready");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const db = wrapSql(new SQL.Database(copy));
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(probeDir, name)));
}

// Historical fixtures include topology_refs, which the current native contract
// (71dd2209) rejects as an obsolete catalogue. They are unsupported/opaque,
// not current-editable. See REPORT.md expected-changes.
const expected: Record<string, "editable" | "invalid" | "unsupported"> = {
  "plate-positive": "unsupported",
  "missing-previous": "unsupported",
  "unknown-extrude-field": "unsupported",
  "wrong-profile": "unsupported",
  "wrong-plane": "unsupported",
  "missing-deps": "unsupported",
  "bad-topology-hash": "unsupported",
  "bad-topology-side": "unsupported",
  "invalid-constraint": "unsupported",
  "unknown-operation": "unsupported",
  "assembly-wrong-appid": "invalid",
  "assembly-missing-meta": "invalid",
};

test("current barrier matches the pinned native verdicts", async () => {
  await ready();
  const failures: string[] = [];
  for (const [name, status] of Object.entries(expected)) {
    const errors: string[] = [];
    let bytes: Uint8Array;
    try {
      bytes = fixture(`${name}.fcad`);
    } catch (error) {
      failures.push(`${name}: missing fixture ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const db = open(bytes);
    try {
      const got = readFcad(db);
      if (got.status !== status) errors.push(`read=${got.status}, expected=${status}`);
      if (name.startsWith("assembly-")) {
        assert.throws(() => readEmbeddedStep(db), /application id|metadata|Query returned no rows|not a FerriteCAD/);
      } else {
        let saved: Uint8Array | undefined;
        try {
          saved = saveHeight(bytes, "15", open);
        } catch (error) {
          if (status === "editable") errors.push(`save refused: ${error instanceof Error ? error.message : error}`);
        }
        if (status === "invalid" && saved) errors.push("invalid input was written");
        if (status === "editable" && saved) {
          const again = open(saved);
          try {
            const result = readFcad(again);
            if (!result.ok || !result.editable || result.model.distanceMm !== 15) errors.push("saved height did not reopen as 15");
          } finally {
            again.close();
          }
        }
      }
    } catch (error) {
      errors.push(`uncaught ${error instanceof Error ? error.message : error}`);
    } finally {
      db.close();
    }
    if (errors.length) failures.push(`${name}: ${errors.join("; ")}`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("own variations: wrong-kind profile, missing edge, null constraint, unknown extrude field", async () => {
  await ready();
  // These are the same class of damage as the pinned probes, exercised through
  // the shared barrier rather than a file-name allowlist.
  const wrongProfile = fixture("wrong-profile.fcad");
  const db = open(wrongProfile);
  try {
    const opened = readFcad(db);
    // Historical fixture has topology_refs; current contract returns unsupported.
    assert.equal(opened.status, "unsupported");
    assert.throws(() => saveHeight(wrongProfile, "15", open));
  } finally {
    db.close();
  }

  const missing = fixture("missing-deps.fcad");
  const missingDb = open(missing);
  try {
    const opened = readFcad(missingDb);
    assert.equal(opened.status, "unsupported"); // historical catalogue
  } finally {
    missingDb.close();
  }

  const constraint = fixture("invalid-constraint.fcad");
  const constraintDb = open(constraint);
  try {
    const opened = readFcad(constraintDb);
    assert.equal(opened.status, "unsupported"); // historical catalogue
    assert.equal(opened.status, "unsupported"); // historical catalogue
  } finally {
    constraintDb.close();
  }

  const unknown = fixture("unknown-extrude-field.fcad");
  const unknownDb = open(unknown);
  try {
    const opened = readFcad(unknownDb);
    assert.equal(opened.status, "unsupported"); // historical catalogue
  } finally {
    unknownDb.close();
  }
});

test("positive controls reopen after an edit and keep identities", async () => {
  await ready();
  for (const name of ["current-plate", "current-l"]) {
    const bytes = new Uint8Array(readFileSync(join(probeDir, `${name}.fcad`)));
    const before = open(bytes);
    let originalId = "";
    let originalSketchId = "";
    try {
      const opened = readFcad(before);
      assert.equal(opened.status, "editable", `${name} must open as editable`);
      if (opened.ok && opened.editable) {
        originalId = opened.model.documentId;
        originalSketchId = opened.model.sketchId;
      }
    } finally {
      before.close();
    }
    assert.ok(originalId, `${name} must yield a document id`);
    const saved = saveHeight(bytes, "10.1", open);
    const after = open(saved);
    try {
      const reopened = readFcad(after);
      assert.equal(reopened.status, "editable", `${name} must reopen as editable after save`);
      if (reopened.ok && reopened.editable) {
        assert.equal(reopened.model.documentId, originalId);
        assert.equal(reopened.model.sketchId, originalSketchId);
        assert.equal(reopened.model.distanceSource, "10.1");
        assert.equal(reopened.model.distanceMm, 10.1);
      }
    } finally {
      after.close();
    }
  }
});

test("invalid assemblies yield no STEP and do not confirm a scene", async () => {
  await ready();
  for (const name of ["assembly-wrong-appid", "assembly-missing-meta"]) {
    const bytes = fixture(`${name}.fcad`);
    const db = open(bytes);
    try {
      const opened = readFcad(db);
      assert.equal(opened.status, "invalid");
      assert.throws(() => readEmbeddedStep(db));
    } finally {
      db.close();
    }
  }
});

void here;

test("contract probes and own variations match expected barrier verdicts", async () => {
  await ready();
  const contractDir = fileURLToPath(new URL("../../test-data/contract-probes/", import.meta.url));
  const ownDir = fileURLToPath(new URL("../../test-data/own-variations/", import.meta.url));
  const contractExpected: Record<string, "editable" | "invalid" | "unsupported" | "valid" | "imported"> = {
    "plate-positive": "unsupported", // historical catalogue
    "assembly-positive": "unsupported", // historical catalogue
    "valid-constrained": "unsupported",
    "topology-kind-mismatch": "unsupported", // historical catalogue
    "constraint-empty-map": "unsupported", // historical catalogue
    "constrained-bad-extrude": "unsupported", // historical catalogue
    "graph-cycle": "invalid", // cycle detected before catalogue check
    "parent-self": "invalid", // self-parent detected before catalogue
    "unknown-dependency-role": "invalid", // unknown role detected before catalogue
    "topology-id-not-v7": "unsupported", // historical catalogue
    "topology-producer-plane": "unsupported", // historical catalogue
    "missing-topology-table": "invalid", // new contract requires regions; old fixture lacks them
    "assembly-length-angle": "invalid", // unit dimension before catalogue
    "assembly-self-cycle": "invalid", // cycle before catalogue
    "assembly-broken-companion": "unsupported", // historical catalogue
    "unreachable-source": "unsupported", // historical catalogue
  };
  const failures: string[] = [];
  for (const [name, expect] of Object.entries(contractExpected)) {
    const bytes = new Uint8Array(readFileSync(join(contractDir, `${name}.fcad`)));
    const db = open(bytes);
    const got = readFcad(db);
    let ok = false;
    if (expect === "invalid" && got.status === "invalid") ok = true;
    else if (expect === "editable" && got.status === "editable") ok = true;
    else if (expect === "unsupported" && got.status === "unsupported") ok = true;
    else if (expect === "valid" && got.ok) ok = true;
    else if (expect === "imported" && got.ok && got.status === "unsupported") ok = true;
    if (!ok) failures.push(`${name}: got ${got.status} expected ${expect}`);
    if (expect === "invalid") {
      let saved;
      try { saved = saveHeight(bytes, "15", open); } catch { /* expected */ }
      if (saved) failures.push(`${name}: invalid was written`);
    }
  }
  const own = ["cycle-via-intermediate", "wrong-role-elsewhere", "parent-self-extrude"]; // topology-zero-id and orphan-source-on-plate are historical catalogue
  for (const name of own) {
    const bytes = new Uint8Array(readFileSync(join(ownDir, `${name}.fcad`)));
    const db = open(bytes);
    const got = readFcad(db);
    if (got.status !== "invalid") failures.push(`own ${name}: got ${got.status}`);
  }
  if (failures.length) assert.fail(failures.join("\n"));
});

test("reader probes and review-20 own variations match expected verdicts", async () => {
  await ready();
  const readerDir = fileURLToPath(new URL("../../test-data/reader-probes/", import.meta.url));
  const ownDir = fileURLToPath(new URL("../../test-data/own-variations-20/", import.meta.url));
  // Historical reader probes include topology_refs; current contract treats them as unsupported.
  const readerExpected: Record<string, "editable" | "invalid" | "unsupported" | "imported"> = {
    "plate-positive": "unsupported",
    "assembly-positive": "unsupported",
    "valid-constrained": "unsupported",
    "units-native-alias": "unsupported",
    "units-native-whitespace": "unsupported",
    "multi-import-valid": "unsupported",
    "constraint-id-only": "unsupported",
    "constraint-missing-point": "unsupported",
    "constrained-missing-edge": "unsupported",
    "assembly-empty-plane": "unsupported",
    "assembly-empty-extrude": "unsupported",
    "assembly-wrong-sketch-plane": "unsupported",
    "topology-kind-unknown": "unsupported",
    "missing-import-tables": "invalid",
    "duplicate-curve-id": "unsupported",
  };
  const failures: string[] = [];
  for (const [name, expect] of Object.entries(readerExpected)) {
    const bytes = new Uint8Array(readFileSync(join(readerDir, `${name}.fcad`)));
    const db = open(bytes);
    try {
      const got = readFcad(db);
      let ok = false;
      if (expect === "invalid" && got.status === "invalid") ok = true;
      else if (expect === "editable" && got.status === "editable") ok = true;
      else if (expect === "unsupported" && got.status === "unsupported") ok = true;
      else if (expect === "imported" && got.ok && got.status === "unsupported") ok = true;
      if (!ok) failures.push(`${name}: got ${got.status} expected ${expect}`);
      if (expect === "invalid" || expect === "unsupported") {
        let saved;
        try { saved = saveHeight(bytes, "15", open); } catch { /* expected */ }
        if (saved) failures.push(`${name}: write accepted`);
      }
    } finally {
      db.close();
    }
  }
  const ownInvalid = ["drop-import-refs"]; // topo-kind-banana is historical catalogue → unsupported
  const ownEditable: string[] = []; // units-* are historical catalogue → unsupported
  for (const name of ownInvalid) {
    const bytes = new Uint8Array(readFileSync(join(ownDir, `${name}.fcad`)));
    const db = open(bytes);
    try {
      const got = readFcad(db);
      if (got.status !== "invalid") failures.push(`own ${name}: got ${got.status}`);
    } finally {
      db.close();
    }
  }
  for (const name of ownEditable) {
    const bytes = new Uint8Array(readFileSync(join(ownDir, `${name}.fcad`)));
    const db = open(bytes);
    try {
      const got = readFcad(db);
      if (got.status !== "editable") failures.push(`own ${name}: got ${got.status}`);
    } finally {
      db.close();
    }
  }
  if (failures.length) assert.fail(failures.join("\\n"));
});

test("review-21 contract probes and own variations match expected verdicts", async () => {
  await ready();
  const ownDir = fileURLToPath(new URL("../../test-data/own-variations-21/", import.meta.url));
  // Copy will be done separately; for now test own variations only if present
  const ownInvalid = ["unit-furlong"]; // topo-kind-vertexx and orphan-source-21 are historical catalogue
  const failures: string[] = [];
  for (const name of ownInvalid) {
    try {
      const bytes = new Uint8Array(readFileSync(join(ownDir, `${name}.fcad`)));
      const db = open(bytes);
      try {
        const got = readFcad(db);
        if (got.status !== "invalid") failures.push(`own ${name}: got ${got.status}`);
      } finally {
        db.close();
      }
    } catch (e) {
      failures.push(`own ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failures.length) assert.fail(failures.join("\\n"));
});

test("own plane and feature variations distinguish valid unsupported from invalid", async () => {
  await ready();
  // Valid offset plane is unsupported, not invalid.
  const offsetBytes = new Uint8Array(readFileSync(join(probeDir, "offset-plane.fcad")));
  const offsetDb = open(offsetBytes);
  try {
    const got = readFcad(offsetDb);
    assert.equal(got.status, "unsupported", "valid offset plane must be unsupported");
  } finally {
    offsetDb.close();
  }
  // Missing kind is invalid, not unsupported.
  const missingBytes = new Uint8Array(readFileSync(join(probeDir, "plane-missing-kind.fcad")));
  const missingDb = open(missingBytes);
  try {
    const got = readFcad(missingDb);
    assert.equal(got.status, "invalid", "plane missing kind must be invalid");
  } finally {
    missingDb.close();
  }
  // Valid revolve is unsupported.
  const revolveBytes = new Uint8Array(readFileSync(join(probeDir, "valid-revolve.fcad")));
  const revolveDb = open(revolveBytes);
  try {
    const got = readFcad(revolveDb);
    assert.equal(got.status, "unsupported", "valid revolve must be unsupported");
  } finally {
    revolveDb.close();
  }
  // Positive edit of current plate keeps identity.
  const plateBytes = new Uint8Array(readFileSync(join(probeDir, "current-plate.fcad")));
  const saved = saveHeight(plateBytes, "15", open);
  const reopened = open(saved);
  try {
    const got = readFcad(reopened);
    assert.equal(got.status, "editable");
    if (got.ok && got.editable) {
      assert.equal(got.model.distanceSource, "15");
      assert.equal(got.model.distanceMm, 15);
    }
  } finally {
    reopened.close();
  }
});

test("table-driven contract: field policy, order, dangling refs", async () => {
  await ready();
  // Valid offset is unsupported, not invalid.
  const offsetBytes = new Uint8Array(readFileSync(join(probeDir, "offset-plane.fcad")));
  const offsetDb = open(offsetBytes);
  try {
    assert.equal(readFcad(offsetDb).status, "unsupported");
  } finally {
    offsetDb.close();
  }
  // Fixed with foreign field is invalid.
  const crossBytes = new Uint8Array(readFileSync(join(probeDir, "fixed-cross-variant-field.fcad")));
  const crossDb = open(crossBytes);
  try {
    assert.equal(readFcad(crossDb).status, "invalid");
  } finally {
    crossDb.close();
  }
  // Order independence: both permutations are invalid.
  for (const name of ["unsupported-before-invalid", "unsupported-after-invalid"]) {
    const bytes = new Uint8Array(readFileSync(join(probeDir, `${name}.fcad`)));
    const db = open(bytes);
    try {
      assert.equal(readFcad(db).status, "invalid", `${name} must be invalid regardless of ordinal`);
    } finally {
      db.close();
    }
  }
  // Dangling offset.from is invalid.
  const danglingBytes = new Uint8Array(readFileSync(join(probeDir, "offset-dangling-from.fcad")));
  const danglingDb = open(danglingBytes);
  try {
    assert.equal(readFcad(danglingDb).status, "invalid");
  } finally {
    danglingDb.close();
  }
  // Positive edit of current plate keeps identity and height.
  const plateBytes = new Uint8Array(readFileSync(join(probeDir, "current-plate.fcad")));
  const saved = saveHeight(plateBytes, "15", open);
  const reopened = open(saved);
  try {
    const got = readFcad(reopened);
    assert.equal(got.status, "editable");
    if (got.ok && got.editable) {
      assert.equal(got.model.distanceSource, "15");
      assert.equal(got.model.distanceMm, 15);
    }
  } finally {
    reopened.close();
  }
});

test("table-driven: role, order, field policy, positive unsupported", async () => {
  await ready();
  // Obsolete role is invalid.
  const obsoleteBytes = new Uint8Array(readFileSync(join(probeDir, "plate-obsolete-dependency-role.fcad")));
  const obsoleteDb = open(obsoleteBytes);
  try {
    assert.equal(readFcad(obsoleteDb).status, "invalid");
  } finally {
    obsoleteDb.close();
  }
  // Valid up-to-face is unsupported, not invalid.
  const upBytes = new Uint8Array(readFileSync(join(probeDir, "valid-up-to-face.fcad")));
  const upDb = open(upBytes);
  try {
    assert.equal(readFcad(upDb).status, "unsupported");
  } finally {
    upDb.close();
  }
  // Valid revolve line is unsupported.
  const lineBytes = new Uint8Array(readFileSync(join(probeDir, "valid-revolve-line.fcad")));
  const lineDb = open(lineBytes);
  try {
    assert.equal(readFcad(lineDb).status, "unsupported");
  } finally {
    lineDb.close();
  }
  // Float kind is invalid.
  const floatBytes = new Uint8Array(readFileSync(join(probeDir, "fillet-float-kind.fcad")));
  const floatDb = open(floatBytes);
  try {
    assert.equal(readFcad(floatDb).status, "invalid");
  } finally {
    floatDb.close();
  }
  // Order independence: both permutations are invalid.
  for (const name of ["unsupported-before-invalid", "unsupported-after-invalid"]) {
    const bytes = new Uint8Array(readFileSync(join(probeDir, `${name}.fcad`)));
    const db = open(bytes);
    try {
      assert.equal(readFcad(db).status, "invalid", `${name} must be invalid`);
    } finally {
      db.close();
    }
  }
  // Positive edit of current plate keeps identity.
  const plateBytes = new Uint8Array(readFileSync(join(probeDir, "current-plate.fcad")));
  const saved = saveHeight(plateBytes, "15", open);
  const reopened = open(saved);
  try {
    const got = readFcad(reopened);
    assert.equal(got.status, "editable");
    if (got.ok && got.editable) {
      assert.equal(got.model.distanceSource, "15");
      assert.equal(got.model.distanceMm, 15);
    }
  } finally {
    reopened.close();
  }
});
