import { assertCadFileSize, readCadFile } from "@/occt/file-limits";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ComponentType } from "react";
import type { XdeClient } from "@/xde/client";
import type { ImportedSourceMeta } from "@/xde/fcad-meta";
import type { DefinitionMesh, PortableScene, XdeReport } from "@/xde/types";

export const Route = createFileRoute("/xde")({
  ssr: false,
  component: XdePage,
});

type Phase = "idle" | "working" | "ready" | "error";
type AssemblyScene = ComponentType<{
  report: XdeReport;
  meshes: DefinitionMesh[];
  selected: string | null;
  onSelect: (occurrenceId: string | null) => void;
}>;

function XdePage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<Promise<XdeClient> | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState(0);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<XdeReport | null>(null);
  const [portable, setPortable] = useState<PortableScene | null>(null);
  const [sceneError, setSceneError] = useState("");
  const [sceneNotes, setSceneNotes] = useState<string[]>([]);
  const [sceneBind, setSceneBind] = useState<"none" | "match" | "mismatch">("none");
  const stepBytes = useRef<Uint8Array | null>(null);
  const originalFcad = useRef<Uint8Array | null>(null);
  const [moved, setMoved] = useState(false);
  const saved = useRef<{ key: string; bytes: Uint8Array } | null>(null);
  const [meshes, setMeshes] = useState<DefinitionMesh[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scene, setScene] = useState<AssemblyScene | null>(null);
  const [meta, setMeta] = useState<ImportedSourceMeta | null>(null);
  const [fileName, setFileName] = useState("");
  const [timing, setTiming] = useState("");
  const [bytesNote, setBytesNote] = useState("");
  const [temporaryFiles, setTemporaryFiles] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [experiment, setExperiment] = useState(false);
  const [openedExperimental, setOpenedExperimental] = useState(false);
  const [fromFcad, setFromFcad] = useState(false);
  const [historicalDiagnostics, setHistoricalDiagnostics] = useState<PortableScene["diagnostics"]>([]);
  const [freshDiagnostics, setFreshDiagnostics] = useState<PortableScene["diagnostics"]>([]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      const pending = clientRef.current;
      clientRef.current = null;
      void pending?.then((active) => active.end()).catch(() => undefined);
    };
  }, []);

  function current() {
    return generation.current;
  }

  function live(token: number) {
    return mounted.current && token === generation.current;
  }

  async function client() {
    clientRef.current ??= import("@/xde/client").then((mod) => new mod.XdeClient());
    return clientRef.current;
  }

  async function onRead() {
    const token = current();
    const useExperiment = experiment;
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setPhase("error");
      setError("Choose a STEP or .fcad file first. Nothing is loaded automatically.");
      return;
    }
    try { assertCadFileSize(file.size); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return; }
    setPhase("working");
    setError("");
    setEnded(false);
    setMeta(null);
    setReport(null);
    setPortable(null);
    setSceneError("");
    setSceneNotes([]);
    setSceneBind("none");
    setHistoricalDiagnostics([]);
    setFreshDiagnostics([]);
    setMeshes([]);
    setSelected(null);
    setScene(null);
    setFileName("");
    setBytesNote("");
    setTiming("");
    setTemporaryFiles(0);
    setAttempt((value) => value + 1);
    setOpenedExperimental(false);
    setFromFcad(false);
    try {
      let bytes: Uint8Array<ArrayBufferLike> = await readCadFile(file);
      if (!live(token)) return;
      let label = file.name;
      originalFcad.current = null;
      setMoved(false);
      saved.current = null;
      stepBytes.current = null;
      let storedScene: PortableScene | null = null;
      if (file.name.toLowerCase().endsWith(".fcad")) {
        const { extractFcad } = await import("@/xde/fcad-browser");
        if (!live(token)) return;
        const extracted = await extractFcad(bytes);
        if (!live(token)) return;
        setMeta(extracted.meta);
        originalFcad.current = bytes;
        storedScene = extracted.scene;
        bytes = extracted.step;
        label = `${file.name} → ${extracted.meta.sourceName ?? "embedded STEP"}`;
      }
      const active = await client();
      if (!live(token)) return;
      const result = await active.read(bytes, { experimental: useExperiment });
      if (!live(token)) return;
      const view = await import("@/xde/view");
      if (!live(token)) return;
      setScene(() => view.AssemblyView);
      setMeshes(result.meshes);
      setSelected(null);
      setReport(result.report);
      let nextPortable = result.scene;
      let nextError = result.sceneError ?? "";
      let nextBind: "none" | "match" | "mismatch" = "none";
      if (storedScene) {
        const { bindImportedScene } = await import("@/occt/fcad-scene");
        if (!live(token)) return;
        const bound = bindImportedScene(storedScene, result.scene);
        nextBind = bound.confirmed ? "match" : "mismatch";
        if (!bound.confirmed) {
          nextPortable = null;
          nextError = bound.error ?? "the stored scene was not confirmed";
        }
      }
      setPortable(nextPortable);
      setHistoricalDiagnostics(storedScene?.diagnostics ?? []);
      setFreshDiagnostics(result.scene?.diagnostics ?? []);
      setSceneError(nextError);
      setSceneNotes(result.sceneNotes ?? []);
      setSceneBind(nextBind);
      stepBytes.current = bytes;
      setOpenedExperimental(useExperiment);
      setFromFcad(file.name.toLowerCase().endsWith(".fcad"));
      setSession(result.session);
      setFileName(label);
      setTemporaryFiles(result.temporaryFiles.length);
      setTiming(`Read ${Math.round(result.readMs)} ms · worker init ${Math.round(result.initMs)} ms · heap ${formatBytes(result.heapBytes)} · temporary files ${result.temporaryFiles.length}`);
      if (storedScene || originalFcad.current) {
        const verdict = nextBind === "match"
          ? "This WASM re-checked the embedded STEP and the stored scene matches that reading. Original FerriteCAD did not check this file."
          : nextBind === "mismatch"
            ? "This WASM re-checked the embedded STEP and the stored scene does not match, so it was not confirmed. Original FerriteCAD did not check this file."
            : "This schema has no scene this WASM can re-check. Original FerriteCAD did not check this file.";
        setBytesNote(`Geometry is the embedded STEP. The stored scene was not used as the viewer report. ${verdict}`);
      }
      if (nextBind === "mismatch") setError(nextError);
      setPhase("ready");
    } catch (caught) {
      if (!live(token)) return;
      setPhase("error");
      setMeta(null);
      setReport(null);
      setPortable(null);
      setSceneError("");
      setSceneNotes([]);
      setSceneBind("none");
      setOpenedExperimental(false);
      setFromFcad(false);
      setHistoricalDiagnostics([]);
      setFreshDiagnostics([]);
      setMeshes([]);
      setSelected(null);
      setScene(null);
      setFileName("");
      setTiming("");
      setBytesNote("");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function onExport() {
    const token = current();
    setPhase("working");
    setError("");
    try {
      const active = await client();
      if (!live(token)) return;
      const result = await active.exportStep();
      if (!live(token)) return;
      const copy = new Uint8Array(result.bytes);
      const blob = new Blob([copy], { type: "application/step" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = openedExperimental ? experimentalExportName(fileName) : exportedName(fileName);
      anchor.click();
      URL.revokeObjectURL(url);
      setSession(result.session);
      setTemporaryFiles(result.temporaryFiles.length);
      setBytesNote(`Exported ${result.byteLength} bytes from the open XDE document.`);
      setPhase(report ? "ready" : "idle");
    } catch (caught) {
      if (!live(token)) return;
      setPhase("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function onShift() {
    const token = current();
    setPhase("working");
    setError("");
    setReport(null);
    setMeshes([]);
    setSelected(null);
    try {
      const active = await client();
      if (!live(token)) return;
      const result = await active.shift("Pin", 5);
      if (!live(token)) return;
      setMeshes(result.meshes);
      setReport(result.report);
      setSession(result.session);
      setTemporaryFiles(result.temporaryFiles.length);
      setBytesNote("Moved the Pin occurrence +5 mm in Z inside the XDE document.");
      setMoved(true);
      setPortable(null);
      setSceneBind("none");
      saved.current = null;
      setPhase("ready");
    } catch (caught) {
      if (!live(token)) return;
      setPhase("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function onSave() {
    const token = current();
    setPhase("working");
    setError("");
    try {
      if (sceneBind === "mismatch") throw new Error("the stored scene does not match the embedded STEP, so it was not saved");
      if (openedExperimental) {
        if (moved || !portable || !stepBytes.current) throw new Error("experimental placement compatibility has no confirmed document, so it was not saved");
        const downloadName = fromFcad ? experimentalReopenName(fileName) : experimentalImportName(fileName);
        if (saved.current?.key === "experimental" && !moved) {
          download(saved.current.bytes, downloadName, "application/octet-stream");
          setBytesNote("Saved the same experimental imported FCAD again. The original STEP bytes were kept.");
          setPhase("ready");
          return;
        }
        const { saveImportedFcad } = await import("@/xde/fcad-browser");
        const { EXPERIMENTAL_PLACEMENT_IMPORTER } = await import("@/occt/fcad-import");
        if (!live(token)) return;
        const bytes = await saveImportedFcad({
          step: stepBytes.current,
          sourceName: stepSourceName(fileName),
          objectName: objectName(fileName),
          scene: portable,
          importer: EXPERIMENTAL_PLACEMENT_IMPORTER,
        });
        if (!live(token)) return;
        saved.current = { key: "experimental", bytes };
        download(bytes, downloadName, "application/octet-stream");
        setBytesNote("Saved a new experimental imported FCAD. The embedded STEP bytes are the file that was read. This is not a native FerriteCAD document.");
        setPhase("ready");
        return;
      }
      if (originalFcad.current && !moved) {
        download(originalFcad.current, importedName(fileName), "application/octet-stream");
        setBytesNote("Saved the unchanged imported FCAD. Occurrence ids were kept.");
        setPhase("ready");
        return;
      }
      if (saved.current && !moved) {
        download(saved.current.bytes, importedName(fileName), "application/octet-stream");
        setBytesNote("Saved the same revision again. Occurrence ids were kept.");
        setPhase("ready");
        return;
      }
      const active = await client();
      if (!live(token)) return;
      let source = stepBytes.current;
      let scene = portable;
      let notes = sceneNotes;
      if (moved || !scene) {
        const exported = await active.exportStep();
        if (!live(token)) return;
        const projected = await active.projectStep(exported.bytes);
        if (!live(token)) return;
        if (!projected.scene) throw new Error(projected.sceneError || "this STEP has no portable scene");
        source = exported.bytes;
        scene = projected.scene;
        notes = projected.sceneNotes;
        setPortable(scene);
        setSceneNotes(notes);
        setSceneError("");
      }
      if (!source || !scene) throw new Error("nothing is ready to save");
      const { saveImportedFcad } = await import("@/xde/fcad-browser");
      if (!live(token)) return;
      const bytes = await saveImportedFcad({
        step: source,
        sourceName: stepSourceName(fileName),
        objectName: objectName(fileName),
        scene,
      });
      if (!live(token)) return;
      saved.current = { key: "revision", bytes };
      setMoved(false);
      stepBytes.current = source;
      originalFcad.current = null;
      download(bytes, importedName(fileName), "application/octet-stream");
      setBytesNote("Saved a new imported FCAD. Imported geometry, no parametric history.");
      setPhase("ready");
    } catch (caught) {
      if (!live(token)) return;
      setPhase(report ? "ready" : "error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function onStop(kind: "cancel" | "end") {
    generation.current += 1;
    const pending = clientRef.current;
    if (pending) {
      try {
        (await pending).end();
      } catch {
        // The worker module failed to load. Nothing is left running.
      }
    }
    if (!mounted.current) return;
    setEnded(true);
    setPhase("idle");
    setError("");
    setReport(null);
    setMeshes([]);
    setSelected(null);
    setScene(null);
    setPortable(null);
    setSceneError("");
    setSceneNotes([]);
    setSceneBind("none");
    setMoved(false);
    setOpenedExperimental(false);
    setFromFcad(false);
    originalFcad.current = null;
    stepBytes.current = null;
    saved.current = null;
    setFileName("");
    setMeta(null);
    setBytesNote(kind === "cancel" ? "Cancelled. The next read starts a new worker." : "Session released. The next read starts a new worker.");
  }

  return (
    <main className="min-h-svh bg-bg text-fg" data-xde-state={phase} data-xde-session={session} data-xde-ended={ended ? "yes" : "no"} data-xde-temporary={temporaryFiles} data-xde-attempt={attempt} data-xde-scene={portable ? "ready" : sceneError ? "blocked" : "none"} data-xde-scene-bind={sceneBind} data-xde-experiment={experiment ? "on" : "off"} data-xde-opened-experiment={openedExperimental ? "on" : "off"}>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link to="/" className="text-sm font-semibold tracking-tight">
            Ferrite
          </Link>
          <span className="font-mono text-xs text-faint">Assembly prototype</span>
          <span className="ml-auto font-mono text-xs text-muted">Session {session || "—"}</span>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5">
        <p className="max-w-3xl text-sm text-muted">
          Reads and writes a STEP assembly with a separate Open CASCADE session. It does not change the part open in Ferrite, and it does not load until you choose a file. Experimental placement compatibility stays off unless you turn it on, and it applies only to the next Read.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input id="xde-file" ref={inputRef} type="file" accept=".step,.stp,.fcad,application/step" className="max-w-full text-sm text-muted file:mr-3 file:rounded-sm file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-sm file:text-fg" />
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={experiment} disabled={phase === "working"} onChange={(event) => setExperiment(event.target.checked)} />
            Experimental placement compatibility
          </label>
          <button type="button" onClick={() => void onRead()} disabled={phase === "working"} className="rounded-sm bg-primary px-3 py-2 text-sm font-medium text-primary-ink disabled:opacity-50">
            Read
          </button>
          <button type="button" onClick={() => void onExport()} disabled={phase === "working" || !report || ended} className="rounded-sm bg-surface-2 px-3 py-2 text-sm disabled:opacity-50">
            Export STEP
          </button>
          <button type="button" onClick={() => void onShift()} disabled={phase === "working" || !report || ended || experiment || openedExperimental} className="rounded-sm bg-surface-2 px-3 py-2 text-sm disabled:opacity-50">
            Shift Pin +5 mm
          </button>
          <button type="button" onClick={() => void onSave()} disabled={phase === "working" || !report || ended || (!portable && !moved)} className="rounded-sm bg-surface-2 px-3 py-2 text-sm disabled:opacity-50" data-xde-save={portable || moved ? "yes" : "no"}>
            Save imported FCAD
          </button>
          <button type="button" onClick={() => void onStop("cancel")} disabled={phase !== "working"} className="rounded-sm border border-border px-3 py-2 text-sm disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={() => void onStop("end")} disabled={phase !== "working" && (session === 0 || ended)} className="rounded-sm border border-border px-3 py-2 text-sm disabled:opacity-50">
            End session
          </button>
        </div>
        <p className="font-mono text-xs text-muted" data-xde-status={phase}>
          {phase === "working" ? "Working…" : fileName || "No file"}
          {timing ? ` · ${timing}` : ""}
          {bytesNote ? ` · ${bytesNote}` : ""}
        </p>
        {sceneError ? <p className="text-sm text-bad" data-xde-scene-error={sceneError}>{sceneError}</p> : <p className="hidden" data-xde-scene-error="" />}
        {sceneNotes.length > 0 ? <p className="text-sm text-muted" data-xde-scene-notes="yes">{sceneNotes.join(" ")}</p> : null}
        {historicalDiagnostics.length > 0 ? (
          <ul className="list-disc pl-5 text-sm text-muted" data-xde-historical-diagnostics="yes">
            {historicalDiagnostics.map((item, index) => (
              <li key={`hist-${item.entity}-${index}`}>Stored at import ({item.severity}): {item.entity}: {item.message}</li>
            ))}
          </ul>
        ) : null}
        {freshDiagnostics.length > 0 ? (
          <ul className="list-disc pl-5 text-sm text-muted" data-xde-scene-diagnostics="yes">
            {freshDiagnostics.map((item, index) => (
              <li key={`fresh-${item.entity}-${index}`}>This reading ({item.severity}): {item.entity}: {item.message}</li>
            ))}
          </ul>
        ) : null}
        {portable || moved ? <p className="text-sm text-muted">Imported geometry, no parametric history. Saving writes a new FCAD and does not change the part open in Ferrite.</p> : null}
        {error ? (
          <p className="rounded-sm border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad" data-xde-error={error}>
            {error}
          </p>
        ) : (
          <p className="hidden" data-xde-error="" />
        )}
        {meta ? <SourceMeta meta={meta} /> : null}
        {report && meshes.length > 0 ? (
          <SceneSlot scene={scene} report={report} meshes={meshes} selected={selected} onSelect={setSelected} />
        ) : null}
        {report ? (
          <details open className="rounded-sm border border-border bg-surface" data-xde-diagnostics="yes">
            <summary className="cursor-pointer px-3 py-2 text-sm">Diagnostics</summary>
            <div className="px-3 pb-3">
              <ReportView report={report} />
            </div>
          </details>
        ) : null}
      </div>
    </main>
  );
}

function SceneSlot({
  scene,
  report,
  meshes,
  selected,
  onSelect,
}: {
  scene: AssemblyScene | null;
  report: XdeReport;
  meshes: DefinitionMesh[];
  selected: string | null;
  onSelect: (occurrenceId: string | null) => void;
}) {
  if (!scene) return null;
  const View = scene;
  return <View report={report} meshes={meshes} selected={selected} onSelect={onSelect} />;
}

function SourceMeta({ meta }: { meta: ImportedSourceMeta }) {
  return (
    <section className="rounded-sm border border-border bg-surface p-3 text-sm">
      <h2 className="font-medium">Embedded source</h2>
      <dl className="mt-2 grid gap-1 font-mono text-xs text-muted sm:grid-cols-2">
        <div>format {meta.format}</div>
        <div>bytes {meta.blobBytes}</div>
        <div>byte_len {meta.byteLen}</div>
        <div>BLAKE3 {meta.hashOk ? "matches" : "does not match"}</div>
        <div className="sm:col-span-2">source_name {meta.sourceName ?? "(none)"}</div>
        <div className="break-all sm:col-span-2">{meta.contentHashHex}</div>
      </dl>
    </section>
  );
}

function ReportView({ report }: { report: XdeReport }) {
  const units = report.fileUnits.available ? report.fileUnits.length.join(", ") || "(none declared)" : `unavailable: ${report.fileUnits.reason}`;
  return (
    <section className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="Leaf volume" value={`${report.leafVolumeMm3.toFixed(3)} mm³`} />
        <Stat label="Part definitions" value={String(report.partDefinitions)} />
        <Stat label="Part occurrences" value={String(report.partOccurrences)} />
        <Stat label="File units" value={units} />
      </div>
      <div className="overflow-x-auto rounded-sm border border-border">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead className="bg-surface text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Path</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Definition</th>
              <th className="px-3 py-2 font-medium">Placement</th>
              <th className="px-3 py-2 font-medium">Colour</th>
              <th className="px-3 py-2 font-medium">Volume</th>
            </tr>
          </thead>
          <tbody>
            {report.nodes.map((node, index) => (
              <tr key={`${node.path}-${index}`} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{node.path}</td>
                <td className="px-3 py-2 text-muted">{node.isAssembly ? "assembly" : "part"} {node.isOccurrence ? "occurrence" : "root"}</td>
                <td className="px-3 py-2 font-mono text-xs">{node.definitionId}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmt3(node.world[3] ?? 0, node.world[7] ?? 0, node.world[11] ?? 0)}</td>
                <td className="px-3 py-2"><Swatch color={node.color} /></td>
                <td className="px-3 py-2 font-mono text-xs">{node.isAssembly ? "—" : node.volumeMm3.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <pre id="xde-report" className="max-h-80 overflow-auto rounded-sm bg-surface p-3 font-mono text-xs text-muted">
        {JSON.stringify(report)}
      </pre>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-border bg-surface px-3 py-2">
      <div className="text-xs text-faint">{label}</div>
      <div className="font-mono text-sm" data-xde-volume={label === "Leaf volume" ? value : undefined}>{value}</div>
    </div>
  );
}

function Swatch({ color }: { color: XdeReport["nodes"][number]["color"] }) {
  if (!color.effective) return <span className="text-xs text-faint">none</span>;
  const [r, g, b] = color.effective.rgb.map(linearToSrgb);
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className="size-3 rounded-sm border border-border" style={{ background: `rgb(${r} ${g} ${b})` }} />
      <span className="font-mono text-muted">{color.origin}</span>
    </span>
  );
}

function linearToSrgb(value: number): number {
  const channel = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, channel)) * 255);
}

function fmt3(x: number, y: number, z: number): string {
  return `${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}`;
}

function formatBytes(value: number | null): string {
  if (value == null) return "n/a";
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function exportedName(fileName: string): string {
  const base = fileName.replace(/\.(step|stp|fcad)$/i, "") || "assembly";
  return `${base}-xde.step`;
}

function objectName(fileName: string): string {
  const base = fileName.split("→")[0]?.trim() || fileName;
  return base.replace(/\.(step|stp|fcad)$/i, "") || "assembly";
}

function stepSourceName(fileName: string): string {
  const embedded = fileName.split("→")[1]?.trim();
  if (embedded) return embedded;
  const base = objectName(fileName);
  return base.toLowerCase().endsWith(".step") ? base : `${base}.step`;
}

function experimentalImportName(fileName: string): string {
  return `${objectName(fileName)}-experimental-import.fcad`;
}

function experimentalReopenName(fileName: string): string {
  return `${objectName(fileName)}-experimental-reopen.fcad`;
}

function experimentalExportName(fileName: string): string {
  return `${objectName(fileName)}-experimental-export.step`;
}

function importedName(fileName: string): string {
  return `${objectName(fileName)}.fcad`;
}

function download(bytes: Uint8Array, name: string, type: string) {
  const copy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
