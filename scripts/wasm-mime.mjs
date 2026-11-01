import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const configPath = join(process.cwd(), ".vercel/output/config.json");
if (!existsSync(configPath)) {
  console.error("wasm-mime: .vercel/output/config.json is missing");
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
const src = "/assets/(.*\\.wasm)";
const route = {
  src,
  headers: {
    "content-type": "application/wasm",
    "cache-control": "public, max-age=31536000, immutable",
  },
};
const probe = "/document-probe/kernel/document\\.wasm";
const routes = (config.routes ?? []).filter((item) => item.src !== src && item.src !== probe);
routes.unshift(route);
// This opt-in artifact has a stable filename; it must revalidate after an update.
routes.unshift({
  src: probe,
  headers: {
    "content-type": "application/wasm",
    "cache-control": "public, max-age=0, must-revalidate",
  },
});
config.routes = routes;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wasm-mime: content-type application/wasm for ${src}`);
