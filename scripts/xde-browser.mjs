/**
 * Production-build browser proof for the STEP/XDE worker.
 *
 *   npm run test:xde:browser
 *   npm run test:xde:browser -- http://127.0.0.1:8081/
 *
 * The page must not request fixtures. Files are chosen with setInputFiles.
 * Export is downloaded, the worker is ended, and a new worker reads that download.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";
import { compareReports, expectRead, expectRotation, expectShift } from "./xde-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const url = checkedUrl(process.argv[2] || process.env.XDE_URL || "http://127.0.0.1:8081/");
const outDir = checkedOutputPath(join(root, "artifacts/xde/browser/report.json"), [root], "browser report");
const browserDir = dirname(outDir);
const shot = checkedOutputPath(join(root, "screenshots/xde-assembly.png"), [root], "screenshot");
mkdirSync(browserDir, { recursive: true });
mkdirSync(dirname(shot), { recursive: true });

const canonical = join(root, "fixtures/step/canonical");
const files = [
  "01-single-part.step",
  "02-flat-assembly.step",
  "03-nested-assembly.step",
  "04-instance-colours.step",
  "05-inch-units.step",
  "06-unicode-names.step",
  "07-bare-geometry.step",
];

const errors = [];
const logs = [];
const requests = [];
const wasm = [];
function fail(message) {
  errors.push(message);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--enable-precise-memory-info"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (message) => logs.push({ type: message.type(), text: message.text() }));
page.on("pageerror", (error) => logs.push({ type: "pageerror", text: String(error) }));
page.on("request", (request) => requests.push(request.url()));
page.on("response", (response) => {
  const target = response.url();
  if (!target.includes(".wasm")) return;
  wasm.push({
    url: target.split("/").pop(),
    status: response.status(),
    contentType: response.headers()["content-type"] ?? "",
    length: Number(response.headers()["content-length"] ?? 0),
  });
});

async function reportOf() {
  const text = await page.locator("#xde-report").innerText({ timeout: 180000 });
  return JSON.parse(text);
}
async function sessionOf() {
  return Number(await page.locator("main").getAttribute("data-xde-session"));
}
async function readFile(path) {
  await page.locator("#xde-file").setInputFiles(path);
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.locator("#xde-report").waitFor({ state: "visible", timeout: 180000 });
  return { report: await reportOf(), session: await sessionOf() };
}
async function exportStep(name) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180000 }),
    page.getByRole("button", { name: "Export STEP" }).click(),
  ]);
  const target = join(browserDir, name);
  await download.saveAs(target);
  return target;
}
async function saveImported(name) {
  if ((await page.locator("[data-xde-save]").getAttribute("data-xde-save")) !== "yes") {
    fail(`${name} was offered without a portable scene`);
  }
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180000 }),
    page.getByRole("button", { name: "Save imported FCAD" }).click(),
  ]);
  const target = join(browserDir, name);
  await download.saveAs(target);
  await page.locator("main[data-xde-state='ready']").waitFor({ timeout: 180000 });
  return target;
}
async function fitAndRead() {
  const before = await page.locator("[data-xde-fit]").getAttribute("data-xde-fit");
  await page.getByRole("button", { name: "Fit all" }).click();
  await page.waitForFunction((previous) => {
    const raw = document.querySelector("[data-xde-fit]")?.getAttribute("data-xde-fit") ?? "";
    return raw !== previous && raw.includes(",");
  }, before, { timeout: 5000 }).catch(() => undefined);
  return (await page.locator("[data-xde-fit]").getAttribute("data-xde-fit")) ?? "";
}
function ndcInside(raw, label) {
  const [x, y] = raw.split(",").map(Number);
  if (!(x <= 1 && y <= 1)) fail(`${label} fit left NDC ${raw}`);
}
async function endSession() {
  await page.getByRole("button", { name: "End session" }).click();
  await page.locator("main[data-xde-ended='yes']").waitFor();
}
function xdeWorkerCount(target) {
  return target.workers().filter((worker) => /xde|opencascade_full/i.test(worker.url())).length;
}
async function waitVolume(target, expected) {
  await target.waitForFunction(
    (value) => {
      const node = document.querySelector("[data-exchange-volume]");
      if (!node) return false;
      const actual = Number(node.getAttribute("data-exchange-volume"));
      return Number.isFinite(actual) && Math.abs(actual - value) <= 0.001;
    },
    expected,
    { timeout: 180000 },
  );
}
async function highlightedIds(target) {
  const raw = await target.locator("[data-xde-canvas]").getAttribute("data-xde-highlighted");
  return new Set((raw ?? "").split(/\s+/).filter(Boolean));
}
async function clickOccurrence(target, occurrenceId) {
  await target.locator(`[data-occurrence="${occurrenceId}"]`).click();
  await target.locator(`[data-occurrence="${occurrenceId}"][data-selected="yes"]`).waitFor({ timeout: 15000 });
}
async function clickMesh(target, occurrenceId) {
  await target.locator("[data-xde-canvas]").waitFor({ timeout: 30000 });
  await target.waitForFunction((id) => {
    const node = document.querySelector(`[data-occurrence="${id}"]`);
    const x = Number(node?.getAttribute("data-screen-x"));
    const y = Number(node?.getAttribute("data-screen-y"));
    return Number.isFinite(x) && Number.isFinite(y);
  }, occurrenceId, { timeout: 15000 });
  const button = target.locator(`[data-occurrence="${occurrenceId}"]`);
  const x = Number(await button.getAttribute("data-screen-x"));
  const y = Number(await button.getAttribute("data-screen-y"));
  await target.mouse.click(x, y);
  await target.locator(`[data-occurrence="${occurrenceId}"][data-selected="yes"]`).waitFor({ timeout: 5000 });
}

try {
  const home = new URL("/", url).toString();
  await page.goto(home, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByRole("button", { name: "File", exact: true }).waitFor({ timeout: 60000 });
  const before = await page.evaluate(() => window.__fcadDebug?.snapshot?.() ?? null);
  const homeRequests = requests.filter((item) => item.includes("opencascade_full") || item.includes("/fixtures/"));
  if (homeRequests.length) fail(`home page requested ${homeRequests.join(", ")}`);

  await page.getByRole("link", { name: "Assemblies" }).click();
  await page.getByRole("button", { name: "Read", exact: true }).waitFor();
  const beforeRead = requests.filter((item) => item.includes("opencascade_full"));
  if (beforeRead.length) fail("opening the prototype downloaded the XDE wasm before a file was chosen");

  const originals = new Map();
  const downloads = {};
  const fcadDownloads = {};
  let shotTaken = false;
  for (const name of files) {
    const result = await readFile(join(canonical, name));
    originals.set(name, result.report);
    for (const message of expectRead(name, result.report)) fail(`browser read ${name}: ${message}`);
    await page.locator("[data-xde-canvas]").waitFor({ timeout: 30000 });
    if ((await page.locator("main").getAttribute("data-xde-scene")) !== "ready") fail(`${name} did not project a portable scene`);
    if (name.startsWith("01")) {
      const epoch = await page.locator("[data-xde-canvas]").getAttribute("data-xde-view");
      await page.evaluate(() => {
        const box = document.querySelector("[data-xde-canvas]")?.parentElement;
        if (!box) return;
        box.style.width = "280px";
        box.style.height = "420px";
        box.style.minHeight = "420px";
        box.style.maxWidth = "280px";
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => {
        const width = document.querySelector("[data-xde-canvas]")?.clientWidth ?? 0;
        return width > 0 && width <= 320;
      }, null, { timeout: 5000 });
      ndcInside(await fitAndRead(), "narrow 280x420");
      await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-fit-narrow.png"), [root], "narrow fit"), fullPage: true });
      await page.evaluate(() => {
        const box = document.querySelector("[data-xde-canvas]")?.parentElement;
        if (!box) return;
        box.style.width = "800px";
        box.style.height = "420px";
        box.style.maxWidth = "800px";
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => (document.querySelector("[data-xde-canvas]")?.clientWidth ?? 0) >= 700, null, { timeout: 5000 });
      ndcInside(await fitAndRead(), "wide 800x420");
      await page.evaluate(() => {
        const box = document.querySelector("[data-xde-canvas]")?.parentElement;
        if (!box) return;
        box.style.width = "";
        box.style.height = "";
        box.style.minHeight = "";
        box.style.maxWidth = "";
      });
      const plate = result.report.nodes.find((node) => !node.isAssembly);
      await clickOccurrence(page, plate.occurrenceId);
      if ((await page.locator("[data-xde-canvas]").getAttribute("data-xde-view")) !== epoch) fail("selection remounted the 3D view");
      const reportBeforeClear = JSON.stringify(await reportOf());
      const box = await page.locator("[data-xde-canvas]").boundingBox();
      await page.mouse.click(box.x + 2, box.y + 2);
      await page.waitForFunction(() => !document.querySelector("[data-selected='yes']"), null, { timeout: 5000 });
      if (JSON.stringify(await reportOf()) !== reportBeforeClear) fail("clearing selection changed the report");
      if ((await highlightedIds(page)).size !== 0) fail("clearing selection left a highlight");
      const firstSave = await saveImported("01-single-part.fcad");
      const secondSave = await saveImported("01-single-part-again.fcad");
      const again = readFileSync(secondSave);
      if (Buffer.compare(readFileSync(firstSave), again) !== 0) fail("repeated save of the same revision changed bytes");
      fcadDownloads[name] = firstSave;
    }
    if (name.startsWith("02")) {
      const pin = result.report.nodes.find((node) => node.definitionName === "Pin");
      const base = result.report.nodes.find((node) => node.definitionName === "Base");
      const before = JSON.stringify(result.report.nodes);
      const epoch = await page.locator("[data-xde-canvas]").getAttribute("data-xde-view");
      await clickMesh(page, pin.occurrenceId);
      const pinHighlight = await highlightedIds(page);
      if (!pinHighlight.has(pin.occurrenceId) || pinHighlight.has(base.occurrenceId)) fail("selecting Pin highlighted Base");
      if ((await page.locator(`[data-occurrence="${base.occurrenceId}"]`).getAttribute("data-selected")) === "yes") fail("Pin selection marked Base");
      if (JSON.stringify((await reportOf()).nodes) !== before) fail("selecting Pin changed the XDE report");
      if ((await page.locator("[data-xde-canvas]").getAttribute("data-xde-view")) !== epoch) fail("selecting Pin remounted the 3D view");
      await page.getByRole("button", { name: "Fit all" }).click();
      await page.screenshot({ path: shot, fullPage: true });
      shotTaken = true;
    }
    if (name.startsWith("03")) {
      const groups = result.report.nodes.filter((node) => node.definitionName === "InnerGroup");
      const cubes = result.report.nodes.filter((node) => node.definitionName === "Cube");
      if (groups.length !== 2 || cubes.length !== 4) fail(`03 viewer counts groups=${groups.length} cubes=${cubes.length}`);
      const own = cubes.filter((node) => node.parentOccurrenceId === groups[0].occurrenceId);
      const other = cubes.filter((node) => node.parentOccurrenceId === groups[1].occurrenceId);
      await clickOccurrence(page, groups[0].occurrenceId);
      const groupHighlight = await highlightedIds(page);
      if (groupHighlight.has(groups[1].occurrenceId)) fail("InnerGroup selection highlighted the other group");
      for (const cube of own) if (!groupHighlight.has(cube.occurrenceId)) fail("InnerGroup did not highlight its cubes");
      for (const cube of other) if (groupHighlight.has(cube.occurrenceId)) fail("InnerGroup highlighted a cube from the other branch");
      await clickMesh(page, other[0].occurrenceId);
      const cubeHighlight = await highlightedIds(page);
      if (!cubeHighlight.has(other[0].occurrenceId) || cubeHighlight.has(own[0].occurrenceId) || cubeHighlight.has(groups[0].occurrenceId)) {
        fail("cube selection leaked into the other branch");
      }
      const cubePoints = [];
      for (const cube of cubes) {
        const row = page.locator(`[data-occurrence="${cube.occurrenceId}"]`);
        cubePoints.push({
          id: cube.occurrenceId,
          parent: cube.parentOccurrenceId,
          x: Number(await row.getAttribute("data-screen-x")),
          y: Number(await row.getAttribute("data-screen-y")),
        });
      }
      const selectedBefore = await page.locator("[data-selected='yes']").getAttribute("data-occurrence");
      const selectedNode = cubes.find((cube) => cube.occurrenceId === selectedBefore) ?? cubes[0];
      const idleGroup = groups.find((group) => group.occurrenceId !== selectedNode.parentOccurrenceId);
      const idleDisclosure = page.locator(`[data-disclosure="${idleGroup.occurrenceId}"]`);
      if (!(await idleDisclosure.getAttribute("aria-label"))?.includes(idleGroup.occurrenceId)) fail("InnerGroup disclosures are not distinct");
      await idleDisclosure.click();
      if ((await idleDisclosure.getAttribute("aria-expanded")) !== "false") fail("disclosure did not collapse");
      if ((await page.locator("[data-selected='yes']").getAttribute("data-occurrence")) !== selectedBefore) fail("disclosure changed the selection");
      const ownDisclosure = page.locator(`[data-disclosure="${selectedNode.parentOccurrenceId}"]`);
      await ownDisclosure.click();
      if ((await ownDisclosure.getAttribute("aria-expanded")) !== "false") fail("second disclosure did not collapse");
      if (await page.locator(`[data-occurrence="${selectedNode.occurrenceId}"]`).count()) fail("collapsed cube stayed in the tree");
      for (const cube of cubes) {
        if (await page.locator(`[data-occurrence="${cube.occurrenceId}"]`).count()) fail("collapsed cube stayed in the tree");
      }
      const hidden = cubePoints.find((cube) => cube.parent === idleGroup.occurrenceId);
      await page.mouse.click(hidden.x, hidden.y);
      await page.locator(`[data-occurrence="${hidden.id}"][data-selected="yes"]`).waitFor({ timeout: 5000 });
      const parentDisclosure = page.locator(`[data-disclosure="${hidden.parent}"]`);
      if ((await parentDisclosure.getAttribute("aria-expanded")) !== "true") fail("selecting a cube did not expand its group");
      if ((await page.locator(`[data-disclosure="${selectedNode.parentOccurrenceId}"]`).getAttribute("aria-expanded")) !== "false") {
        fail("selecting a cube expanded the other InnerGroup");
      }
      await parentDisclosure.focus();
      await page.keyboard.press("ArrowLeft");
      if ((await parentDisclosure.getAttribute("aria-expanded")) !== "false") fail("ArrowLeft did not collapse");
      if ((await page.locator(`[data-occurrence="${hidden.id}"]`).count()) !== 0) fail("ArrowLeft left the child mounted");
      await parentDisclosure.focus();
      await page.keyboard.press("ArrowRight");
      await page.locator(`[data-occurrence="${hidden.id}"]`).waitFor({ timeout: 5000 });
      const rowBox = await page.locator(`[data-occurrence="${hidden.id}"]`).boundingBox();
      const treeBox = await page.locator("[data-xde-tree]").boundingBox();
      if (!rowBox || !treeBox || rowBox.y < treeBox.y - 2 || rowBox.y + rowBox.height > treeBox.y + treeBox.height + 2) {
        fail("selected row is outside the visible tree");
      }
      await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-tree-03.png"), [root], "03 tree"), fullPage: true });
      await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-viewer-03.png"), [root], "03 viewer"), fullPage: true });
    }
    if (name.startsWith("04")) {
      const bolts = result.report.nodes.filter((node) => node.definitionName === "Bolt");
      if (bolts.length !== 4) fail(`04 bolt count ${bolts.length}`);
      const before = JSON.stringify(result.report.nodes);
      for (const bolt of bolts) {
        await clickOccurrence(page, bolt.occurrenceId);
        const ids = await highlightedIds(page);
        if (!ids.has(bolt.occurrenceId)) fail("bolt was not highlighted");
        for (const other of bolts) if (other.occurrenceId !== bolt.occurrenceId && ids.has(other.occurrenceId)) fail("bolt highlight leaked");
      }
      if (JSON.stringify((await reportOf()).nodes) !== before) fail("highlight changed the 04 report before export");
      await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-viewer-04.png"), [root], "04 viewer"), fullPage: true });
    }
    if (name.startsWith("02") && !shotTaken) {
      await page.screenshot({ path: shot, fullPage: true });
      shotTaken = true;
    }
    if (!name.startsWith("01")) fcadDownloads[name] = await saveImported(name.replace(/\.step$/, ".fcad"));
    downloads[name] = await exportStep(name);
  }
  const rotatedExpected = JSON.parse(readFileSync(join(root, "test-data/rotated-assembly/EXPECTED.json"), "utf8"));
  const rotated = await readFile(join(root, "test-data/rotated-assembly/08-rotated-nested.step"));
  for (const message of expectRotation(rotated.report, rotatedExpected)) fail(`browser 08: ${message}`);
  const bounds = await page.locator("[data-xde-canvas]").getAttribute("data-definition-bounds");
  const cubeBox = (bounds ?? "").split("|").map((item) => item.split(":")[1]?.split(",").map(Number) ?? []);
  const definitionCube = cubeBox.find((box) => box.length === 6 && box.every((value, index) => Math.abs(value - [0, 0, 0, 20, 20, 20][index]) <= 0.5));
  if (!definitionCube) fail(`08 mesh is not the definition cube (${bounds})`);
  const cubes = rotated.report.nodes.filter((node) => node.definitionName === "Cube");
  if (cubes.length !== 4) fail(`08 cube count ${cubes.length}`);
  for (const cube of cubes) {
    await clickOccurrence(page, cube.occurrenceId);
    const ids = await highlightedIds(page);
    if (!ids.has(cube.occurrenceId)) fail("08 cube was not highlighted");
    for (const other of cubes) if (other.occurrenceId !== cube.occurrenceId && ids.has(other.occurrenceId)) fail("08 cube highlight leaked");
  }
  const rotatedLeaf = cubes[0];
  await page.getByRole("button", { name: "Fit all" }).click();
  await clickMesh(page, rotatedLeaf.occurrenceId);
  const rotatedHighlight = await highlightedIds(page);
  const otherLeaves = rotated.report.nodes.filter((node) => !node.isAssembly && node.occurrenceId !== rotatedLeaf.occurrenceId);
  if (!rotatedHighlight.has(rotatedLeaf.occurrenceId)) fail("08 selection missed the clicked cube");
  for (const other of otherLeaves) if (rotatedHighlight.has(other.occurrenceId)) fail("08 selection highlighted another cube");
  await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-viewer-08.png"), [root], "08 viewer"), fullPage: true });
  downloads["08-rotated-nested.step"] = await exportStep("08-rotated-nested.step");
  fcadDownloads["08-rotated-nested.step"] = await saveImported("08-rotated-nested.fcad");
  const writeSession = await sessionOf();
  await endSession();

  const rereads = {};
  let readSession = 0;
  for (const name of files) {
    const result = await readFile(downloads[name]);
    if (!readSession) readSession = result.session;
    rereads[name] = result.report;
    const label = name.startsWith("05") ? "05-reread.step" : name;
    for (const message of expectRead(label, result.report)) fail(`browser reread ${name}: ${message}`);
    for (const message of compareReports(originals.get(name), result.report, `browser ${name}`)) fail(message);
  }
  const rotatedAgain = await readFile(downloads["08-rotated-nested.step"]);
  for (const message of expectRotation(rotatedAgain.report, rotatedExpected)) fail(`browser 08 reread: ${message}`);
  for (const message of compareReports(rotated.report, rotatedAgain.report, "browser 08")) fail(message);
  if (!(readSession > writeSession)) fail(`reread stayed in session ${readSession}`);
  await endSession();

  const shiftedSource = await readFile(join(canonical, "02-flat-assembly.step"));
  await page.getByRole("button", { name: "Shift Pin +5 mm" }).click();
  await page.locator("#xde-report").waitFor({ state: "visible", timeout: 180000 });
  const shifted = await reportOf();
  for (const message of expectShift(shifted)) fail(`browser shift: ${message}`);
  const shiftedFcad = await saveImported("02-pin-plus-5mm.fcad");
  const shiftedPath = await exportStep("02-pin-plus-5mm.step");
  const shiftSession = await sessionOf();
  await endSession();
  const shiftedAgain = await readFile(shiftedPath);
  if (!(shiftedAgain.session > shiftSession)) fail("shifted reread did not start a new session");
  for (const message of expectShift(shiftedAgain.report)) fail(`browser shifted reread: ${message}`);
  for (const message of compareReports(shifted, shiftedAgain.report, "browser shift")) fail(message);
  await endSession();
  const shiftedFcadRead = await readFile(shiftedFcad);
  for (const message of expectShift(shiftedFcadRead.report)) fail(`browser shift fcad: ${message}`);
  if ((await page.locator("main").getAttribute("data-xde-scene-bind")) !== "match") fail("shifted FCAD stored scene did not match its STEP");
  if (!(await page.locator("body").innerText()).includes("This WASM re-checked")) fail("shifted FCAD did not say this WASM re-checked the stored scene");
  await endSession();

  for (const name of [...files, "08-rotated-nested.step"]) {
    const opened = await readFile(fcadDownloads[name]);
    if (name.startsWith("08")) {
      for (const message of expectRotation(opened.report, rotatedExpected)) fail(`browser fcad 08: ${message}`);
      for (const message of compareReports(rotated.report, opened.report, "browser fcad 08")) fail(message);
    } else {
      for (const message of expectRead(name, opened.report)) fail(`browser fcad ${name}: ${message}`);
      for (const message of compareReports(originals.get(name), opened.report, `browser fcad ${name}`)) fail(message);
    }
    if ((await page.locator("main").getAttribute("data-xde-scene-bind")) !== "match") fail(`${name} FCAD was not bound to its embedded STEP`);
    if ((await page.locator("main").getAttribute("data-xde-scene")) !== "ready") fail(`${name} FCAD scene was not ready`);
    const note = await page.locator("body").innerText();
    if (!note.includes("stored scene was not used") || !note.includes("This WASM re-checked") || !note.includes("Original FerriteCAD did not check")) {
      fail(`${name} FCAD did not describe the stored scene as a WASM re-check`);
    }
    await endSession();
  }

  const fcad = await readFile(join(root, "fixtures/original-assembly.fcad"));
  for (const message of expectRead("02-flat-assembly.step", fcad.report)) fail(`browser fcad: ${message}`);
  for (const message of compareReports(originals.get("02-flat-assembly.step"), fcad.report, "browser fcad")) fail(message);
  const metaText = await page.locator("body").innerText();
  if (!metaText.includes("23528") || !metaText.includes("02-flat-assembly.step") || !metaText.includes("This WASM re-checked")) {
    fail("browser did not show the embedded source length, name and hash");
  }
  if (!metaText.includes("stored scene was not used") && !metaText.includes("The stored scene was not used")) {
    fail("browser did not say the stored scene was unused");
  }
  if ((await page.locator("main").getAttribute("data-xde-scene-bind")) !== "match") fail("original assembly stored scene did not match");
  await endSession();

  const badPlacement = join(root, "artifacts/xde/probes/bad-placement.fcad");
  await page.locator("#xde-file").setInputFiles(badPlacement);
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.locator("#xde-report").waitFor({ state: "visible", timeout: 180000 });
  if ((await page.locator("main").getAttribute("data-xde-scene-bind")) !== "mismatch") fail("wrong placement was confirmed");
  if ((await page.locator("main").getAttribute("data-xde-scene")) !== "blocked") fail("wrong placement was a ready scene");
  if ((await page.locator("[data-xde-save]").getAttribute("data-xde-save")) !== "no") fail("wrong placement enabled save");
  const placementError = (await page.locator("[data-xde-error]").innerText()).trim();
  if (!/placement/.test(placementError)) fail(`placement probe said ${placementError}`);
  if ((await page.locator("[data-xde-canvas]").count()) === 0) fail("placement probe hid the viewer");
  await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-bad-placement.png"), [root], "bad placement"), fullPage: true });
  await endSession();

  const badPath = join(browserDir, "damaged.step");
  writeFileSync(badPath, "this is not a STEP file\n");
  await page.locator("#xde-file").setInputFiles(badPath);
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.waitForFunction(() => {
    const node = document.querySelector("[data-xde-error]");
    return Boolean(node && node.textContent && node.textContent.trim().length > 0);
  }, null, { timeout: 180000 });
  const damaged = await page.locator("[data-xde-error]").innerText();
  if (!damaged.trim()) fail("damaged STEP produced no error");
  await endSession();
  const recovered = await readFile(join(canonical, "01-single-part.step"));
  for (const message of expectRead("01-single-part.step", recovered.report)) fail(`browser recover: ${message}`);

  await page.goto(home, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByRole("button", { name: "File", exact: true }).waitFor({ timeout: 60000 });
  const after = await page.evaluate(() => window.__fcadDebug?.snapshot?.() ?? null);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail("the open Ferrite document changed during the XDE session");

  await page.locator("[data-open-fcad]").setInputFiles(join(root, "fixtures/original-plate.fcad"));
  await waitVolume(page, 24000);
  const height = page.locator("[data-exchange-height]");
  await height.fill("16");
  await height.press("Enter");
  await waitVolume(page, 38400);
  const dirty = await page.evaluate(() => window.__fcadDebug.snapshot());
  if (!dirty?.dirty || Math.abs(Number(dirty.volume) - 38400) > 0.001) fail("plate was not dirty at 16 mm");
  await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-dirty-plate.png"), [root], "dirty plate"), fullPage: true });
  await page.getByRole("link", { name: "Assemblies" }).click();
  await page.getByRole("button", { name: "Read", exact: true }).waitFor();
  const reloadDialogs = [];
  const onReloadDialog = (dialog) => {
    reloadDialogs.push(dialog.type());
    return dialog.dismiss();
  };
  page.on("dialog", onReloadDialog);
  let reloadLeft = false;
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 8000 });
    reloadLeft = true;
  } catch {
    reloadLeft = false;
  }
  page.off("dialog", onReloadDialog);
  if (!reloadDialogs.includes("beforeunload")) fail(`dirty reload did not warn (${reloadDialogs.join(",") || "no dialog"})`);
  if (reloadLeft) fail("cancelling the reload still left the page");
  await page.getByRole("link", { name: "Ferrite" }).click();
  await page.getByRole("button", { name: "File", exact: true }).waitFor({ timeout: 60000 });
  await waitVolume(page, 38400);
  await page.getByRole("link", { name: "Assemblies" }).click();
  await page.getByRole("button", { name: "Read", exact: true }).waitFor();
  await page.getByRole("link", { name: "Ferrite" }).click();
  await waitVolume(page, 38400);

  await page.getByRole("link", { name: "Assemblies" }).click();
  await page.locator("#xde-file").setInputFiles(join(canonical, "02-flat-assembly.step"));
  await Promise.all([
    page.locator("main[data-xde-state='working']").waitFor({ timeout: 15000 }),
    page.getByRole("button", { name: "Read", exact: true }).click(),
  ]);
  const workerDeadline = Date.now() + 20000;
  while (xdeWorkerCount(page) === 0 && (await page.locator("main").getAttribute("data-xde-state")) === "working" && Date.now() < workerDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if ((await page.locator("main").getAttribute("data-xde-state")) !== "working") fail("Read finished before Cancel could stop a live worker");
  if (xdeWorkerCount(page) === 0) fail("Cancel ran before an XDE worker existed");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("data-xde-state") !== "working", null, { timeout: 15000 });
  const deadline = Date.now() + 5000;
  while (xdeWorkerCount(page) !== 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (xdeWorkerCount(page) !== 0) fail(`cancel left ${xdeWorkerCount(page)} XDE workers`);

  await page.locator("#xde-file").setInputFiles(join(canonical, "02-flat-assembly.step"));
  await Promise.all([
    page.locator("main[data-xde-state='working']").waitFor({ timeout: 15000 }),
    page.getByRole("button", { name: "Read", exact: true }).click(),
  ]);
  await page.getByRole("link", { name: "Ferrite" }).click();
  await page.getByRole("button", { name: "File", exact: true }).waitFor({ timeout: 60000 });
  const leftEarly = Date.now() + 5000;
  while (xdeWorkerCount(page) !== 0 && Date.now() < leftEarly) await new Promise((resolve) => setTimeout(resolve, 100));
  if (xdeWorkerCount(page) !== 0) fail("leaving during Read left an XDE worker");
  await waitVolume(page, 38400);
  await page.getByRole("link", { name: "Assemblies" }).click();
  await page.getByRole("button", { name: "Read", exact: true }).waitFor();

  const afterCancel = await readFile(join(canonical, "02-flat-assembly.step"));
  for (const message of expectRead("02-flat-assembly.step", afterCancel.report)) fail(`read after cancel: ${message}`);
  const temporary = await page.locator("main").getAttribute("data-xde-temporary");
  if (temporary !== "0") fail(`temporary files after read ${temporary}`);
  await exportStep("after-cancel.step");
  await page.getByRole("link", { name: "Ferrite" }).click();
  await page.getByRole("button", { name: "File", exact: true }).waitFor({ timeout: 60000 });
  const leftDeadline = Date.now() + 5000;
  while (xdeWorkerCount(page) !== 0 && Date.now() < leftDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (xdeWorkerCount(page) !== 0) fail("leaving Assemblies left an XDE worker");
  await waitVolume(page, 38400);

  await page.getByRole("link", { name: "Assemblies" }).click();
  await page.getByRole("button", { name: "Read", exact: true }).waitFor();
  const typeDir = join(root, "test-data/scene-type-probes");
  const typeRefused = [];
  for (const name of ["placement-string", "placement-bool", "placement-null", "placement-integer", "colour-null", "solids-string", "solids-float", "importer-null", "diagnostics-string"]) {
    const previous = await page.locator("main").getAttribute("data-xde-attempt");
    await page.locator("#xde-file").setInputFiles(join(typeDir, `${name}.fcad`));
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await page.waitForFunction((prev) => {
      const main = document.querySelector("main");
      const message = document.querySelector("[data-xde-error]")?.textContent?.trim() ?? "";
      return main?.getAttribute("data-xde-state") === "error" && main.getAttribute("data-xde-attempt") !== prev && message.length > 0;
    }, previous, { timeout: 30000 });
    if (await page.locator("#xde-report").count()) fail(`${name} published an XDE report`);
    if (await page.locator("[data-xde-canvas]").count()) fail(`${name} published a 3D scene`);
    if ((await page.locator("[data-xde-save]").getAttribute("data-xde-save")) !== "no") fail(`${name} enabled save`);
    const message = (await page.locator("[data-xde-error]").innerText()).trim();
    if (/This WASM re-checked|sourceLinkOk/i.test(message)) fail(`${name} confirmed a source (${message})`);
    const status = ((await page.locator("[data-xde-status]").textContent()) ?? "").trim();
    if (status.includes(name) || status.includes(".fcad")) fail(`${name} was labeled as open (${status})`);
    typeRefused.push({ name, message });
    if (name === "placement-string") {
      await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-type-refused.png"), [root], "type refused"), fullPage: true });
    }
  }
  for (const name of ["positive-control", "positive-float32-placement", "missing-root-parent"]) {
    const opened = await readFile(join(typeDir, `${name}.fcad`));
    if (!opened.report?.nodes?.length) fail(`${name} did not read geometry`);
    if ((await page.locator("main").getAttribute("data-xde-scene-bind")) !== "match") fail(`${name} was not confirmed by a fresh STEP reading`);
    const note = await page.locator("body").innerText();
    if (!note.includes("This WASM re-checked") || !note.includes("Original FerriteCAD did not check")) fail(`${name} claimed an original FerriteCAD check`);
    if (name === "positive-control") {
      await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-type-positive.png"), [root], "type positive"), fullPage: true });
      const saved = await saveImported("positive-control-saved.fcad");
      if (Buffer.compare(readFileSync(join(typeDir, `${name}.fcad`)), readFileSync(saved)) !== 0) fail("positive control save replaced the original bytes");
    }
    await endSession();
  }
  const wireDir = join(root, "test-data/wire-probes");
  const wireRefused = [];
  for (const name of ["importer-id-nel", "importer-version-nel"]) {
    const previous = await page.locator("main").getAttribute("data-xde-attempt");
    await page.locator("#xde-file").setInputFiles(join(wireDir, `${name}.fcad`));
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await page.waitForFunction((prev) => {
      const main = document.querySelector("main");
      const message = document.querySelector("[data-xde-error]")?.textContent?.trim() ?? "";
      return main?.getAttribute("data-xde-state") === "error" && main.getAttribute("data-xde-attempt") !== prev && message.length > 0;
    }, previous, { timeout: 30000 });
    if (await page.locator("#xde-report").count()) fail(`${name} published an XDE report`);
    if (await page.locator("[data-xde-canvas]").count()) fail(`${name} published a 3D scene`);
    if ((await page.locator("[data-xde-save]").getAttribute("data-xde-save")) !== "no") fail(`${name} enabled save`);
    const message = (await page.locator("[data-xde-error]").innerText()).trim();
    if (!/imported_by\.(id|version) is empty/.test(message)) fail(`${name} did not use the Rust emptiness rule (${message})`);
    if (/This WASM re-checked|sourceLinkOk/i.test(message)) fail(`${name} confirmed a source (${message})`);
    const status = ((await page.locator("[data-xde-status]").textContent()) ?? "").trim();
    if (status.includes(name) || status.includes(".fcad")) fail(`${name} was labeled as open (${status})`);
    wireRefused.push({ name, message });
    if (name === "importer-id-nel") {
      await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-nel-refused.png"), [root], "nel refused"), fullPage: true });
    }
  }
  const wireAccepted = [];
  for (const name of ["importer-id-bom", "importer-version-bom", "solids-wide-uint", "source-length-wide-uint", "unknown-numeric-map"]) {
    const opened = await readFile(join(wireDir, `${name}.fcad`));
    if (!opened.report?.nodes?.length) fail(`${name} did not read geometry`);
    if ((await page.locator("main").getAttribute("data-xde-scene-bind")) !== "match") fail(`${name} was not confirmed by a fresh STEP reading`);
    const note = await page.locator("body").innerText();
    if (!note.includes("This WASM re-checked") || !note.includes("Original FerriteCAD did not check")) fail(`${name} claimed an original FerriteCAD check`);
    const saved = await saveImported(`${name}-saved.fcad`);
    if (Buffer.compare(readFileSync(join(wireDir, `${name}.fcad`)), readFileSync(saved)) !== 0) fail(`${name} save replaced the original bytes`);
    wireAccepted.push({ name, bytes: readFileSync(saved).byteLength });
    if (name === "solids-wide-uint") {
      await page.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-wire-positive.png"), [root], "wire positive"), fullPage: true });
    }
    await endSession();
  }
  await page.getByRole("link", { name: "Ferrite" }).click();
  await page.getByRole("button", { name: "File", exact: true }).waitFor({ timeout: 60000 });
  await waitVolume(page, 38400);

  await page.getByRole("button", { name: "File", exact: true }).click();
  const [fcadDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.getByRole("button", { name: "Save .fcad", exact: true }).click(),
  ]);
  const fcadOut = join(browserDir, "plate-h16.fcad");
  await fcadDownload.saveAs(fcadOut);
  await page.getByRole("button", { name: "File", exact: true }).click();
  const [stepDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 180000 }),
    page.getByRole("button", { name: "Export STEP", exact: true }).click(),
  ]);
  const stepOut = join(browserDir, "plate-h16.step");
  await stepDownload.saveAs(stepOut);
  const checkPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  checkPage.on("pageerror", (error) => logs.push({ type: "pageerror", text: String(error) }));
  await checkPage.goto(home, { waitUntil: "domcontentloaded", timeout: 120000 });
  await checkPage.locator("[data-open-step]").setInputFiles(stepOut);
  await waitVolume(checkPage, 38400);
  await checkPage.locator("[data-open-fcad]").setInputFiles(fcadOut);
  await waitVolume(checkPage, 38400);
  await checkPage.close();
  await waitVolume(page, 38400);
  await page.getByRole("link", { name: "Assemblies" }).click();
  await page.getByRole("button", { name: "Read", exact: true }).waitFor();
  const plateAttempt = await page.locator("main").getAttribute("data-xde-attempt");
  await page.locator("#xde-file").setInputFiles(join(root, "test-data/import-capabilities/unknown-import-capability.fcad"));
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.waitForFunction((prev) => {
    const main = document.querySelector("main");
    return main?.getAttribute("data-xde-state") === "error" && main.getAttribute("data-xde-attempt") !== prev;
  }, plateAttempt, { timeout: 30000 });
  if (await page.locator("#xde-report").count()) fail("unsupported FCAD kept an assembly report");
  await page.getByRole("link", { name: "Ferrite" }).click();
  await page.getByRole("button", { name: "File", exact: true }).waitFor({ timeout: 60000 });
  await waitVolume(page, 38400);

  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: "Close Document", exact: true }).click();
  await page.locator("[data-document-gate]").waitFor({ timeout: 15000 });
  await page.locator("[data-gate-action='discard']").click();
  await page.waitForFunction(() => !document.querySelector("[data-exchange-volume]"), null, { timeout: 30000 });
  await page.getByRole("link", { name: "Assemblies" }).click();
  let falseAlarm = false;
  const onCleanDialog = (dialog) => {
    falseAlarm = true;
    return dialog.dismiss();
  };
  page.on("dialog", onCleanDialog);
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  } catch (error) {
    if (falseAlarm) fail("closed document still warned on reload");
    throw error;
  } finally {
    page.off("dialog", onCleanDialog);
  }
  if (falseAlarm) fail("closed document still warned on reload");

  const corruptPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const corruptWasm = [];
  corruptPage.on("pageerror", (error) => logs.push({ type: "pageerror", text: String(error) }));
  corruptPage.on("response", (response) => {
    if (response.url().includes("opencascade_full")) corruptWasm.push(response.url());
  });
  await corruptPage.goto(new URL("/xde", url).toString(), { waitUntil: "domcontentloaded", timeout: 120000 });
  const probeFiles = [
    ["test-data/import-capabilities/unknown-object-schema.fcad", "opaque"],
    ["test-data/import-capabilities/unknown-import-capability.fcad", "opaque"],
    ["test-data/import-capabilities/unknown-capability-bad-source.fcad", "opaque"],
    ["test-data/import-capabilities/known-schema-bad-source.fcad", "invalid"],
    ["test-data/import-integrity/source-hash-mismatch.fcad", "invalid"],
    ["test-data/import-integrity/source-length-mismatch.fcad", "invalid"],
    ["test-data/import-integrity/object-payload-hash-mismatch.fcad", "invalid"],
    ["test-data/import-integrity/source-ref-mismatch.fcad", "invalid"],
    ["test-data/import-integrity/wrong-application-id.fcad", "invalid"],
  ];
  const rejected = [];
  for (const [relative, kind] of probeFiles) {
    const name = relative.split("/").pop();
    const previousAttempt = await corruptPage.locator("main").getAttribute("data-xde-attempt");
    await corruptPage.locator("#xde-file").setInputFiles(join(root, relative));
    await corruptPage.getByRole("button", { name: "Read", exact: true }).click();
    await corruptPage.waitForFunction((prev) => {
      const state = document.querySelector("main")?.getAttribute("data-xde-state");
      const attempt = document.querySelector("main")?.getAttribute("data-xde-attempt");
      const message = document.querySelector("[data-xde-error]")?.textContent?.trim() ?? "";
      return state === "error" && attempt !== prev.attempt && message.length > 0;
    }, { attempt: previousAttempt }, { timeout: 30000 });
    const message = (await corruptPage.locator("[data-xde-error]").innerText()).trim();
    if (!message) fail(`${name} produced no error`);
    if (/matches|sourceLinkOk|23528|25963/.test(message)) fail(`${name} confirmed an embedded STEP (${message})`);
    if (kind === "invalid" && name.startsWith("known-schema") && !/payload source does not match/.test(message)) {
      fail(`${name} was not reported as a bad source link (${message})`);
    }
    if (kind === "opaque" && /payload source does not match|invalid/.test(message)) fail(`${name} was treated as invalid (${message})`);
    if (await corruptPage.locator("#xde-report").count()) fail(`${name} published an XDE report`);
    if (await corruptPage.locator("[data-xde-canvas]").count()) fail(`${name} published a 3D scene`);
    const shownName = ((await corruptPage.locator("[data-xde-status]").textContent()) ?? "").trim();
    if (shownName.includes(name) || shownName.includes(".fcad")) fail(`${name} was labeled as a successful file (${shownName})`);
    rejected.push({ name, kind, message });
    if (name === "object-payload-hash-mismatch.fcad") {
      await corruptPage.screenshot({ path: checkedOutputPath(join(root, "screenshots/xde-corrupt-rejected.png"), [root], "corrupt fcad"), fullPage: true });
    }
  }
  if (corruptWasm.length) fail(`corrupt FCAD loaded the XDE wasm (${corruptWasm.length} responses)`);
  await corruptPage.locator("#xde-file").setInputFiles(join(root, "fixtures/original-assembly.fcad"));
  await corruptPage.getByRole("button", { name: "Read", exact: true }).click();
  await corruptPage.locator("#xde-report").waitFor({ state: "visible", timeout: 180000 });
  const positive = JSON.parse(await corruptPage.locator("#xde-report").innerText());
  for (const message of expectRead("02-flat-assembly.step", positive)) fail(`positive fcad after probes: ${message}`);
  const positiveText = await corruptPage.locator("body").innerText();
  if (!positiveText.includes("23528") || !positiveText.includes("This WASM re-checked") || !positiveText.includes("02-flat-assembly.step")) {
    fail("positive embedded source was not confirmed");
  }
  const coveredAttempt = await corruptPage.locator("main").getAttribute("data-xde-attempt");
  await corruptPage.locator("#xde-file").setInputFiles(join(root, "test-data/import-capabilities/unknown-object-schema.fcad"));
  await corruptPage.getByRole("button", { name: "Read", exact: true }).click();
  await corruptPage.waitForFunction((prev) => {
    const main = document.querySelector("main");
    return main?.getAttribute("data-xde-state") === "error" && main.getAttribute("data-xde-attempt") !== prev;
  }, coveredAttempt, { timeout: 30000 });
  if (await corruptPage.locator("#xde-report").count()) fail("unknown schema kept the previous assembly report");
  if (await corruptPage.locator("[data-xde-canvas]").count()) fail("unknown schema kept the previous 3D scene");
  const coveredName = ((await corruptPage.locator("[data-xde-status]").textContent()) ?? "").trim();
  if (coveredName.includes("unknown-object-schema") || coveredName.includes("original-assembly")) {
    fail(`unknown schema was labeled with a file name (${coveredName})`);
  }
  await corruptPage.close();

  const memory = await page.evaluate(() => {
    const heap = performance.memory;
    return heap ? { usedJSHeapSize: heap.usedJSHeapSize, totalJSHeapSize: heap.totalJSHeapSize } : null;
  });
  const xdeWasm = wasm.filter((item) => item.url.includes("opencascade_full"));
  if (!xdeWasm.some((item) => item.contentType.includes("application/wasm"))) fail(`wasm content-type ${JSON.stringify(xdeWasm)}`);
  const fixtureHits = requests.filter((item) => item.includes("/fixtures/"));
  if (fixtureHits.length) fail(`page requested fixtures: ${fixtureHits.join(", ")}`);
  const pageErrors = logs.filter((item) => item.type === "pageerror");
  if (pageErrors.length) fail(`pageerror ${pageErrors.map((item) => item.text).join(" | ")}`);

  const summary = {
    ok: errors.length === 0,
    errors,
    homeUnchanged: true,
    dirtyPlate: { volume: 38400, reloadCancelled: true, exports: { fcad: fcadOut, step: stepOut } },
    corruptRejected: rejected,
    typeRefused,
    wireRefused,
    wireAccepted,
    sessions: { write: writeSession, reread: readSession, shifted: shiftedAgain.session },
    downloads,
    wasm: xdeWasm,
    memory,
    console: logs.filter((item) => item.type === "error" || item.type === "pageerror"),
    sample: { file: "02-flat-assembly.step", nodes: shiftedSource.report.nodes.map((node) => node.path) },
  };
  writeFileSync(outDir, JSON.stringify(summary, null, 2));
  writeFileSync(join(browserDir, "console.json"), JSON.stringify(logs, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, errors, wasm: xdeWasm, memory, sessions: summary.sessions }, null, 2));
  if (!summary.ok) process.exitCode = 1;
} finally {
  await browser.close();
}
