import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = checkedUrl(process.argv[2] || process.env.FCAD_URL || "http://127.0.0.1:8081/");
const out = checkedOutputPath(process.argv[3] || resolve(root, "artifacts/format-roundtrip/browser-proof.json"), [root], "proof JSON");
const shot = checkedOutputPath(resolve(root, "artifacts/format-roundtrip/browser.png"), [root], "proof screenshot");
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--enable-precise-memory-info"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on("console", (message) => logs.push({ type: message.type(), text: message.text() }));
page.on("pageerror", (error) => logs.push({ type: "pageerror", text: String(error) }));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.__runOcctProof === "function", null, { timeout: 30000 });
const report = await page.evaluate(async () => window.__runOcctProof());
const canvas = await page.locator("canvas").count();
const memory = await page.evaluate(() => {
  const heap = performance.memory;
  return heap ? { usedJSHeapSize: heap.usedJSHeapSize, totalJSHeapSize: heap.totalJSHeapSize } : null;
});
await page.screenshot({ path: shot });
await browser.close();
const pageErrors = logs.filter((item) => item.type === "pageerror");
const result = {
  ok: report?.ok === true && pageErrors.length === 0,
  canvas,
  memory,
  report,
  pageErrors,
  logs: logs.filter((item) => item.type === "error" || item.type === "pageerror" || /wasm|OCCT|error/i.test(item.text)).slice(0, 40),
};
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, canvas, errors: report?.errors, pageErrors, wasm: report?.wasm, kernel: report?.kernel, plate: report?.plate, plateRaised: report?.plateRaised, plateReread: report?.plateReread }, null, 2));
if (!result.ok) process.exitCode = 1;
