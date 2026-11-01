import { existsSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { buildInfoPlugin } from "./scripts/build-info.mjs";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
/** Serve production .wasm with the MIME type instantiateStreaming requires. */
function wasmMimePreviewPlugin(): Plugin {
  return {
    name: "ferrite:wasm-mime-preview",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathOnly = (req.url ?? "").split("?")[0] ?? "";
        if (!pathOnly.endsWith(".wasm")) {
          next();
          return;
        }
        const file = join(server.config.root, ".vercel/output/static", pathOnly);
        if (!existsSync(file)) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/wasm");
        res.setHeader("Cache-Control", pathOnly.startsWith("/document-probe/")
          ? "public, max-age=0, must-revalidate"
          : "public, max-age=31536000, immutable");
        createReadStream(file).pipe(res);
      });
    },
  };
}

/** Header-only Vercel route. srvx's static map has no .wasm type; the CDN route does. */
function wasmMimeDeployPlugin(): Plugin {
  return {
    name: "ferrite:wasm-mime-deploy",
    enforce: "post",
    closeBundle() {
      const configPath = join(process.cwd(), ".vercel/output/config.json");
      if (!existsSync(configPath)) return;
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { routes?: { src?: string; handle?: string }[] };
      const src = "/assets/(.*\\.wasm)";
      const route = {
        src,
        headers: {
          "content-type": "application/wasm",
          "cache-control": "public, max-age=31536000, immutable",
        },
      };
      const routes = (config.routes ?? []).filter((item) => item.src !== src);
      routes.unshift(route);
      config.routes = routes;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    },
  };
}

export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    buildInfoPlugin(process.cwd()),
    // Before nitro so a .wasm request is answered before srvx's octet-stream static handler.
    wasmMimePreviewPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset: "vercel",
          }),
          wasmMimeDeployPlugin(),
        ]
      : []),
    viteReact(),
  ],
}));
