import { activeDoc, dofLabel, useCad } from "@/lib/cad/store";

export function StatusBar() {
  const doc = useCad(activeDoc);
  const reports = useCad((s) => s.reports);
  const issues = useCad((s) => s.issues);
  const message = useCad((s) => s.message);
  const occtStatus = useCad((s) => s.occtStatus);
  const exchange = useCad((s) => s.exchange);
  const plane = useCad((s) => s.workPlane);
  const projection = useCad((s) => s.projection);
  const selection = useCad((s) => s.selection);
  const sketchId = selection?.kind === "sketch" ? selection.id : selection?.kind === "point" || selection?.kind === "edge" ? selection.sketchId : null;
  const report = sketchId ? reports[sketchId] : Object.values(reports)[0];
  const conflict = Object.values(reports).some((r) => r.status === "conflict");
  const note = message || exchange?.message || issues[0] || (conflict ? "Conflicting Constraints" : report ? `Sketch ${dofLabel(report)}` : "No sketch");
  const bad = Boolean(message || issues[0] || conflict || exchange?.refusal);

  return (
    <footer className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-xs">
      <span className="font-mono text-faint">{plane}</span>
      <span className="font-mono text-faint">{projection === "ortho" ? "orthographic" : "perspective"}</span>
      <span className={bad ? "min-w-0 flex-1 truncate text-bad" : "min-w-0 flex-1 truncate text-muted"}>{note}</span>
      {occtStatus && (
        <span className="max-w-[40%] truncate font-mono text-brass" data-exchange-status={exchange?.message ?? occtStatus}>
          {occtStatus}
        </span>
      )}
      <span id="cad-readout" className="hidden font-mono text-faint tabular-nums sm:inline">
        X — Y —
      </span>
      <span className="font-mono text-faint">{doc.unit}</span>
    </footer>
  );
}
