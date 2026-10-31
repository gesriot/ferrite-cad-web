import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createBuildInfo } from "./build-info.mjs";

test("build identity follows source bytes and keeps the native basis separate", () => {
  const root = mkdtempSync(join(tmpdir(), "build-info-"));
  try {
    mkdirSync(join(root, "src/occt"), { recursive: true });
    const basis = "2f8b25993e1ebba426dd2bb14cc40af20106d92b";
    writeFileSync(join(root, "src/occt/fcad-current.ts"), `export const CURRENT_BASIS = "current native main ${basis}";`);
    const before = createBuildInfo(root);
    assert.deepEqual(createBuildInfo(root), before);
    writeFileSync(join(root, "src/app.ts"), "export const version = 2;");
    const after = createBuildInfo(root);
    assert.notEqual(after.buildId, before.buildId);
    assert.equal(after.nativeBasis, basis);
    assert.match(after.sourceHash, /^[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
