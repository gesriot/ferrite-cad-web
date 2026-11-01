import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(
  process.env.DOCUMENT_WASM_OUTPUT ?? resolve(root, "public/document-probe/kernel"),
);
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(root, "wasm/document/target"));
const rust = "1.96.0";
const emsdk = "4.0.23";
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
const emcc = run("emcc", ["--version"]);
if (!emcc.split("\n")[0].includes(` ${emsdk} `))
  throw new Error(`Activate emsdk ${emsdk} before building: ${emcc}`);
const flags = [
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=web,worker,node",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sEXPORTED_RUNTIME_METHODS=HEAPU8",
  "-sEXPORTED_FUNCTIONS=_fcad_open,_fcad_set_expression,_malloc,_free,_main",
  "-sNO_EXIT_RUNTIME=1",
];
const cargoHome = resolve(process.env.CARGO_HOME ?? resolve(homedir(), ".cargo"));
const sysroot = run("rustc", [`+${rust}`, "--print", "sysroot"]);
// Keep developer paths and host-triple directory names out of the artifact.
const remaps = [
  `--remap-path-prefix=${root}=/workspace`,
  `--remap-path-prefix=${cargoHome}=/cargo`,
  `--remap-path-prefix=${sysroot}=/rust-toolchain`,
];
execFileSync(
  "cargo",
  [
    `+${rust}`,
    "rustc",
    "--locked",
    "--manifest-path",
    "wasm/document/Cargo.toml",
    "--target",
    "wasm32-unknown-emscripten",
    "--release",
    "--",
    ...flags.flatMap((f) => ["-C", `link-arg=${f}`]),
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_ENCODED_RUSTFLAGS: remaps.join("\x1f") },
  },
);
mkdirSync(out, { recursive: true });
const base = resolve(target, "wasm32-unknown-emscripten/release/ferritecad_document_wasm_probe");
copyFileSync(
  resolve(target, "wasm32-unknown-emscripten/release/ferritecad-document-wasm-probe.js"),
  resolve(out, "document.mjs"),
);
copyFileSync(`${base}.wasm`, resolve(out, "document.wasm"));
chmodSync(resolve(out, "document.wasm"), 0o644);
const files = Object.fromEntries(
  ["document.mjs", "document.wasm"].map((name) => {
    const bytes = readFileSync(resolve(out, name));
    return [
      name,
      {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        gzipBytes: gzipSync(bytes, { level: 9 }).length,
      },
    ];
  }),
);
const manifest = {
  nativeCommit: "1b645299b206f3f87e9d3d9959428d2b245d6219",
  rust,
  rustc: run("rustc", [`+${rust}`, "--version"]),
  emsdk,
  emcc: emcc.split("\n")[0],
  target: "wasm32-unknown-emscripten",
  filesystem: "MEMFS",
  remappedPaths: ["/workspace", "/cargo", "/rust-toolchain"],
  flags,
  files,
};
if (Object.values(files).reduce((sum, f) => sum + f.gzipBytes, 0) > 10 * 1024 * 1024)
  throw new Error("Probe exceeds the 10 MiB gzip stop limit");
writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
