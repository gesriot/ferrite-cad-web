import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createDocumentAbi } from "../src/document/abi.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = join(root, "public/document-probe/kernel");
// The same ABI framing the browser Worker runs; only the source of the module differs.
const createDocumentModule = ({ wasmBinary }) =>
  createDocumentAbi(async () => {
    const { default: create } = await import(pathToFileURL(join(artifact, "document.mjs")).href);
    return create({ wasmBinary });
  });
const host =
  process.env.DOCUMENT_HOST ??
  resolve(
    process.env.CARGO_TARGET_DIR ?? join(root, "wasm/document/target"),
    "release/ferritecad-document-wasm-probe",
  );
const cli = process.env.FERRITECAD_CLI;
const scratch = mkdtempSync(join(tmpdir(), "document-wasm-test-"));
const output = resolve(process.env.DOCUMENT_PROBE_RESULTS ?? join(root, "artifacts/document-wasm"));
mkdirSync(output, { recursive: true });
function run(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: root,
  });
  if (result.error) throw result.error;
  assert.ok(result.stdout.trim(), `${binary}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const native = (path) => run(host, ["open", path]);
function sql(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all()
        .map(({ name }) => {
          const quoted = '"' + name.replaceAll('"', '""') + '"';
          const columns = db
            .prepare(`PRAGMA table_info(${quoted})`)
            .all()
            .map((c) => c.name)
            .filter((c) => name !== "meta" || c !== "modified_at");
          const statement = db.prepare(
            `SELECT ${columns.map((c) => '"' + c.replaceAll('"', '""') + '"').join(",")} FROM ${quoted}`,
          );
          statement.setReadBigInts(true);
          const rows = statement
            .all()
            .map((row) =>
              JSON.stringify(row, (_key, value) =>
                typeof value === "bigint"
                  ? { integer: value.toString() }
                  : value instanceof Uint8Array
                    ? { hex: Buffer.from(value).toString("hex") }
                    : value,
              ),
            )
            .sort();
          return [name, rows];
        }),
    );
  } finally {
    db.close();
  }
}

const report = {
  nativeCommit: "1b645299b206f3f87e9d3d9959428d2b245d6219",
  cliChecked: Boolean(cli),
  files: [],
  edits: [],
  refusals: [],
  payloadRoundtripDifferences: [],
};
try {
  const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json")));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(join(artifact, name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
    assert.equal(bytes.length, expected.bytes);
  }
  const kernel = await createDocumentModule({
    wasmBinary: readFileSync(join(artifact, "document.wasm")),
  });
  report.initMs = kernel.initMs;
  const files = ["current-contract", "document-wasm"].flatMap((dir) =>
    readdirSync(join(root, "test-data", dir))
      .filter((name) => name.endsWith(".fcad"))
      .sort()
      .map((name) => `test-data/${dir}/${name}`),
  );
  assert.equal(files.length, 101, "The complete pinned corpus must be present");
  for (const name of files) {
    const path = join(root, name),
      input = readFileSync(path);
    const expected = native(path),
      start = performance.now(),
      actual = kernel.open(input).json;
    const ms = performance.now() - start;
    assert.deepEqual(actual, expected, name);
    if (actual.ok) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        for (const object of actual.objects) {
          const id = Buffer.from(object.id.replaceAll("-", ""), "hex");
          const row = db.prepare("SELECT payload FROM objects WHERE id=?").get(id);
          if (!Buffer.from(row.payload).equals(Buffer.from(object.reencoded_bytes))) {
            // Native and WASM have already been compared byte for byte above.
            // Preserve evidence of a historical encoding rather than normalize it away.
            report.payloadRoundtripDifferences.push({
              file: name,
              object: object.id,
              storedHash: object.payload_hash,
              reencodedHash: object.reencoded_hash,
            });
          }
        }
      } finally {
        db.close();
      }
    }
    if (cli) {
      const checked = run(cli, ["validate", path, "--json"]);
      assert.equal(actual.ok, checked.ok, `${name}: validate execution`);
      if (!actual.ok) {
        assert.equal(actual.kind, checked.error.kind, name);
        assert.equal(actual.message, checked.error.message, name);
      } else {
        assert.equal(actual.validation.ok, checked.result.valid, name);
        assert.deepEqual(
          actual.validation.diagnostics,
          checked.result.diagnostics.map(({ object_id, ...d }) => ({ ...d, object: object_id })),
          name,
        );
      }
      const inspected = run(cli, ["inspect", path, "--json"]);
      if (!actual.ok) {
        assert.equal(inspected.ok, false, name);
        assert.equal(actual.kind, inspected.error.kind, name);
        assert.equal(actual.message, inspected.error.message, name);
      } else {
        assert.equal(inspected.ok, true, name);
        assert.equal(actual.content_version, inspected.result.content_version, name);
      }
    }
    report.files.push({
      file: name,
      match: true,
      opened: actual.ok,
      valid: actual.validation?.ok ?? false,
      openMs: ms,
    });
  }
  for (const [name, height] of [
    ["current-plate", 16],
    ["current-l", 10.1],
  ]) {
    const path = join(root, "test-data/current-contract", `${name}.fcad`),
      input = readFileSync(path),
      before = kernel.open(input).json;
    const slot = before.expression_slots.find((s) => s.slot.kind === "extrude_distance");
    const request = { object: slot.object, slot: slot.slot, value_mm: height };
    const requestPath = join(scratch, `${name}-request.json`);
    writeFileSync(requestPath, JSON.stringify(request));
    const start = performance.now(),
      result = kernel.setExpression(input, request),
      editMs = performance.now() - start;
    assert.equal(result.json.ok, true);
    assert.equal(result.json.validation.ok, true);
    const wasmPath = join(output, `${name}-wasm.fcad`);
    writeFileSync(wasmPath, result.bytes);
    const hostPath = join(scratch, `${name}-host.fcad`);
    run(host, ["set", path, requestPath, hostPath]);
    assert.equal(native(wasmPath).model_version, native(hostPath).model_version);
    assert.deepEqual(sql(wasmPath), sql(hostPath));
    assert.deepEqual(kernel.open(result.bytes).json, native(wasmPath));
    const fresh = await createDocumentModule({
      wasmBinary: readFileSync(join(artifact, "document.wasm")),
    });
    assert.deepEqual(fresh.open(result.bytes).json, native(wasmPath));
    if (cli) {
      const cliRequest = join(scratch, `${name}-cli.json`),
        cliPath = join(scratch, `${name}-cli.fcad`);
      writeFileSync(
        cliRequest,
        JSON.stringify({
          request_version: 1,
          changes: [
            {
              kind: "set_expression",
              object: slot.object,
              slot: slot.slot,
              value: height,
              unit: "mm",
            },
          ],
        }),
      );
      assert.equal(
        run(cli, [
          "edit",
          path,
          "--expect-version",
          before.content_version,
          "--request",
          cliRequest,
          "--output",
          cliPath,
          "--json",
        ]).ok,
        true,
      );
      assert.equal(native(wasmPath).model_version, native(cliPath).model_version);
      assert.deepEqual(sql(wasmPath), sql(cliPath));
      assert.equal(run(cli, ["validate", wasmPath, "--json"]).result.valid, true);
    }
    report.edits.push({
      name,
      height,
      editMs,
      model_version: result.json.model_version,
      sqlEqualExceptModifiedAt: true,
    });
    for (const [label, change] of [
      ["negative", { ...request, value_mm: -1 }],
      ["unknown-object", { ...request, object: "01900000-0000-7000-8000-000000000001" }],
      ["wrong-slot", { ...request, slot: { kind: "fillet_radius" } }],
    ]) {
      writeFileSync(requestPath, JSON.stringify(change));
      const refusal = kernel.setExpression(input, change);
      assert.equal(refusal.json.ok, false);
      assert.equal(refusal.bytes.length, 0);
      assert.deepEqual(
        refusal.json,
        run(host, ["set", path, requestPath, join(scratch, "must-not-exist.fcad")]),
      );
      if (cli) {
        const cliRequest = join(scratch, "bad-request.json");
        writeFileSync(
          cliRequest,
          JSON.stringify({
            request_version: 1,
            changes: [
              {
                kind: "set_expression",
                object: change.object,
                slot: change.slot,
                value: change.value_mm,
                unit: "mm",
              },
            ],
          }),
        );
        const rejected = run(cli, [
          "edit",
          path,
          "--expect-version",
          before.content_version,
          "--request",
          cliRequest,
          "--output",
          join(scratch, "must-not-exist.fcad"),
          "--json",
        ]);
        assert.equal(rejected.ok, false);
        assert.equal(refusal.json.kind, rejected.error.kind);
        assert.equal(refusal.json.message, rejected.error.message);
      }
      assert.deepEqual(kernel.open(input).json, before);
      report.refusals.push({ name, label, ...refusal.json });
    }
  }
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = String(error);
  throw error;
} finally {
  writeFileSync(join(output, "parity.json"), JSON.stringify(report, null, 2) + "\n");
  rmSync(scratch, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      pass: report.pass,
      inputs: report.files.length,
      edits: report.edits.length,
      refusals: report.refusals.length,
      cliChecked: report.cliChecked,
      historicalPayloadDifferences: report.payloadRoundtripDifferences.length,
      initMs: report.initMs,
    }),
  );
}
