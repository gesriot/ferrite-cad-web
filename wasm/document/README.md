# Document WASM probe

This opt-in experiment calls the pinned native `ferritecad-document` library.
It does not replace the CAD editor or add a geometry evaluator. The web host
serves committed JavaScript and WebAssembly; `npm run build` never runs Rust.

Activate emsdk **4.0.23**, install Rust **1.96.0** with target
`wasm32-unknown-emscripten`, then run from the repository root:

```sh
cargo +1.96.0 build --locked --release --manifest-path wasm/document/Cargo.toml
node scripts/build-document-wasm.mjs
node scripts/test-document-wasm.mjs
npm run build
npm run preview -- --host 127.0.0.1 --port 8081
```

Open `/document-probe/index.html?enabled=1`. Choose a local FCAD, inspect the
native expression slots, apply a constant, and download the result. Without the
query flag the controls are disabled. The kernel loads only on the first Open.
End or leaving the page terminates its Worker. All files are temporary MEMFS
files; nothing is persisted to OPFS or sent to a server.

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

The host executable uses the same Rust facade. `test-document-wasm.mjs` compares
all 101 inputs, native validation/versions/serialized payload bytes, edits and
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
