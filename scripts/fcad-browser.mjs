/**
 * Browser scenario for the supported FCAD slice and geometry-only STEP.
 *
 *   npm run test:fcad          node suite (brep + document), no browser
 *   npm run test:fcad:browser  this script
 *   npm run test:fcad:browser -- http://127.0.0.1:8081/
 *
 * The URL defaults to the production preview. Paths are relative to the
 * repository, not a hardcoded workspace root. A pageerror or a failed check
 * exits non-zero. Files are chosen through the page's file inputs; the page
 * must not request /fixtures/.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const url = checkedUrl(process.argv[2] || process.env.FCAD_URL || "http://127.0.0.1:8081/");
const outDir = resolve(root, "artifacts/format-roundtrip");
const reportPath = checkedOutputPath(join(outDir, "browser-report.json"), [root], "browser report");
mkdirSync(outDir, { recursive: true });

const plate = join(root, "fixtures/original-plate.fcad");
const profile = join(root, "fixtures/additional/offset-l-profile.fcad");
const assembly = join(root, "fixtures/original-assembly.fcad");
const step01 = join(root, "fixtures/step/canonical/01-single-part.step");
const step05 = join(root, "fixtures/step/canonical/05-inch-units.step");

const errors = [];
const downloads = {};

function fail(message) {
  errors.push(message);
  throw new Error(message);
}

function near(actual, expected, label) {
  if (!(Math.abs(actual - expected) <= 0.001)) fail(`${label}: ${actual} !~ ${expected}`);
}

async function volumeOf(page) {
  const raw = await page.locator("[data-exchange-volume]").first().getAttribute("data-exchange-volume");
  return Number(raw);
}

async function boundsOf(page) {
  const raw = await page.locator("[data-exchange-bounds]").first().getAttribute("data-exchange-bounds");
  return (raw ?? "").split(",").map(Number);
}

async function waitVolume(page, expected) {
  await page.waitForFunction(
    (target) => {
      const node = document.querySelector("[data-exchange-volume]");
      if (!node) return false;
      const value = Number(node.getAttribute("data-exchange-volume"));
      return Number.isFinite(value) && Math.abs(value - target) <= 0.001;
    },
    expected,
    { timeout: 180000 },
  );
  near(await volumeOf(page), expected, "volume");
}

async function openFile(page, selector, path, expected) {
  await page.locator(selector).setInputFiles(path);
  await waitVolume(page, expected);
}

async function setHeight(page, text, expected) {
  const input = page.locator("[data-exchange-height]");
  await input.fill(text);
  await input.press("Enter");
  await waitVolume(page, expected);
  const shown = await input.inputValue();
  if (shown !== text) fail(`height field is ${shown}, expected ${text}`);
}

async function expectHeightRefusal(page, text, expectedVolume) {
  const input = page.locator("[data-exchange-height]");
  await input.fill(text);
  await input.press("Enter");
  await page.waitForFunction(
    (snippet) => (document.querySelector("footer")?.textContent ?? "").includes(snippet),
    "Height",
    { timeout: 15000 },
  );
  near(await volumeOf(page), expectedVolume, `volume after refusing ${text}`);
}

async function downloadFrom(page, label, filename) {
  const item = page.getByRole("button", { name: label, exact: true });
  if (!(await item.isVisible())) await page.getByRole("button", { name: "File", exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 180000 }), item.click()]);
  const target = join(outDir, filename);
  await download.saveAs(target);
  return target;
}

async function snapshotOf(page) {
  await page.locator("[data-open-fcad]").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForFunction(() => typeof window.__fcadDebug?.snapshot === "function", null, { timeout: 30000 });
  return page.evaluate(() => window.__fcadDebug.snapshot());
}

async function debugCall(page, method) {
  await page.locator("[data-open-fcad]").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForFunction((name) => typeof window.__fcadDebug?.[name] === "function", method, { timeout: 30000 });
  return page.evaluate((name) => window.__fcadDebug[name](), method);
}
const uiDir = join(outDir, "ui");
mkdirSync(uiDir, { recursive: true });

async function assertEnglishChrome(page, label) {
  const text = await page.locator("body").innerText();
  const hit = text.match(/[А-Яа-яЁё]/);
  if (hit) {
    const at = text.indexOf(hit[0]);
    fail(`${label} shows Cyrillic near “${text.slice(Math.max(0, at - 40), at + 48)}”`);
  }
  if (/\d,\d/.test(text)) fail(`${label} shows a decimal comma`);
}

async function editSlice(page, relative, stem, names) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-fcad]", join(root, relative), 24000);
  const opened = await boundsOf(page);
  near(opened[3] - opened[0], 60, `${stem} width`);
  near(opened[4] - opened[1], 40, `${stem} depth`);
  near(opened[5] - opened[2], 10, `${stem} height`);
  if (names.length) {
    const tree = await page.locator("aside").first().innerText();
    for (const name of names) if (!tree.includes(name)) fail(`${stem} tree is missing ${name}`);
  }
  await setHeight(page, "10.1", 24240);
  const at = await boundsOf(page);
  near(at[3] - at[0], 60, `${stem} 10.1 width`);
  near(at[4] - at[1], 40, `${stem} 10.1 depth`);
  near(at[5] - at[2], 10.1, `${stem} 10.1 height`);
  const saved = await downloadFrom(page, "Save .fcad", `browser-${stem}-h10.1.fcad`);
  const step = await downloadFrom(page, "Export STEP", `browser-${stem}-h10.1.step`);
  checkSavedFcad(saved, plate, "10.1");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-fcad]", saved, 24240);
  if (names.length) {
    const again = await page.locator("aside").first().innerText();
    for (const name of names) if (!again.includes(name)) fail(`${stem} reopened tree is missing ${name}`);
    await page.screenshot({ path: join(uiDir, `${stem}.png`) });
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-step]", step, 24240);
  downloads[stem] = { fcad: saved, step };
}

function checkSavedFcad(saved, original, source) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(here, "fcad-download-check.ts"), saved, original, source],
    { encoding: "utf8" },
  );
  if (result.status !== 0) fail(result.stderr || result.stdout || `download check failed for ${saved}`);
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
const fixtureHits = [];
page.on("console", (message) => logs.push({ type: message.type(), text: message.text() }));
page.on("pageerror", (error) => logs.push({ type: "pageerror", text: String(error) }));
page.on("request", (request) => {
  if (request.url().includes("/fixtures/")) fixtureHits.push(request.url());
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("[data-open-fcad]").waitFor({ state: "attached" });

  const lang = await page.locator("html").getAttribute("lang");
  if (lang !== "en") fail(`html lang is ${lang}`);
  const description = await page.locator('meta[name="description"]').getAttribute("content");
  if (!description || /[А-Яа-яЁё]/.test(description) || !/sketch/i.test(description)) fail(`page description is not English: ${description}`);
  for (const label of ["Undo", "Redo", "File", "Help", "Select", "Rectangle", "Isometric", "Top", "Front", "Right", "Fit All"]) {
    if (!(await page.getByRole("button", { name: label, exact: true }).first().isVisible())) fail(`missing control ${label}`);
  }
  if ((await page.getByRole("button", { name: "Undo" }).first().getAttribute("title")) !== "Undo") fail("Undo tooltip is missing");
  const fresh = await page.locator("body").innerText();
  for (const label of ["Flange", "Base Sketch", "Base Extrude", "Bolt Holes", "Snap", "5.5", "mm"]) {
    if (!fresh.includes(label)) fail(`fresh session is missing ${label}`);
  }
  await page.locator("summary").filter({ hasText: "Parameters" }).click();
  await page.getByText("Bolt Count").first().waitFor();
  const countField = page.locator("label").filter({ hasText: "Bolt Count" });
  const countValue = await countField.locator("input").inputValue();
  const countUnit = await countField.locator("span").last().innerText();
  const diameterValue = await page.locator("label").filter({ hasText: "Bolt Ø" }).locator("input").inputValue();
  if (countValue !== "6" || countUnit !== "Count") fail(`bolt count shows ${countValue} ${countUnit}`);
  if (diameterValue !== "5.5") fail(`bolt diameter shows ${diameterValue}`);
  await assertEnglishChrome(page, "fresh desktop");
  await page.screenshot({ path: join(uiDir, "desktop-fresh.png") });
  const snap = page.locator("label").filter({ hasText: "Snap" }).locator("select");
  await snap.selectOption("0.1");
  if ((await snap.inputValue()) !== "0.1") fail("Snap 0.1 did not stick");
  await page.getByRole("button", { name: "File", exact: true }).click();
  for (const label of ["New Part", "Examples", "Open .fcad", "Save .fcad", "Open STEP", "Export STEP", "Open JSON", "Save JSON", "Export STL"]) {
    if (!(await page.getByRole("button", { name: label, exact: true }).isVisible())) fail(`file menu is missing ${label}`);
  }
  await page.getByRole("button", { name: "Examples", exact: true }).click();
  for (const name of ["Flange", "Plate", "Bracket", "Shaft", "Restore all examples"]) {
    if (!(await page.getByRole("button", { name }).first().isVisible())) fail(`examples are missing ${name}`);
  }
  await page.getByRole("button", { name: "File", exact: true }).click();
  if (await page.getByRole("button", { name: "New Part", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "File", exact: true }).click();
  }
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const help = page.locator("#help-title");
  await help.waitFor();
  const helpText = await page.locator("[aria-labelledby='help-title']").innerText();
  if (!/geometry only/i.test(helpText) || !/does not write the full/i.test(helpText)) fail("help does not separate examples, the FCAD slice, and STEP");
  if (/[А-Яа-яЁё]/.test(helpText)) fail("help is not English");
  await page.screenshot({ path: join(uiDir, "help.png") });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole("button", { name: "Model Tree", exact: true }).click();
  const drawer = page.locator("div.absolute.inset-0");
  await drawer.getByText("Base Sketch").waitFor();
  await page.screenshot({ path: join(uiDir, "narrow-tree.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Properties", exact: true }).click();
  await drawer.locator("summary").filter({ hasText: "Parameters" }).click();
  await drawer.getByText("Bolt Count").waitFor();
  await assertEnglishChrome(page, "narrow properties");
  await page.screenshot({ path: join(uiDir, "narrow-properties.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: "New Part", exact: true }).click();
  const created = await snapshotOf(page);
  const part = created.docs.find((doc) => doc.name === "Part 5");
  if (!part || part.sketches.length !== 0 || part.features.length !== 0) fail("New Part did not start as an empty Part 5");

  await openFile(page, "[data-open-fcad]", plate, 24000);
  const plateBounds = await boundsOf(page);
  near(plateBounds[3] - plateBounds[0], 60, "plate width");
  near(plateBounds[4] - plateBounds[1], 40, "plate depth");
  near(plateBounds[5] - plateBounds[2], 10, "plate height");
  for (const bad of ["0", "-4", "abc"]) await expectHeightRefusal(page, bad, 24000);

  await setHeight(page, "15", 36000);
  const raisedBounds = await boundsOf(page);
  near(raisedBounds[5] - raisedBounds[2], 15, "raised height");
  const plateFcad = await downloadFrom(page, "Save .fcad", "browser-plate-h15.fcad");
  const plateStep = await downloadFrom(page, "Export STEP", "browser-plate-h15.step");
  downloads.plateFcad = plateFcad;
  downloads.plateStep = plateStep;
  checkSavedFcad(plateFcad, plate, "15");

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-fcad]", plateFcad, 36000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-step]", plateStep, 36000);

  async function editProfile(source, expected, fcadName, stepName) {
    await setHeight(page, source, expected);
    const savedFcad = await downloadFrom(page, "Save .fcad", fcadName);
    const savedStep = await downloadFrom(page, "Export STEP", stepName);
    checkSavedFcad(savedFcad, profile, source);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFile(page, "[data-open-step]", savedStep, expected);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFile(page, "[data-open-fcad]", savedFcad, expected);
    const box = await boundsOf(page);
    near(box[0], -10, `${source} min x`);
    near(box[1], 5, `${source} min y`);
    near(box[3], 50, `${source} max x`);
    near(box[4], 45, `${source} max y`);
    near(box[5] - box[2], expected === 14400 ? 9 : expected === 160000 ? 100 : 10.1, `${source} height`);
    return savedFcad;
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-fcad]", profile, 20320);
  const lBounds = await boundsOf(page);
  near(lBounds[0], -10, "L min x");
  near(lBounds[1], 5, "L min y");
  near(lBounds[5] - lBounds[2], 12.7, "L height");
  await editProfile("9", 14400, "browser-l-h9.fcad", "browser-l-h9.step");
  await editProfile("100", 160000, "browser-l-h100.fcad", "browser-l-h100.step");
  await editProfile("10.1", 16160, "browser-l-h10.1.fcad", "browser-l-h10.1.step");

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-step]", step01, 24000);
  const box01 = await boundsOf(page);
  near(box01[3] - box01[0], 60, "01 width");
  near(box01[4] - box01[1], 40, "01 depth");
  near(box01[5] - box01[2], 10, "01 height");
  const exported01 = await downloadFrom(page, "Export STEP", "browser-01-single-part.step");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-step]", exported01, 24000);

  await openFile(page, "[data-open-step]", step05, 16387.064);
  const box05 = await boundsOf(page);
  near(box05[3] - box05[0], 50.8, "inch width");
  near(box05[4] - box05[1], 25.4, "inch depth");
  near(box05[5] - box05[2], 12.7, "inch height");
  const exported05 = await downloadFrom(page, "Export STEP", "browser-05-inch-units.step");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-step]", exported05, 16387.064);

  await openFile(page, "[data-open-fcad]", plate, 24000);
  const damaged = join(outDir, "damaged-plate.fcad");
  const damage = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(here, "fcad-download-check.ts"), damaged, plate, "--damage"],
    { encoding: "utf8" },
  );
  if (damage.status !== 0) fail(damage.stderr || damage.stdout || "could not build a damaged copy");
  const before = await volumeOf(page);
  await page.locator("[data-open-fcad]").setInputFiles(damaged);
  await page.waitForFunction(
    () => /BLAKE3/.test(document.querySelector("footer")?.textContent ?? ""),
    null,
    { timeout: 30000 },
  );
  near(await volumeOf(page), before, "volume after damaged file");

  await page.locator("[data-open-fcad]").setInputFiles(assembly);
  await page.waitForFunction(
    () => (document.querySelector("[data-exchange-file]")?.getAttribute("data-exchange-file") ?? "").includes("assembly"),
    null,
    { timeout: 30000 },
  );
  const assemblyVolume = await page.locator("[data-exchange-volume]").first().getAttribute("data-exchange-volume");
  if (assemblyVolume) fail(`assembly invented a solid ${assemblyVolume}`);
  const assemblySaved = await downloadFrom(page, "Download Original File", "browser-assembly-original.fcad");
  const assemblyHash = createHash("sha256").update(readFileSync(assembly)).digest("hex");
  const savedHash = createHash("sha256").update(readFileSync(assemblySaved)).digest("hex");
  if (assemblyHash !== savedHash) fail("saving an unsupported FCAD changed the original bytes");

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-fcad]", plate, 24000);
  await setHeight(page, "16", 38400);
  const dirtyBefore = await snapshotOf(page);
  const negativeFiles = [
    ["test-data/historical-integrity/parent-cycle.fcad", /parent-cycle|cycle/],
    ["test-data/historical-integrity/topology-producer-not-feature.fcad", /producer-not-feature|not a feature/],
    ["test-data/historical-integrity/topology-orphan-owner.fcad", /UUIDv7|foreign_key|SQLite/],
    ["test-data/historical-integrity/missing-profile-dependency.fcad", /missing-edge/],
    ["test-data/historical-integrity/not-sqlite.fcad", /SQLite/],
    ["test-data/historical-field-types/extrude-reversed-string.fcad", /expected bool|bool/],
    ["test-data/historical-field-types/curve-construction-string.fcad", /expected bool|bool/],
    ["test-data/historical-field-types/coordinate-numeric-string.fcad", /expected f64|f64/],
    ["test-data/historical-structure/topology-side-invalid.fcad", /unknown variant|start|end/],
    ["test-data/historical-structure/topology-fallback-bool.fcad", /expected map|map/],
    ["test-data/historical-structure/sketch-constraints-null.fcad", /expected array|array/],
    ["test-data/cbor-codec/duplicate-target-body.fcad", /duplicate field/],
    ["test-data/cbor-codec/duplicate-target-body-saved.fcad", /duplicate field/],
    ["test-data/cbor-codec/duplicate-topology-side.fcad", /duplicate field/],
    ["test-data/cbor-codec/duplicate-topology-side-saved.fcad", /duplicate field/],
    ["test-data/cbor-codec/invalid-utf8-unknown-field.fcad", /UTF-8|utf-8/],
    ["test-data/cbor-codec/invalid-utf8-unknown-field-saved.fcad", /UTF-8|utf-8/],
    ["test-data/cbor-unicode/bom-operation.fcad", /expected enum|unknown variant/],
    ["test-data/cbor-unicode/bom-operation-saved.fcad", /expected enum|unknown variant/],
  ];
  for (const [relative, pattern] of negativeFiles) {
    await page.locator("[data-open-fcad]").setInputFiles(join(root, relative));
    await page.waitForFunction(
      (source) => new RegExp(source, "i").test(document.querySelector("footer")?.textContent ?? ""),
      pattern.source,
      { timeout: 30000 },
    );
    near(await volumeOf(page), 38400, `volume after ${relative}`);
    if (await page.locator("[data-document-gate]").count()) fail(`${relative} asked to replace the open part`);
    const during = await snapshotOf(page);
    if (JSON.stringify(during.docs) !== JSON.stringify(dirtyBefore.docs)) fail(`${relative} changed the legacy model`);
    if (relative.endsWith("bom-operation.fcad")) await page.screenshot({ path: join(uiDir, "bom-operation-refused.png") });
  }
  const keptFcad = await downloadFrom(page, "Save .fcad", "browser-plate-h16-kept.fcad");
  const keptStep = await downloadFrom(page, "Export STEP", "browser-plate-h16-kept.step");
  checkSavedFcad(keptFcad, plate, "16");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-step]", keptStep, 38400);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-fcad]", keptFcad, 38400);

  for (const [relative, stem] of [
    ["test-data/cbor-codec/missing-target-body.fcad", "missing-target"],
    ["test-data/cbor-codec/missing-fallback-signature.fcad", "missing-fallback"],
    ["test-data/cbor-codec/integer-distance.fcad", "integer-distance"],
  ]) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFile(page, "[data-open-fcad]", join(root, relative), 24000);
    const opened = await boundsOf(page);
    near(opened[3] - opened[0], 60, `${stem} width`);
    near(opened[4] - opened[1], 40, `${stem} depth`);
    near(opened[5] - opened[2], 10, `${stem} height`);
    await setHeight(page, "15", 36000);
    const saved15 = await downloadFrom(page, "Save .fcad", `browser-${stem}-h15.fcad`);
    const step15 = await downloadFrom(page, "Export STEP", `browser-${stem}-h15.step`);
    checkSavedFcad(saved15, plate, "15");
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFile(page, "[data-open-step]", step15, 36000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFile(page, "[data-open-fcad]", saved15, 36000);
    await setHeight(page, "10.1", 24240);
    const at = await boundsOf(page);
    near(at[3] - at[0], 60, `${stem} 10.1 width`);
    near(at[4] - at[1], 40, `${stem} 10.1 depth`);
    near(at[5] - at[2], 10.1, `${stem} 10.1 height`);
    const saved101 = await downloadFrom(page, "Save .fcad", `browser-${stem}-h10.1.fcad`);
    const step101 = await downloadFrom(page, "Export STEP", `browser-${stem}-h10.1.step`);
    checkSavedFcad(saved101, plate, "10.1");
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFile(page, "[data-open-fcad]", saved101, 24240);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFile(page, "[data-open-step]", step101, 24240);
  }

  await editSlice(page, "test-data/cbor-unicode/bom-unknown-key.fcad", "bom-unknown-key", []);
  await editSlice(page, "test-data/user-names/unicode-user-names.fcad", "unicode-user-names", [
    "Плоскость Ω",
    "Эскиз 日本",
    "Моя высота",
    "Деталь π",
  ]);

  await page.reload({ waitUntil: "domcontentloaded" });
  const legacyBefore = await snapshotOf(page);
  if (!JSON.stringify(legacyBefore.docs).includes("Flange") || !JSON.stringify(legacyBefore.docs).includes("Base Sketch")) {
    fail("fresh samples are missing Flange / Base Sketch");
  }
  await openFile(page, "[data-open-fcad]", plate, 24000);
  await page.locator("header").click({ position: { x: 12, y: 12 } });
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Control+y");
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Redo" }).click();
  await page.keyboard.press("h");
  await page.keyboard.press("i");
  await page.keyboard.press("u");
  const legacyAfter = await snapshotOf(page);
  if (JSON.stringify(legacyAfter.docs) !== JSON.stringify(legacyBefore.docs)) fail("commands changed the hidden legacy document");
  near(await volumeOf(page), 24000, "volume after blocked commands");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: "Save JSON", exact: true }).click();
  const afterJson = await snapshotOf(page);
  if (JSON.stringify(afterJson.docs) !== JSON.stringify(legacyBefore.docs)) fail("JSON export changed the hidden document");
  if (!/JSON/.test((await page.locator("footer").textContent()) ?? "")) fail("JSON export did not explain the active document");

  await setHeight(page, "16", 38400);
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: "New Part", exact: true }).click();
  await page.locator("[data-document-gate]").waitFor({ timeout: 15000 });
  const dirtyGate = await page.locator("[data-document-gate]").innerText();
  for (const label of ["Unsaved changes", "Download Changes", "Cancel", "Discard"]) {
    if (!dirtyGate.includes(label)) fail(`dirty dialog is missing ${label}`);
  }
  if (/[А-Яа-яЁё]/.test(dirtyGate)) fail("dirty dialog is not English");
  await page.screenshot({ path: join(uiDir, "dirty-dialog.png") });
  await page.locator("[data-gate-action='cancel']").click();
  near(await volumeOf(page), 38400, "volume after cancelled new");
  await page.locator("[data-open-fcad]").setInputFiles(assembly);
  await page.locator("[data-document-gate]").waitFor({ timeout: 30000 });
  const unsupportedGate = await page.locator("[data-document-gate]").innerText();
  if (!unsupportedGate.includes("Download Original File") || !unsupportedGate.includes("File is not supported")) {
    fail("unsupported dialog is missing its English actions");
  }
  await page.screenshot({ path: join(uiDir, "unsupported-dialog.png") });
  const [sourceDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.locator("[data-gate-action='download-source']").click(),
  ]);
  const sourcePath = join(outDir, "browser-assembly-while-dirty.fcad");
  await sourceDownload.saveAs(sourcePath);
  const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  if (sourceHash !== assemblyHash) fail("unsupported source download did not keep the original bytes");
  near(await volumeOf(page), 38400, "volume after downloading unsupported source");
  await page.locator("[data-open-fcad]").setInputFiles(assembly);
  await page.locator("[data-document-gate]").waitFor({ timeout: 30000 });
  await page.locator("[data-gate-action='discard']").click();
  await page.waitForFunction(
    () => (document.querySelector("[data-exchange-file]")?.getAttribute("data-exchange-file") ?? "").includes("assembly"),
    null,
    { timeout: 30000 },
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-fcad]", plate, 24000);
  await debugCall(page, "failSql");
  await page.locator("[data-open-fcad]").setInputFiles(profile);
  await page.waitForFunction(() => /SQLite/.test(document.querySelector("footer")?.textContent ?? ""), null, { timeout: 30000 });
  near(await volumeOf(page), 24000, "volume after sql failure");
  await debugCall(page, "failExtrude");
  const height = page.locator("[data-exchange-height]");
  await height.fill("15");
  await height.press("Enter");
  await page.waitForFunction(() => /OCCT|WASM/.test(document.querySelector("footer")?.textContent ?? ""), null, { timeout: 30000 });
  near(await volumeOf(page), 24000, "volume after occt failure");
  await setHeight(page, "15", 36000);
  await debugCall(page, "crash");
  await page.waitForTimeout(300);
  const revived = await downloadFrom(page, "Export STEP", "browser-after-worker-crash.step");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-step]", revived, 36000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-step]", step01, 24000);
  await debugCall(page, "crash");
  await page.waitForTimeout(300);
  const revivedStep = await downloadFrom(page, "Export STEP", "browser-step-after-crash.step");
  near(await volumeOf(page), 24000, "step volume after worker crash");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, "[data-open-step]", revivedStep, 24000);

  const legacyPath = join(root, "test-data/user-names/legacy-russian-user.ferrite.json");
  const legacyDoc = JSON.parse(readFileSync(legacyPath, "utf8"));
  const legacyContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await legacyContext.addInitScript((payload) => {
    if (localStorage.getItem("ferrite-cad-v1")) return;
    localStorage.setItem("ferrite-cad-v1", JSON.stringify({ v: 1, docs: [payload], activeId: payload.id }));
  }, legacyDoc);
  const legacyPage = await legacyContext.newPage();
  legacyPage.on("pageerror", (error) => logs.push({ type: "pageerror", text: String(error) }));
  await legacyPage.goto(url, { waitUntil: "domcontentloaded" });
  await legacyPage.locator("[data-open-fcad]").waitFor({ state: "attached" });
  const legacyText = await legacyPage.locator("body").innerText();
  for (const name of ["Мой фланец Ω", "Эскиз заказчика", "Ступица заказчика", "Болтов"]) {
    if (!legacyText.includes(name)) fail(`legacy session translated or dropped ${name}`);
  }
  if (!legacyText.includes("Count")) fail("legacy count unit is not displayed as Count");
  const bolt = legacyPage.locator("label", { hasText: "Болтов" }).locator("input");
  await bolt.fill("6.6");
  await bolt.press("Enter");
  await legacyPage.waitForFunction(() => {
    const raw = localStorage.getItem("ferrite-cad-v1");
    if (!raw) return false;
    const data = JSON.parse(raw);
    const param = data.docs?.[0]?.parameters?.find((item) => item.id === "boltN");
    return param?.value === 7 && param.unit === "шт" && param.name === "Болтов" && data.docs[0].name === "Мой фланец Ω";
  }, null, { timeout: 5000 });
  const stored = await snapshotOf(legacyPage);
  const storedBolt = stored.docs[0].parameters.find((item) => item.id === "boltN");
  if (!storedBolt || storedBolt.value !== 7 || storedBolt.unit !== "шт") fail("bolt count did not stay an integer with unit шт");
  if (!stored.docs[0].sketches.some((item) => item.name === "Эскиз заказчика")) fail("legacy sketch name changed");
  if (!stored.docs[0].features.some((item) => item.name === "Ступица заказчика")) fail("legacy feature name changed");
  await legacyPage.getByRole("button", { name: "File", exact: true }).click();
  const [jsonDownload] = await Promise.all([
    legacyPage.waitForEvent("download", { timeout: 15000 }),
    legacyPage.getByRole("button", { name: "Save JSON", exact: true }).click(),
  ]);
  const jsonPath = join(outDir, "browser-legacy-user.ferrite.json");
  await jsonDownload.saveAs(jsonPath);
  const savedJson = JSON.parse(readFileSync(jsonPath, "utf8"));
  const savedBolt = savedJson.parameters.find((item) => item.id === "boltN");
  if (savedJson.name !== "Мой фланец Ω" || !savedBolt || savedBolt.value !== 7 || savedBolt.unit !== "шт" || savedBolt.name !== "Болтов") {
    fail("JSON export translated the legacy document");
  }
  await legacyPage.reload({ waitUntil: "domcontentloaded" });
  await legacyPage.locator("[data-open-fcad]").waitFor({ state: "attached" });
  const reloaded = await snapshotOf(legacyPage);
  const againBolt = reloaded.docs[0].parameters.find((item) => item.id === "boltN");
  if (reloaded.docs[0].name !== "Мой фланец Ω" || !againBolt || againBolt.value !== 7 || againBolt.unit !== "шт") {
    fail("reload lost the legacy name or integer count");
  }
  const reloadedText = await legacyPage.locator("body").innerText();
  if (!reloadedText.includes("Ступица заказчика") || !reloadedText.includes("Эскиз заказчика")) fail("reload stopped showing the user's names");
  await legacyPage.screenshot({ path: join(uiDir, "legacy-russian-user.png") });
  await legacyContext.close();

  await page.screenshot({ path: join(root, "screenshots/fcad-browser.png") });
  if (fixtureHits.length) fail(`page requested fixtures: ${fixtureHits.join(", ")}`);
  const pageErrors = logs.filter((item) => item.type === "pageerror");
  if (pageErrors.length) fail(pageErrors.map((item) => item.text).join("\n"));
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  await page.screenshot({ path: join(root, "screenshots/fcad-browser.png") }).catch(() => undefined);
} finally {
  await browser.close();
}

const pageErrors = logs.filter((item) => item.type === "pageerror");
const report = {
  ok: errors.length === 0 && pageErrors.length === 0 && fixtureHits.length === 0,
  url,
  downloads,
  fixtureHits,
  errors,
  pageErrors,
  logs: logs.filter((item) => item.type === "error" || item.type === "pageerror").slice(0, 40),
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, errors, fixtureHits, downloads }, null, 2));
if (!report.ok) process.exit(1);
