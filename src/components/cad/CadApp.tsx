import { PanelLeft, SlidersHorizontal, X } from "lucide-react";
import { useEffect } from "react";
import { useCad } from "@/lib/cad/store";
import { chooseDocumentGate, debugCrashWorker, debugFailExtrude, debugFailSql } from "@/occt/exchange";
import { runOcctProof } from "@/occt/proof";
import { Inspector } from "./Inspector";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";
import { TreePanel } from "./TreePanel";
import { Viewport } from "./Viewport";

export function CadApp() {
  const drawer = useCad((s) => s.drawer);
  const help = useCad((s) => s.helpOpen);
  const transition = useCad((s) => s.transition);

  useEffect(() => {
    const host = window as Window & {
      __runOcctProof?: () => Promise<unknown>;
      __occtProof?: unknown;
    };
    host.__runOcctProof = async () => {
      const proof = await runOcctProof();
      host.__occtProof = proof.report;
      return proof.report;
    };
    return () => {
      delete host.__runOcctProof;
    };
  }, []);

  if (typeof window !== "undefined") {
    const host = window as Window & {
      __fcadDebug?: {
        crash: () => Promise<unknown>;
        failSql: () => Promise<unknown>;
        failExtrude: () => Promise<unknown>;
        snapshot: () => unknown;
      };
    };
    host.__fcadDebug = {
      crash: () => debugCrashWorker(),
      failSql: () => debugFailSql(),
      failExtrude: () => debugFailExtrude(),
      snapshot: () => {
        const state = useCad.getState();
        return {
          docs: state.docs,
          activeId: state.activeId,
          selection: state.selection,
          exchange: state.exchange?.fileName ?? null,
          volume: state.exchange?.volume ?? null,
          dirty: state.exchange?.dirty ?? false,
        };
      },
    };
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      const state = useCad.getState();
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "z") {
        e.preventDefault();
        if (e.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === "y") {
        e.preventDefault();
        state.redo();
        return;
      }
      if (e.key === "Escape") {
        state.clearPoly();
        state.setTool("select");
        state.setHelp(false);
        state.setDrawer(null);
      }
      if (e.key === "Enter" && state.tool === "poly" && state.poly.length >= 3) state.addPoly(state.poly);
      if (e.key === "Backspace" && state.poly.length) {
        e.preventDefault();
        state.popPoly();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") state.deleteSelection();
      if (key === "f") state.frame("sel");
      if (key === "a" && !e.metaKey && !e.ctrlKey) state.frame("all");
      if (key === "o") state.setProjection(state.projection === "persp" ? "ortho" : "persp");
      if (key === "h") state.toggleHidden();
      if (key === "u") state.showAll();
      if (key === "i") state.isolate();
      if (key === "?" ) state.setHelp(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="cad-app flex h-svh flex-col overflow-hidden bg-bg font-sans text-fg">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-border lg:block">
          <TreePanel />
        </aside>
        <main className="relative min-w-0 flex-1">
          <Viewport />
          <div className="absolute bottom-3 left-3 z-20 flex gap-2 lg:hidden">
            <button type="button" className="inline-flex h-11 items-center gap-1.5 rounded-sm border border-border bg-surface px-3 text-sm" onClick={() => useCad.getState().setDrawer(drawer === "tree" ? null : "tree")}>
              <PanelLeft className="size-4" />
              Model Tree
            </button>
            <button type="button" className="inline-flex h-11 items-center gap-1.5 rounded-sm border border-border bg-surface px-3 text-sm" onClick={() => useCad.getState().setDrawer(drawer === "inspector" ? null : "inspector")}>
              <SlidersHorizontal className="size-4" />
              Properties
            </button>
          </div>
        </main>
        <aside className="hidden w-80 shrink-0 border-l border-border lg:block">
          <Inspector />
        </aside>
        {drawer && (
          <div className="absolute inset-0 z-30 flex bg-bg/70 lg:hidden" onClick={() => useCad.getState().setDrawer(null)}>
            <div className={drawer === "inspector" ? "ml-auto h-full w-80 max-w-full" : "h-full w-80 max-w-full"} onClick={(e) => e.stopPropagation()}>
              {drawer === "tree" ? <TreePanel /> : <Inspector />}
            </div>
          </div>
        )}
      </div>
      <StatusBar />
      {transition && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-bg/75 p-4" role="presentation">
          <div className="w-full max-w-md rounded-sm border border-border bg-surface p-5" role="dialog" aria-labelledby="gate-title" data-document-gate>
            <h2 id="gate-title" className="text-lg font-semibold text-balance">
              {transition.title}
            </h2>
            <p className="mt-2 text-sm text-pretty text-muted">{transition.body}</p>
            <div className="mt-4 flex flex-col gap-2">
              {transition.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  data-gate-action={action.id}
                  className="h-10 rounded-sm border border-border px-3 text-sm text-fg hover:bg-surface-2"
                  onClick={() => chooseDocumentGate(action.id)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {help && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-bg/75 p-4" onClick={() => useCad.getState().setHelp(false)}>
          <div className="max-h-[80svh] w-full max-w-lg overflow-y-auto rounded-sm border border-border bg-surface p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="help-title">
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 id="help-title" className="text-lg font-semibold text-balance">
                Ferrite CAD in the browser
              </h2>
              <button type="button" aria-label="Close" className="grid size-9 place-items-center text-muted hover:text-fg" onClick={() => useCad.getState().setHelp(false)}>
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-3 text-sm text-pretty text-muted">
              <p>
                A parametric modeller in the spirit of FerriteCAD. Example sketches are solved here. An .fcad file in this slice — one XY plane, one closed line sketch, and one extrude — opens, changes height, and saves. STEP is geometry only, with no assembly tree.
              </p>
              <p>The part editor supports a single unconstrained line profile and a Blind +Z extrusion. Assemblies can read STEP/XDE and save a new imported FCAD document; this does not add assembly editing or full FCAD support. Unsupported FCAD documents can be downloaded unchanged.</p>
              <p className="break-all font-mono text-xs" data-build-id={__BUILD_INFO__.buildId}>Build: {__BUILD_INFO__.buildId}<br />Native format basis: {__BUILD_INFO__.nativeBasis.slice(0, 12)}</p>
              <p>A rectangle or circle becomes a solid at once. Example sizes are the parameters on the right: diameter, thickness, bolt count. A hole is placed by clicking a face. Revolve is switched in the solid properties; the profile must lie on one side of the axis.</p>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-faint">
                <li>F — Zoom to Selection</li>
                <li>A — Fit All</li>
                <li>O — Orthographic / Perspective</li>
                <li>H — Hide</li>
                <li>I — Isolate</li>
                <li>U — Show</li>
                <li>Ctrl+Z — Undo</li>
                <li>Del — Delete</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
