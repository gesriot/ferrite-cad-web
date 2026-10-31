import { clsx } from "clsx";
import { CircleDot, Eye, EyeOff, Pentagon, RotateCw, Spline, Square, Triangle } from "lucide-react";
import type { ReactNode } from "react";
import { activeDoc, dofLabel, useCad } from "@/lib/cad/store";
import { resolveRef, type Feature, type Sel } from "@/lib/cad/types";

export function TreePanel() {
  const doc = useCad(activeDoc);
  const exchange = useCad((s) => s.exchange);
  const reports = useCad((s) => s.reports);
  const selection = useCad((s) => s.selection);
  const hidden = useCad((s) => s.hiddenIds);
  const select = (sel: Sel) => useCad.getState().select(sel);

  if (exchange) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface" data-exchange-file={exchange.fileName} data-exchange-dirty={exchange.dirty ? "1" : "0"}>
        <div className="border-b border-border px-3 py-2 text-xs font-medium tracking-wide text-faint uppercase">
          {exchange.kind === "fcad" ? "FCAD" : "STEP"}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          <p
            className="px-2 py-1 font-mono text-xs text-fg"
            data-exchange-volume={exchange.volume ?? ""}
            data-exchange-bounds={exchange.bounds ? [...exchange.bounds.min, ...exchange.bounds.max].join(",") : ""}
          >
            {exchange.fileName}
          </p>
          {exchange.kind === "step" && (
            <p className="px-2 py-2 text-sm text-pretty text-muted">
              B-rep geometry only. The assembly tree, names, and colors are not supported.
            </p>
          )}
          {exchange.refusal && <p className="px-2 py-2 text-sm text-pretty text-bad">{exchange.refusal}</p>}
          {exchange.model && (
            <>
              <Row icon={<Square className="size-3.5" />} title={exchange.model.planeName} meta="XY plane" selected={false} hidden={false} onClick={() => undefined} onHide={() => undefined} />
              <Row
                icon={<Pentagon className="size-3.5" />}
                title={exchange.model.sketchName}
                meta={`${exchange.model.curveCount} lines · ${trim(exchange.model.area)} mm²`}
                selected={false}
                hidden={false}
                onClick={() => undefined}
                onHide={() => undefined}
              />
              <Row
                icon={<Square className="size-3.5" />}
                title={exchange.model.extrudeName}
                meta={`Blind · ${exchange.model.distanceSource} mm`}
                selected={false}
                hidden={false}
                onClick={() => undefined}
                onHide={() => undefined}
              />
              <Row icon={<Square className="size-3.5" />} title={exchange.model.bodyName} meta="Body" selected={false} hidden={false} onClick={() => undefined} onHide={() => undefined} />
            </>
          )}
          {!exchange.model && exchange.kind === "step" && exchange.volume != null && (
            <Row icon={<Square className="size-3.5" />} title="B-rep" meta={`${trim(exchange.volume)} mm³`} selected={false} hidden={false} onClick={() => undefined} onHide={() => undefined} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="border-b border-border px-3 py-2 text-xs font-medium tracking-wide text-faint uppercase">Model Tree</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <div className="px-2 py-1 text-xs text-faint">Sketches</div>
        {doc.sketches.map((sketch) => {
          const report = reports[sketch.id];
          const selected = selection?.kind === "sketch" && selection.id === sketch.id;
          return (
            <Row
              key={sketch.id}
              selected={selected}
              hidden={hidden.includes(sketch.id)}
              icon={<Pentagon className="size-3.5" />}
              title={sketch.name}
              meta={`${sketch.plane} · ${dofLabel(report)}`}
              dot={report?.status === "defined" ? "ok" : report?.status === "conflict" ? "bad" : "brass"}
              onClick={() => select({ kind: "sketch", id: sketch.id })}
              onHide={() => useCad.getState().toggleHidden(sketch.id)}
            />
          );
        })}
        {doc.sketches.length === 0 && <p className="px-2 py-2 text-sm text-faint">Draw a contour on the plane.</p>}
        <div className="mt-3 px-2 py-1 text-xs text-faint">Features</div>
        {doc.features.map((feature) => (
          <Row
            key={feature.id}
            selected={selection?.kind === "feature" && selection.id === feature.id}
            hidden={hidden.includes(feature.id)}
            icon={featureIcon(feature)}
            title={feature.name}
            meta={featureMeta(feature, doc)}
            onClick={() => select({ kind: "feature", id: feature.id })}
            onHide={() => useCad.getState().toggleHidden(feature.id)}
          />
        ))}
      </div>
    </div>
  );
}

function featureIcon(feature: Feature) {
  if (feature.kind === "hole") return <CircleDot className="size-3.5" />;
  if (feature.kind === "fillet") return <Spline className="size-3.5" />;
  if (feature.kind === "chamfer") return <Triangle className="size-3.5" />;
  if (feature.mode === "revolve") return <RotateCw className="size-3.5" />;
  return <Square className="size-3.5" />;
}

function featureMeta(feature: Feature, doc: ReturnType<typeof activeDoc>): string {
  if (feature.kind === "solid") {
    const depth = resolveRef(feature.depth, feature.depthRef, doc.parameters);
    return feature.mode === "revolve" ? `Revolve · ${feature.angle}°` : `Extrude · ${trim(depth)} mm`;
  }
  if (feature.kind === "hole") {
    const d = resolveRef(feature.diameter, feature.diameterRef, doc.parameters);
    return feature.depth == null ? `Ø ${trim(d)} · Through All` : `Ø ${trim(d)} · ${trim(feature.depth)} mm`;
  }
  if (feature.kind === "fillet") return `R ${trim(resolveRef(feature.radius, feature.radiusRef, doc.parameters))}`;
  return `${trim(resolveRef(feature.distance, feature.distanceRef, doc.parameters))} mm`;
}

function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function Row({
  selected,
  hidden,
  icon,
  title,
  meta,
  dot,
  onClick,
  onHide,
}: {
  selected: boolean;
  hidden: boolean;
  icon: ReactNode;
  title: string;
  meta: string;
  dot?: "ok" | "bad" | "brass";
  onClick: () => void;
  onHide: () => void;
}) {
  return (
    <div className={clsx("mb-0.5 flex items-center rounded-sm", selected ? "bg-surface-2" : "hover:bg-bg")}>
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left">
        <span className={clsx("text-muted", selected && "text-primary")}>{icon}</span>
        <span className="min-w-0">
          <span className={clsx("block truncate text-sm", hidden ? "text-faint line-through" : "text-fg")}>{title}</span>
          <span className="block truncate font-mono text-xs text-faint">{meta}</span>
        </span>
        {dot && (
          <span
            className={clsx(
              "ml-auto size-1.5 shrink-0 rounded-full",
              dot === "ok" && "bg-ok",
              dot === "bad" && "bg-bad",
              dot === "brass" && "bg-brass",
            )}
          />
        )}
      </button>
      <button type="button" aria-label={hidden ? "Show" : "Hide"} onClick={onHide} className="mr-1 grid size-8 place-items-center text-faint hover:text-fg">
        {hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  );
}
