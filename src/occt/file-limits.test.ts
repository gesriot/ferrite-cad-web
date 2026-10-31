import assert from "node:assert/strict";
import test from "node:test";
import { assertCadFileSize, MAX_FCAD_BYTES, openFcadBytes, readCadFile } from "./file-limits.ts";

test("file boundary rejects oversized input before reading or allocating SQLite", async () => {
  assert.doesNotThrow(() => assertCadFileSize(MAX_FCAD_BYTES));
  let reads = 0, allocations = 0;
  await assert.rejects(readCadFile({ size: MAX_FCAD_BYTES + 1, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }), /32 MiB/);
  assert.equal(reads, 0);
  assert.throws(() => openFcadBytes(new Uint8Array(MAX_FCAD_BYTES + 1), () => { allocations++; }), /32 MiB/);
  assert.equal(allocations, 0);
  await assert.rejects(readCadFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(MAX_FCAD_BYTES + 1) }), /32 MiB/);
  assert.deepEqual(await readCadFile(new File([Uint8Array.of(1, 2)], "small.fcad")), Uint8Array.of(1, 2));
});
