import { Link } from "@tanstack/react-router";
import { clsx } from "clsx";
import {
  Circle,
  CircleDot,
  Download,
  FolderOpen,
  HelpCircle,
  MousePointer2,
  Pentagon,
  Redo2,
  Save,
  Square,
  Undo2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { makeSamples } from "@/lib/cad/samples";
import { activeDoc, useCad, type SnapStep } from "@/lib/cad/store";
import { closeExchange, downloadExchangeFcad, downloadExchangeStep, leaveExchangeForLegacy, openExchangeFcad, openExchangeStep } from "@/occt/exchange";
import type { Plane, Tool } from "@/lib/cad/types";
import { IconBtn, ToolButton } from "./ui";

function reportExport(task: Promise<unknown>) {
  void task.catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    useCad.getState().flash(text);
  });
}

const tools: { id: Tool; label: string; icon: typeof Square }[] = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "circle", label: "Circle", icon: Circle },
  { id: "poly", label: "Polygon", icon: Pentagon },
  { id: "hole", label: "Hole", icon: CircleDot },
];

const planes: Plane[] = ["XY", "XZ", "YZ"];
const snaps: { id: SnapStep; label: string }[] = [
  { id: 0, label: "off" },
  { id: 0.1, label: "0.1" },
  { id: 1, label: "1" },
  { id: 5, label: "5" },
  { id: 10, label: "10" },
];

export function TopBar() {
  const docs = useCad((s) => s.docs);
  const activeId = useCad((s) => s.activeId);
  const tool = useCad((s) => s.tool);
  const plane = useCad((s) => s.workPlane);
  const snap = useCad((s) => s.snap);
  const doc = useCad(activeDoc);
  const exchange = useCad((s) => s.exchange);
  const [menu, setMenu] = useState<null | "file" | "samples">(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fcadRef = useRef<HTMLInputElement>(null);
  const stepRef = useRef<HTMLInputElement>(null);
  const locked = Boolean(exchange);

  return (
    <header className="shrink-0 border-b border-border bg-surface">
      <div className="flex h-12 items-center gap-2 px-2">
        <img src="/favicon.svg" alt="" className="size-7 shrink-0" />
        <div className="min-w-0 leading-tight">
          <div className="text-sm font-semibold tracking-tight text-fg">Ferrite</div>
          <div className="font-mono text-xs text-faint">CAD</div>
        </div>
        <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {docs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                void leaveExchangeForLegacy(() => useCad.getState().focusDoc(item.id));
              }}
              className={clsx(
                "flex h-8 shrink-0 items-center gap-1 rounded-sm px-2 text-sm",
                item.id === activeId ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
              )}
            >
              <span className="max-w-28 truncate">{item.name}</span>
              {docs.length > 1 && (
                <span
                  role="button"
                  aria-label={`Close ${item.name}`}
                  className="grid size-5 place-items-center rounded-sm text-faint hover:bg-bg hover:text-fg"
                  onClick={(e) => {
                    e.stopPropagation();
                    void leaveExchangeForLegacy(() => useCad.getState().closeDoc(item.id));
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
        </div>
        <Link to="/xde" className="shrink-0 rounded-sm px-2 py-1 text-xs font-medium text-brass hover:bg-surface-2">
          Assemblies
        </Link>
        <IconBtn label="Undo" onClick={() => useCad.getState().undo()}>
          <Undo2 className="size-4" />
        </IconBtn>
        <IconBtn label="Redo" onClick={() => useCad.getState().redo()}>
          <Redo2 className="size-4" />
        </IconBtn>
        <div className="relative">
          <IconBtn label="File" active={menu === "file"} onClick={() => setMenu(menu === "file" ? null : "file")}>
            <FolderOpen className="size-4" />
          </IconBtn>
          {menu === "file" && (
            <div className="absolute right-0 z-30 mt-1 w-64 rounded-sm border border-border bg-surface p-1 shadow-lg">
              <MenuItem
                icon={Square}
                label="New Part"
                onClick={() => {
                  void leaveExchangeForLegacy(() => useCad.getState().newDoc());
                  setMenu(null);
                }}
              />
              <MenuItem
                icon={FolderOpen}
                label="Examples"
                onClick={() => {
                  setMenu("samples");
                }}
              />
              <MenuItem icon={Upload} label="Open .fcad" onClick={() => fcadRef.current?.click()} />
              <MenuItem
                icon={Save}
                label={exchange?.kind === "fcad" && !exchange.editable ? "Download Original File" : "Save .fcad"}
                onClick={() => {
                  reportExport(downloadExchangeFcad());
                  setMenu(null);
                }}
              />
              <MenuItem icon={Upload} label="Open STEP" onClick={() => stepRef.current?.click()} />
              <MenuItem
                icon={Download}
                label="Export STEP"
                onClick={() => {
                  reportExport(downloadExchangeStep());
                  setMenu(null);
                }}
              />
              {exchange && (
                <MenuItem
                  icon={FolderOpen}
                  label="Close Document"
                  onClick={() => {
                    reportExport(closeExchange());
                    setMenu(null);
                  }}
                />
              )}
              <MenuItem icon={Upload} label="Open JSON" onClick={() => fileRef.current?.click()} />
              <MenuItem
                icon={Save}
                label="Save JSON"
                onClick={() => {
                  useCad.getState().exportJSON();
                  setMenu(null);
                }}
              />
              <MenuItem
                icon={Download}
                label="Export STL"
                onClick={() => {
                  if (exchange) {
                    useCad.getState().flash("Use Export STEP for this document.");
                    setMenu(null);
                    return;
                  }
                  useCad.getState().exportSTL();
                  setMenu(null);
                }}
              />
            </div>
          )}
          {menu === "samples" && (
            <div className="absolute right-0 z-30 mt-1 w-64 rounded-sm border border-border bg-surface p-1 shadow-lg">
              {makeSamples().map((sample) => (
                <button
                  key={sample.id}
                  type="button"
                  className="flex w-full flex-col rounded-sm px-2 py-2 text-left hover:bg-surface-2"
                  onClick={() => {
                    void leaveExchangeForLegacy(() => useCad.getState().openSample(sample.id));
                    setMenu(null);
                  }}
                >
                  <span className="text-sm text-fg">{sample.name}</span>
                  <span className="text-xs text-faint">{sample.parameters.length} parameters</span>
                </button>
              ))}
              <button
                type="button"
                className="mt-1 w-full rounded-sm px-2 py-2 text-left text-sm text-brass hover:bg-surface-2"
                onClick={() => {
                  void leaveExchangeForLegacy(() => useCad.getState().restoreSamples());
                  setMenu(null);
                }}
              >
                Restore all examples
              </button>
            </div>
          )}
        </div>
        <IconBtn label="Help" onClick={() => useCad.getState().setHelp(true)}>
          <HelpCircle className="size-4" />
        </IconBtn>
        <input
          ref={fcadRef}
          type="file"
          accept=".fcad,application/octet-stream"
          data-open-fcad
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            setMenu(null);
            if (!file) return;
            void openExchangeFcad(file);
          }}
        />
        <input
          ref={stepRef}
          type="file"
          accept=".step,.stp,model/step"
          data-open-step
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            setMenu(null);
            if (!file) return;
            void openExchangeStep(file);
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              const parsed = JSON.parse(await file.text());
              void leaveExchangeForLegacy(() => useCad.getState().importDoc(parsed));
            } catch {
              useCad.getState().flash("File cannot be read");
            }
            setMenu(null);
          }}
        />
      </div>
      <div className="flex h-12 items-center gap-1 overflow-x-auto border-t border-border px-1">
        {tools.map((item) => {
          const Icon = item.icon;
          return (
            <ToolButton
              key={item.id}
              label={item.label}
              active={tool === item.id}
              disabled={locked && item.id !== "select"}
              onClick={() => useCad.getState().setTool(item.id)}
            >
              <Icon className="size-4" />
            </ToolButton>
          );
        })}
        <span className="mx-1 h-6 w-px shrink-0 bg-border" />
        {planes.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => useCad.getState().setWorkPlane(item)}
            disabled={locked}
            className={clsx(
              "h-9 shrink-0 rounded-sm px-2 font-mono text-xs",
              locked && "cursor-not-allowed opacity-40",
              plane === item ? "bg-surface-2 text-brass" : "text-faint hover:text-fg",
            )}
          >
            {item}
          </button>
        ))}
        <span className="mx-1 h-6 w-px shrink-0 bg-border" />
        <label className="flex shrink-0 items-center gap-1 px-1 text-xs text-faint">
          Snap
          <select
            className="h-9 rounded-sm border border-border bg-bg px-1 font-mono text-xs text-fg"
            value={String(snap)}
            onChange={(e) => useCad.getState().setSnap(Number(e.target.value) as SnapStep)}
          >
            {snaps.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto hidden truncate pr-2 font-mono text-xs text-faint md:inline">{exchange?.fileName ?? doc.name}</span>
      </div>
    </header>
  );
}

function MenuItem({ icon: Icon, label, onClick }: { icon: typeof Square; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-10 w-full items-center gap-2 rounded-sm px-2 text-sm text-fg hover:bg-surface-2">
      <Icon className="size-4 text-muted" />
      {label}
    </button>
  );
}
