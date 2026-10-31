import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Hash the build inputs, not a review label or the native compatibility basis.
export function createBuildInfo(root) {
  const files = [];
  function visit(path) {
    if (!existsSync(join(root, path))) return;
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const relative = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile() && relative !== "src/routeTree.gen.ts") files.push(relative);
    }
  }
  for (const directory of ["src", "scripts", "public"]) visit(directory);
  for (const path of ["package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "vercel.json"]) {
    if (existsSync(join(root, path))) files.push(path);
  }
  const hash = createHash("sha256");
  for (const path of files.sort()) {
    const data = readFileSync(join(root, path));
    hash.update(`${path}\0${data.length}\0`).update(data);
  }
  const sourceHash = hash.digest("hex");
  const source = readFileSync(join(root, "src/occt/fcad-current.ts"), "utf8");
  const nativeBasis = source.match(/CURRENT_BASIS\s*=\s*"current native main ([a-f0-9]{40})"/)?.[1];
  if (!nativeBasis) throw new Error("Missing native compatibility basis");
  return { buildId: `web-${sourceHash.slice(0, 16)}`, sourceHash, nativeBasis };
}

export function buildInfoPlugin(root) {
  const info = createBuildInfo(root);
  return {
    name: "ferrite:build-info",
    config: () => ({ define: { __BUILD_INFO__: JSON.stringify(info) } }),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify(info, null, 2) + "\n" });
    },
  };
}
