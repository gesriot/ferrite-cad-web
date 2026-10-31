import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEmbeddedStep, readFcad } from "../src/occt/fcad-doc.ts";
import { writeImportedDocument } from "../src/occt/fcad-import.ts";
import { bindImportedScene } from "../src/occt/fcad-scene.ts";
import { wrapSql } from "../src/occt/sql.ts";
import type { PortableScene } from "../src/xde/types.ts";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const goldenDir = process.env.FERRITE_GOLDENS ?? join(root, "test-data/writer-goldens");
const require = createRequire(import.meta.url);
const errors: string[] = [];
const fail = (message: string) => errors.push(message);

function norm(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function compareScene(file: string, scene: PortableScene, decoded: any) {
  const stored = decoded.objects[0].envelope.payload.scene;
  if (scene.sourceUnit !== stored.source_unit) fail(`${file} unit ${scene.sourceUnit} != ${stored.source_unit}`);
  if (scene.schema !== stored.schema) fail(`${file} schema ${scene.schema} != ${stored.schema}`);
  if (scene.definitions.length !== stored.definitions.length) fail(`${file} definition count`);
  stored.definitions.forEach((definition: any, index: number) => {
    const got = scene.definitions[index];
    if (!got || got.key !== definition.key || got.name !== definition.name || got.solids !== definition.solids) {
      fail(`${file} definition ${index} ${JSON.stringify(got)} != ${JSON.stringify(definition)}`);
    }
  });
  if (scene.instances.length !== stored.instances.length) fail(`${file} instance count ${scene.instances.length}`);
  stored.instances.forEach((instance: any, index: number) => {
    const got = scene.instances[index];
    if (!got) return;
    if (got.definition !== instance.definition || got.parent !== instance.parent || got.name !== instance.name || got.colourSource !== instance.colour_source) {
      fail(`${file} instance ${index} ${got.definition}/${got.parent}/${got.name}/${got.colourSource} != ${instance.definition}/${instance.parent}/${instance.name}/${instance.colour_source}`);
    }
    const placement = (got.placement ?? []).map(norm);
    const colour = (got.colour ?? []).map(norm);
    const expectedPlacement = instance.placement.map(norm);
    const expectedColour = instance.colour.map(norm);
    if (placement.length !== 12 || placement.some((value, at) => value !== expectedPlacement[at])) {
      fail(`${file} instance ${index} placement ${placement} != ${expectedPlacement}`);
    }
    if (colour.some((value, at) => value !== expectedColour[at])) fail(`${file} instance ${index} colour ${colour} != ${expectedColour}`);
  });
}

const init = (await import("@taucad/opencascade.js")).default;
const wasmDir = dirname(fileURLToPath(import.meta.resolve("@taucad/opencascade.js/wasm")));
const oc = await init({ locateFile: (name: string) => join(wasmDir, name) });
const { XdeEngine } = await import("../src/xde/engine.ts");
const engine = new XdeEngine(oc);
const initSql = require("sql.js");
const SQL = await initSql({ wasmBinary: readFileSync(join(root, "node_modules/sql.js/dist/sql-wasm.wasm")) });

const sources = readdirSync(join(goldenDir, "sources")).filter((name) => name.endsWith(".step")).sort();
for (const name of sources) {
  const bytes = new Uint8Array(readFileSync(join(goldenDir, "sources", name)));
  const decoded = JSON.parse(readFileSync(join(goldenDir, name.replace(/\.step$/, "-decoded.json")), "utf8"));
  const read = engine.read(bytes);
  if (read.sceneError || !read.scene) {
    fail(`${name} projection failed: ${read.sceneError}`);
    continue;
  }
  compareScene(name, read.scene, decoded);
  const stem = name.replace(/\.step$/, "");
  const empty = wrapSql(new SQL.Database());
  let fcad: Uint8Array;
  try {
    fcad = writeImportedDocument(empty, { step: bytes, sourceName: name, objectName: stem, scene: read.scene });
  } finally {
    empty.close();
  }
  const opened = wrapSql(new SQL.Database(fcad));
  opened.exec("PRAGMA foreign_keys = ON");
  const validated = readFcad(opened);
  if (!validated.ok || validated.editable) fail(`${name} written FCAD was not an uneditable import`);
  let embedded: Uint8Array;
  try {
    embedded = readEmbeddedStep(opened).step;
  } catch (error) {
    fail(`${name} embedded read ${error instanceof Error ? error.message : error}`);
    opened.close();
    continue;
  }
  opened.close();
  if (embedded.byteLength !== bytes.byteLength || embedded.some((byte, index) => byte !== bytes[index])) fail(`${name} embedded STEP is not the source`);
  const again = engine.read(embedded);
  if (!again.scene) fail(`${name} re-read had no scene: ${again.sceneError}`);
  else compareScene(`${name} reread`, again.scene, decoded);
  if (engine.temporaryFiles().length) fail(`${name} left ${engine.temporaryFiles().join(",")}`);
}

const plate = new Uint8Array(readFileSync(join(goldenDir, "sources", "01-single-part.step")));
const first = engine.read(plate);
const secondDb = wrapSql(new SQL.Database());
const thirdDb = wrapSql(new SQL.Database());
const one = writeImportedDocument(secondDb, { step: plate, sourceName: "01-single-part.step", objectName: "01-single-part", scene: first.scene! });
const two = writeImportedDocument(thirdDb, { step: plate, sourceName: "01-single-part.step", objectName: "01-single-part", scene: first.scene! });
secondDb.close();
thirdDb.close();
if (one.every((byte, index) => byte === two[index])) fail("two new documents were byte-identical");

const bad = structuredClone(first.scene!);
bad.instances[0]!.definition = "step.product_definition#999";
const badDb = wrapSql(new SQL.Database());
let badFile: Uint8Array;
try {
  badFile = writeImportedDocument(badDb, { step: plate, sourceName: "01-single-part.step", objectName: "bad", scene: bad, trustScene: true });
} finally {
  badDb.close();
}
const badOpen = wrapSql(new SQL.Database(badFile));
badOpen.exec("PRAGMA foreign_keys = ON");
const badRead = readFcad(badOpen);
badOpen.close();
if (badRead.ok) fail("missing definition key was accepted");
else if (!/missing definition/.test(badRead.error)) fail(`missing key error was ${badRead.error}`);

const assemblyPath = join(root, "fixtures/original-assembly.fcad");
const assemblyDb = wrapSql(new SQL.Database(readFileSync(assemblyPath)));
assemblyDb.exec("PRAGMA foreign_keys = ON");
const assembly = readEmbeddedStep(assemblyDb);
assemblyDb.close();
const assemblyRead = engine.read(assembly.step);
if (!assembly.scene || !assemblyRead.scene) fail(`original assembly scene missing (${assemblyRead.sceneError})`);
else {
  const bound = bindImportedScene(assembly.scene, assemblyRead.scene);
  if (!bound.confirmed) fail(`original assembly did not bind: ${bound.error}`);
}

const flat = new Uint8Array(readFileSync(join(goldenDir, "sources", "02-flat-assembly.step")));
engine.read(flat);
engine.shift("Pin", 5);
const shiftedExport = engine.exportStep().bytes;
const shiftedScene = engine.projectStep(shiftedExport);
const pinGolden = JSON.parse(readFileSync(join(goldenDir, "02-pin-plus-5mm-decoded.json"), "utf8"));
if (!shiftedScene.scene) fail(`shift export did not project: ${shiftedScene.sceneError}`);
else {
  compareScene("02-pin-plus-5mm.step", shiftedScene.scene, pinGolden);
  const shiftDb = wrapSql(new SQL.Database());
  const shiftFcad = writeImportedDocument(shiftDb, {
    step: shiftedExport,
    sourceName: "02-pin-plus-5mm.step",
    objectName: "02-pin-plus-5mm",
    scene: shiftedScene.scene,
  });
  shiftDb.close();
  const shiftOpen = wrapSql(new SQL.Database(shiftFcad));
  shiftOpen.exec("PRAGMA foreign_keys = ON");
  const shiftEmbedded = readEmbeddedStep(shiftOpen);
  shiftOpen.close();
  if (shiftEmbedded.step.byteLength !== shiftedExport.byteLength || shiftEmbedded.step.some((byte, index) => byte !== shiftedExport[index])) fail("shift FCAD embedded the old STEP");
  mkdirSync(join(root, "artifacts/xde/node"), { recursive: true });
  writeFileSync(join(root, "artifacts/xde/node/02-pin-plus-5mm.step"), shiftedExport);
  writeFileSync(join(root, "artifacts/xde/node/02-pin-plus-5mm.fcad"), shiftFcad);
  const shiftAgain = engine.read(shiftEmbedded.step);
  if (!shiftAgain.scene || !shiftEmbedded.scene) fail(`shift FCAD scene missing (${shiftAgain.sceneError})`);
  else {
    const bound = bindImportedScene(shiftEmbedded.scene, shiftAgain.scene);
    if (!bound.confirmed) fail(`shift FCAD did not bind: ${bound.error}`);
  }
}

const placed = structuredClone(first.scene!);
placed.instances[0]!.placement = placed.instances[0]!.placement.map((value, index) => (index === 3 ? value + 5 : value));
const placedDb = wrapSql(new SQL.Database());
const placedFile = writeImportedDocument(placedDb, {
  step: plate,
  sourceName: "01-single-part.step",
  objectName: "bad-placement",
  scene: placed,
  trustScene: true,
});
placedDb.close();
const placedOpen = wrapSql(new SQL.Database(placedFile));
placedOpen.exec("PRAGMA foreign_keys = ON");
const placedRead = readFcad(placedOpen);
const placedExtract = placedRead.ok ? readEmbeddedStep(placedOpen) : null;
placedOpen.close();
if (!placedRead.ok || !placedExtract?.scene) fail("tampered placement failed the hash check instead of the scene");
else {
  const fresh = engine.read(placedExtract.step);
  const bound = bindImportedScene(placedExtract.scene, fresh.scene);
  if (bound.confirmed) fail("wrong placement was confirmed");
  else if (!/placement of instance 0/.test(bound.error ?? "")) fail(`placement error was ${bound.error}`);
  mkdirSync(join(root, "artifacts/xde/probes"), { recursive: true });
  writeFileSync(join(root, "artifacts/xde/probes/bad-placement.fcad"), placedFile);
}

engine.release();
const ocRoot = (oc.FS.readdir("/") as string[]).filter((entry) => String(entry).startsWith("xde-"));
if (ocRoot.length) fail(`left ${ocRoot.join(",")}`);

const wireDir = join(root, "test-data/wire-probes");
for (const name of ["importer-id-nel.fcad", "importer-version-nel.fcad"]) {
  const refused = wrapSql(new SQL.Database(readFileSync(join(wireDir, name))));
  refused.exec("PRAGMA foreign_keys = ON");
  try {
    const opened = readFcad(refused);
    if (opened.ok) fail(`${name} was accepted`);
    else if (!/imported_by\.(id|version) is empty/.test(opened.error)) fail(`${name} ${opened.error}`);
    try {
      readEmbeddedStep(refused);
      fail(`${name} returned a STEP`);
    } catch {
      /* refused before a confirmed source */
    }
  } finally {
    refused.close();
  }
}
const wireEngine = new XdeEngine(oc);
try {
  for (const name of ["control.fcad", "importer-id-bom.fcad", "importer-version-bom.fcad", "solids-wide-uint.fcad", "source-length-wide-uint.fcad", "unknown-numeric-map.fcad"]) {
    const file = wrapSql(new SQL.Database(readFileSync(join(wireDir, name))));
    file.exec("PRAGMA foreign_keys = ON");
    try {
      const opened = readFcad(file);
      if (!opened.ok) {
        fail(`${name} ${opened.error}`);
        continue;
      }
      const extracted = readEmbeddedStep(file);
      if (!extracted.scene) {
        fail(`${name} has no portable scene`);
        continue;
      }
      try {
        const fresh = wireEngine.read(extracted.step);
        const bound = bindImportedScene(extracted.scene, fresh.scene);
        if (!bound.confirmed) fail(`${name} ${bound.error}`);
      } catch (error) {
        fail(`${name} ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      file.close();
    }
  }
} finally {
  wireEngine.release();
}
const wireRoot = (oc.FS.readdir("/") as string[]).filter((entry) => String(entry).startsWith("xde-"));
if (wireRoot.length) fail(`wire probes left ${wireRoot.join(",")}`);

console.log(JSON.stringify({ ok: errors.length === 0, files: sources.length, errors }, null, 2));
if (errors.length) process.exit(1);
