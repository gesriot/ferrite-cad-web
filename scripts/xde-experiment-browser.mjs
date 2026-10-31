/**
 * Production UI for the experimental placement mode.
 * Standard complex-native stays unconfirmed. The experiment is a separate Read.
 *
 *   node scripts/xde-experiment-browser.mjs http://127.0.0.1:8081/
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = checkedUrl(process.argv[2] || "http://127.0.0.1:8081/");
const outDir = join(root, "artifacts/xde/browser");
mkdirSync(outDir, { recursive: true });
const reportPath = checkedOutputPath(join(outDir, "experimental-placement.json"), [root], "experimental placement report");

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const logs = [];
const homeRequests = [];
page.on("pageerror", (error) => logs.push(String(error)));
page.on("request", (request) => {
  if (page.url().includes("/xde")) return;
  homeRequests.push(request.url());
});
const failures = [];
try {
  await page.goto(new URL("/", url).toString(), { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByText("Ferrite").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  const homeWasm = homeRequests.filter((item) => /opencascade_full|placement-oracle|placement-math|xde\.worker/i.test(item));
  if (homeWasm.length) failures.push(`home requested XDE or oracle data: ${homeWasm.join(", ")}`);

  await page.goto(new URL("/xde", url).toString(), { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByRole("button", { name: "Read", exact: true }).waitFor({ timeout: 60000 });
  if ((await page.locator("main").getAttribute("data-xde-experiment")) !== "off") failures.push("experiment was on before the user chose it");
  if (await page.getByRole("checkbox", { name: "Experimental placement compatibility" }).isChecked()) failures.push("experiment checkbox was checked by default");

  await page.locator("#xde-file").setInputFiles(join(root, "test-data/complex/complex-native.fcad"));
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.waitForFunction(() => {
    const main = document.querySelector("main");
    return main?.getAttribute("data-xde-state") === "ready" && main.getAttribute("data-xde-scene-bind") !== "none";
  }, null, { timeout: 180000 });
  const standardBind = await page.locator("main").getAttribute("data-xde-scene-bind");
  const standardSave = await page.locator("[data-xde-save]").getAttribute("data-xde-save");
  const standardBody = await page.locator("body").innerText();
  if (standardBind !== "mismatch" || standardSave !== "no") failures.push(`standard complex-native was ${standardBind} save ${standardSave}`);
  if (!standardBody.includes("does not match")) failures.push("standard complex-native did not show the mismatch sentence");
  if (standardBody.includes("the stored scene matches that reading")) failures.push("standard complex-native showed the match sentence");

  await page.getByRole("checkbox", { name: "Experimental placement compatibility" }).check();
  if ((await page.locator("main").getAttribute("data-xde-experiment")) !== "on") failures.push("checking the box did not mark the next read");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.waitForFunction(() => {
    const main = document.querySelector("main");
    return main?.getAttribute("data-xde-state") === "ready" && main.getAttribute("data-xde-opened-experiment") === "on";
  }, null, { timeout: 180000 });
  const experimentalBind = await page.locator("main").getAttribute("data-xde-scene-bind");
  const experimentalSave = await page.locator("[data-xde-save]").getAttribute("data-xde-save");
  const experimentalBody = await page.locator("body").innerText();
  if (experimentalBind !== "match" || experimentalSave !== "yes") failures.push(`experimental complex-native was ${experimentalBind} save ${experimentalSave}`);
  if (!experimentalBody.includes("the stored scene matches that reading")) failures.push("experimental complex-native did not show the match sentence");
  if (!experimentalBody.includes("Experimental placement compatibility installed rigid locations")) failures.push("experimental note was not shown");
  if (await page.getByRole("button", { name: "Shift Pin +5 mm" }).isEnabled()) failures.push("shift stayed enabled during the experiment");
  const invalidText = await page.locator("[data-xde-scene-diagnostics]").innerText().catch(() => "");
  const invalidReport = await page.locator("#xde-report").innerText();
  if (!invalidText.includes("step.product_definition#2583")) failures.push(`experimental diagnostics did not name step.product_definition#2583: ${invalidText}`);
  if (!/"invalidSolids":[1-9]/.test(invalidReport)) failures.push("experimental report showed no invalid solids");

  const [reopenDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 180000 }),
    page.getByRole("button", { name: "Save imported FCAD" }).click(),
  ]);
  const reopenName = reopenDownload.suggestedFilename();
  const reopenPath = join(outDir, reopenName);
  await reopenDownload.saveAs(reopenPath);
  await page.locator("main[data-xde-state='ready']").waitFor({ timeout: 180000 });

  const [exportDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 180000 }),
    page.getByRole("button", { name: "Export STEP" }).click(),
  ]);
  const exportName = exportDownload.suggestedFilename();
  const exportPath = join(outDir, exportName);
  await exportDownload.saveAs(exportPath);
  if (reopenName === exportName) failures.push("reopen FCAD and STEP export used the same file name");
  if (!reopenName.endsWith("-experimental-reopen.fcad")) failures.push(`reopen name was ${reopenName}`);
  if (!exportName.endsWith("-experimental-export.step")) failures.push(`export name was ${exportName}`);

  await page.getByRole("button", { name: "End session" }).click();
  await page.locator("#xde-file").setInputFiles(join(root, "test-data/writer-goldens/sources/02-flat-assembly.step"));
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("data-xde-state") === "ready", null, { timeout: 180000 });
  const [importDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 180000 }),
    page.getByRole("button", { name: "Save imported FCAD" }).click(),
  ]);
  const importName = importDownload.suggestedFilename();
  const importPath = join(outDir, importName);
  await importDownload.saveAs(importPath);
  if (!importName.endsWith("-experimental-import.fcad")) failures.push(`import name was ${importName}`);
  if (importName === reopenName) failures.push("import and reopen downloads were not separable");

  const report = {
    homeRequests: homeRequests.length,
    homeBlocked: homeWasm,
    standard: { bind: standardBind, save: standardSave },
    experimental: { bind: experimentalBind, save: experimentalSave },
    downloads: {
      import: { name: importName, sha256: sha256(importPath), bytes: readFileSync(importPath).byteLength },
      reopen: { name: reopenName, sha256: sha256(reopenPath), bytes: readFileSync(reopenPath).byteLength },
      step: { name: exportName, sha256: sha256(exportPath), bytes: readFileSync(exportPath).byteLength },
    },
    pageErrors: logs,
    failures,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length || logs.length) process.exitCode = 1;
} finally {
  await browser.close();
}
