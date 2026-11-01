# Document WASM probe

This opt-in experiment calls the pinned native `ferritecad-document` library.
It does not replace the CAD editor or add a geometry evaluator. The web host
serves the committed WebAssembly module and its glue (`public/document-probe/kernel/`);
`npm run build` never runs Rust. Everything around the module is TypeScript:

| Layer | Where | Owns |
| --- | --- | --- |
| ABI framing | `src/document/abi.ts` | the synchronous C ABI frame; used by the Worker **and** the Node parity harness |
| Worker | `src/document/worker.ts`, `worker-host.ts` | loads the kernel on the first request; one reply per request |
| Transport | `src/document/transport.ts` | `RustDocumentTransport` over a lazily created Worker: request IDs, Worker generation, FIFO queue, finite timeout |
| Session | `src/document/session.ts` | the last accepted revision (bytes, native inspection, name, revision, dirty) and the intent that decides who may publish |
| Browser adapter | `src/document-probe/` | `File`, the 32 MiB bound, Cancel/Discard, Blob download, DOM |

Rust refusals, successful reads with `validation.ok: false`, and transport
failures are three different results. `{"ok": true}` from Rust only says the file
could be read; a revision is accepted only when `validation.ok` is also true.
TypeScript checks the *shape* of a reply and keeps native `kind`, `message` and
diagnostics as they came; FCAD rules, CBOR, SQL, hashes and expression semantics
stay in Rust. A document edit here is `EditChange::constant` +
`Document::write_changes`, not a geometry transaction: nothing is rebuilt, so a
downloaded file has not been checked against its geometry.

Activate emsdk **4.0.23**, install Rust **1.96.0** with target
`wasm32-unknown-emscripten`, then run from the repository root:

```sh
cargo +1.96.0 build --locked --release --manifest-path wasm/document/Cargo.toml
node scripts/build-document-wasm.mjs
node --experimental-strip-types scripts/test-document-wasm.mjs
npm run build
npm run preview -- --host 127.0.0.1 --port 8081
```

`npm run build` builds the CAD app, then the probe page (`vite.document-probe.config.ts`)
into the app's static output beside the kernel files. The TanStack Start build
accepts one client entry, so the probe is a separate Vite build rather than a route.
`npm run dev:document-probe` serves the same page on `http://127.0.0.1:8082/document-probe/`.
`npm run test:document` (part of `npm run check`) runs the transport, session and
adapter tests and drives the committed WASM through the whole new path; it needs
neither Rust nor a native binary.

Open `/document-probe/index.html?enabled=1`. Choose a local FCAD, inspect the
native expression slots, apply a constant, and download the result. Without the
query flag the controls are disabled. The Worker and the kernel are requested
only on the first Open; the CAD route never requests them. End or leaving the page
terminates the Worker. Replacing or ending a document that differs from the opened
file asks Cancel/Discard; downloading does not count as saving. All files are
temporary MEMFS files; nothing is persisted to OPFS or sent to a server.

`CARGO_HOME`, `CARGO_TARGET_DIR`, `TMPDIR`/`TEMP`/`TMP` may point at an external
drive. On Windows use drive H: for the checkout, emsdk, Cargo cache, build output
and temporary files where possible. Do not relocate global user profiles.

The two C ABI operations are `fcad_open` and `fcad_set_expression`. The latter
accepts JSON `{object, slot, value_mm}` using the native `ExpressionSlot` serde
representation. Values use native units (mm/radians/scalar according to slot).
It calls `EditChange::constant` and `Document::write_changes`; it does **not**
perform the geometry transaction in `ferritecad-jobs`. Production integration
must use that transaction once the native evaluator/kernel is available.

Input pointers and lengths belong to the caller. Output is a malloc-owned
frame: u32 little-endian JSON byte count, UTF-8 JSON, optional FCAD bytes. The
caller copies it and frees it using the standard `_free` export. The probe
assumes one synchronous call per Worker. Ordinals are decimal strings to keep
the full native i64 range intact in JavaScript.

The host executable uses the same Rust facade. `test-document-wasm.mjs` loads the
module through `src/document/abi.ts` (the code the browser Worker runs; it needs
type stripping, hence the flag) and compares all 101 inputs, native validation/versions/serialized payload bytes, edits and
refusals. Set `FERRITECAD_CLI` to a CLI from the exact native pin to additionally
compare `validate`, `inspect`, `edit`, and all edited SQL cells except
`meta.modified_at`. `DOCUMENT_HOST` can override the host facade binary path.
SQL comparisons and checksums live only in the test/build tools, not transport.

Some historical inputs have a different CBOR field order than the current
native serializer. Tests record these differences instead of claiming that
decode/re-encode preserves arbitrary original bytes. Native-versus-WASM
re-encoding must still match exactly. The probe never rewrites a file on Open.

CI checks the committed and freshly rebuilt artifacts against its native host,
and records SHA-256 equality separately. Emscripten ABI/toolchain compatibility
is tested on this pin, not assumed across future SDK/Rust updates. `manifest.json`
contains the native pin, toolchain, linker flags, checksums and sizes.
