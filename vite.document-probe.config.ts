import { join } from "node:path";
import { defineConfig } from "vite";

/**
 * The document probe is its own page, not a route of the CAD app: the TanStack
 * Start build accepts a single client entry, and this page must not be reachable
 * from (or load anything for) the CAD route. `npm run build` runs this after
 * the app build, into the app's static output beside the committed kernel files
 * at /document-probe/kernel/, which the app build copies from public/ untouched.
 */
const repository = process.cwd();

export default defineConfig(({ command }) => ({
  root: join(repository, "src/document-probe"),
  base: "/document-probe/",
  // The kernel is addressed by its stable URL, so the dev server must offer it there too.
  publicDir: command === "serve" ? join(repository, "public/document-probe") : false,
  resolve: { tsconfigPaths: true },
  // The Worker keeps the stable URL /document-probe/worker.mjs, like the kernel files beside it.
  worker: { format: "es", rolldownOptions: { output: { entryFileNames: "worker.mjs" } } },
  server: {
    host: "127.0.0.1",
    port: 8082,
    strictPort: true,
    fs: { allow: [repository] },
  },
  build: {
    outDir: join(repository, ".vercel/output/static/document-probe"),
    // The app build owns kernel/ in this directory; only the probe's own files are written.
    emptyOutDir: false,
    target: "es2022",
  },
}));
