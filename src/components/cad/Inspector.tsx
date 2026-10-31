import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { activeDoc, useCad } from "@/lib/cad/store";
import { commitExchangeHeight } from "@/occt/exchange";
import { resolveRef, type HolePlace, type Plane, type Sketch } from "@/lib/cad/types";
import { isCountUnit } from "@/lib/cad/format";
import { NumField, Section, Toggle } from "./ui";

export function Inspector() {
  const doc = useCad(activeDoc);
  const selection = useCad((s) => s.selection);
  const tool = useCad((s) => s.tool);
  const holeDia = useCad((s) => s.holeDia);
  const holeThrough = useCad((s) => s.holeThrough);
  const holeDepth = useCad((s) => s.holeDepth);
  const filletRadius = useCad((s) => s.filletRadius);
  const exchange = useCad((s) => s.exchange);

  if (exchange) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface">
        <div className="border-b border-border px-3 py-2">
          <h2 className="text-xs font-medium tracking-wide text-faint uppercase">Properties</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title={exchange.fileName}>
            {exchange.kind === "step" && (
              <p className="text-sm text-pretty text-muted">
                Only geometry was imported. Names, colors, nesting, and repeated assembly instances are not restored here. This cannot be saved as .fcad.
              </p>
            )}
            {exchange.refusal && exchange.kind === "fcad" && <p className="text-sm text-pretty text-bad">{exchange.refusal}</p>}
            {exchange.model && (
              <HeightField
                source={exchange.model.distanceSource}
                disabled={!exchange.editable || exchange.busy}
                onCommit={(text) => commitExchangeHeight(text)}
              />
            )}
            {exchange.volume != null && (
              <p className="font-mono text-sm text-fg" data-exchange-status={exchange.message}>
                Volume {trim(exchange.volume)} mm³
                {exchange.bounds
                  ? ` · ${trim(exchange.bounds.max[0] - exchange.bounds.min[0])}×${trim(exchange.bounds.max[1] - exchange.bounds.min[1])}×${trim(exchange.bounds.max[2] - exchange.bounds.min[2])}`
                  : ""}
              </p>
            )}
            {exchange.busy && <p className="text-sm text-muted">Building solid…</p>}
            {exchange.kind === "fcad" && !exchange.editable && (
              <p className="text-sm text-pretty text-muted">Download Original File returns the bytes of the selected file with no edits. It does not save the model on screen.</p>
            )}
          </Section>
        </div>
      </div>
    );
  }

  const feature = selection?.kind === "feature" ? doc.features.find((f) => f.id === selection.id) : undefined;
  const sketch =
    selection?.kind === "sketch"
      ? doc.sketches.find((s) => s.id === selection.id)
      : selection?.kind === "point" || selection?.kind === "edge"
        ? doc.sketches.find((s) => s.id === selection.sketchId)
        : feature?.kind === "solid"
          ? doc.sketches.find((s) => s.id === feature.sketchId)
          : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-medium tracking-wide text-faint uppercase">Properties</h2>
        {selection && (selection.kind === "feature" || selection.kind === "sketch") && (
          <button type="button" className="inline-flex h-8 items-center gap-1 text-xs text-muted hover:text-bad" onClick={() => useCad.getState().deleteSelection()}>
            <Trash2 className="size-3.5" />
            Delete
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {doc.parameters.length > 0 && (
          <details open={!feature} className="border-b border-border">
            <summary className="cursor-pointer px-3 py-3 text-xs font-medium tracking-wide text-faint uppercase">
              Parameters · {doc.parameters.length}
            </summary>
            <div className="flex flex-col gap-3 px-3 pb-3">
              {doc.parameters.map((param) => (
                <NumField
                  key={param.id}
                  label={param.name}
                  unit={param.unit}
                  value={param.value}
                  min={isCountUnit(param.unit) ? 1 : 0}
                  max={isCountUnit(param.unit) ? 24 : 2000}
                  onChange={(value) => useCad.getState().setParam(param.id, value)}
                />
              ))}
            </div>
          </details>
        )}

        {!selection && tool === "hole" && (
          <Section title="New Hole">
            <NumField label="Diameter" value={holeDia} min={0.2} onChange={(holeDia) => useCad.getState().setHoleDraft({ holeDia })} />
            <Toggle on={holeThrough} label="Through All" onClick={() => useCad.getState().setHoleDraft({ holeThrough: !holeThrough })} />
            {!holeThrough && (
              <NumField label="Depth" value={holeDepth} min={0.2} onChange={(holeDepth) => useCad.getState().setHoleDraft({ holeDepth })} />
            )}
            <p className="text-sm text-pretty text-muted">Click a face or a plane. A blind hole is removed with a boolean cut.</p>
          </Section>
        )}

        {!selection && tool !== "hole" && doc.parameters.length === 0 && (
          <Section title="Empty part">
            <p className="text-sm text-pretty text-muted">
              A rectangle, circle, or polygon becomes a solid at once. Sizes are edited here; history is undo.
            </p>
          </Section>
        )}

        {sketch && (selection?.kind === "sketch" || selection?.kind === "point" || selection?.kind === "edge") && (
          <SketchFields sketch={sketch} />
        )}

        {selection?.kind === "point" && sketch && <PointFields sketch={sketch} pointId={selection.pointId} />}
        {selection?.kind === "edge" && sketch && <EdgeFields sketch={sketch} loopId={selection.loopId} index={selection.index} />}

        {feature?.kind === "solid" && (
          <Section title={feature.name}>
            <div className="grid grid-cols-2 gap-1">
              {(["extrude", "revolve"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => useCad.getState().patchSolid(feature.id, { mode })}
                  className={
                    feature.mode === mode
                      ? "h-10 rounded-sm bg-primary text-sm text-primary-ink"
                      : "h-10 rounded-sm border border-border text-sm text-muted"
                  }
                >
                  {mode === "extrude" ? "Extrude" : "Revolve"}
                </button>
              ))}
            </div>
            {feature.mode === "extrude" ? (
              <NumField
                label="Depth"
                value={resolveRef(feature.depth, feature.depthRef, doc.parameters)}
                min={0.1}
                onChange={(depth) => useCad.getState().patchSolid(feature.id, { depth })}
              />
            ) : (
              <>
                <NumField
                  label="Angle"
                  unit="°"
                  value={feature.angle}
                  min={0.1}
                  max={360}
                  onChange={(angle) => useCad.getState().patchSolid(feature.id, { angle })}
                />
                <div className="grid grid-cols-2 gap-1">
                  {(["X", "Y"] as const).map((axis) => (
                    <button
                      key={axis}
                      type="button"
                      onClick={() => useCad.getState().patchSolid(feature.id, { axis })}
                      className={
                        feature.axis === axis
                          ? "h-10 rounded-sm bg-surface-2 font-mono text-sm text-brass"
                          : "h-10 rounded-sm border border-border font-mono text-sm text-muted"
                      }
                    >
                      Axis {axis}
                    </button>
                  ))}
                </div>
              </>
            )}
            <Toggle on={feature.symmetric} label="Mid Plane" onClick={() => useCad.getState().patchSolid(feature.id, { symmetric: !feature.symmetric })} />
            <Toggle on={feature.flipped} label="Reverse" onClick={() => useCad.getState().patchSolid(feature.id, { flipped: !feature.flipped })} />
            <label className="flex flex-col gap-1 text-xs text-muted">
              Operation
              <select
                className="h-10 rounded-sm border border-border bg-bg px-2 text-sm text-fg"
                value={feature.operation}
                onChange={(e) => useCad.getState().patchSolid(feature.id, { operation: e.target.value as "new" | "join" | "cut" })}
              >
                <option value="new">New Body</option>
                <option value="join">Join</option>
                <option value="cut">Cut</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="h-10 rounded-sm border border-border text-sm" onClick={() => useCad.getState().addFillet()}>
                Fillet {filletRadius}
              </button>
              <button type="button" className="h-10 rounded-sm border border-border text-sm" onClick={() => useCad.getState().addChamfer()}>
                Chamfer
              </button>
            </div>
          </Section>
        )}

        {feature?.kind === "hole" && <HoleFields id={feature.id} />}
        {feature?.kind === "fillet" && (
          <Section title="Corner fillet">
            <NumField
              label="Radius"
              value={resolveRef(feature.radius, feature.radiusRef, doc.parameters)}
              min={0}
              onChange={(radius) => useCad.getState().patchFillet(feature.id, radius)}
            />
            <p className="text-sm text-pretty text-muted">Rounds the profile corners before the solid is built — the vertical edges of the plate.</p>
          </Section>
        )}
        {feature?.kind === "chamfer" && (
          <Section title="Chamfer">
            <NumField
              label="Distance"
              value={resolveRef(feature.distance, feature.distanceRef, doc.parameters)}
              min={0}
              onChange={(distance) => useCad.getState().patchChamfer(feature.id, distance)}
            />
          </Section>
        )}
      </div>
    </div>
  );
}

function HeightField({ source, disabled, onCommit }: { source: string; disabled: boolean; onCommit: (text: string) => Promise<void> }) {
  const [text, setText] = useState(source);
  useEffect(() => {
    setText(source);
  }, [source]);
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted">Height</span>
      <span className="flex items-center gap-2">
        <input
          data-exchange-height
          inputMode="decimal"
          disabled={disabled}
          className="h-10 min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 font-mono text-sm text-fg tabular-nums outline-none focus:border-primary disabled:opacity-50"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const next = text;
            void onCommit(next).catch(() => setText(source));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          }}
        />
        <span className="w-8 shrink-0 font-mono text-xs text-faint">mm</span>
      </span>
    </label>
  );
}

function SketchFields({ sketch }: { sketch: Sketch }) {
  const doc = useCad(activeDoc);
  return (
    <Section title={sketch.name}>
      <div className="grid grid-cols-3 gap-1">
        {(["XY", "XZ", "YZ"] as Plane[]).map((plane) => (
          <button
            key={plane}
            type="button"
            onClick={() => useCad.getState().setSketchPlane(sketch.id, plane)}
            className={
              sketch.plane === plane
                ? "h-10 rounded-sm bg-surface-2 font-mono text-xs text-brass"
                : "h-10 rounded-sm border border-border font-mono text-xs text-muted"
            }
          >
            {plane}
          </button>
        ))}
      </div>
      <NumField
        label="Plane offset"
        value={resolveRef(sketch.offset, sketch.offsetRef, doc.parameters)}
        onChange={(offset) => useCad.getState().setSketchOffset(sketch.id, offset)}
      />
      <ul className="flex flex-col gap-2">
        {sketch.constraints.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted">{constraintLabel(c)}</span>
            {(c.type === "dist" || c.type === "radius" || c.type === "coord") && (
              <span className="font-mono text-xs text-brass tabular-nums">
                {c.type === "radius" && c.display === "diameter"
                  ? `Ø ${trim(resolveRef(c.value, c.ref, doc.parameters) * 2)}`
                  : trim(resolveRef(c.value, c.ref, doc.parameters))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PointFields({ sketch, pointId }: { sketch: Sketch; pointId: string }) {
  const point = sketch.points.find((p) => p.id === pointId);
  if (!point) return null;
  const move = (x: number, y: number) => useCad.getState().dragPoint(sketch.id, pointId, x, y);
  return (
    <Section title="Point">
      <NumField label="X" value={point.x} onChange={(x) => move(x, point.y)} />
      <NumField label="Y" value={point.y} onChange={(y) => move(point.x, y)} />
    </Section>
  );
}

function EdgeFields({ sketch, loopId, index }: { sketch: Sketch; loopId: string; index: number }) {
  const loop = sketch.loops.find((l) => l.id === loopId);
  if (!loop || loop.kind !== "poly") return null;
  const a = sketch.points.find((p) => p.id === loop.pointIds[index]);
  const b = sketch.points.find((p) => p.id === loop.pointIds[(index + 1) % loop.pointIds.length]);
  const length = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  const add = (kind: "h" | "v" | "dist" | "fix") => useCad.getState().addEdgeConstraint(sketch.id, loopId, index, kind);
  return (
    <Section title="Edge">
      <p className="font-mono text-sm text-brass tabular-nums">{trim(length)} mm</p>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="h-10 rounded-sm border border-border text-sm" onClick={() => add("h")}>
          Horizontal
        </button>
        <button type="button" className="h-10 rounded-sm border border-border text-sm" onClick={() => add("v")}>
          Vertical
        </button>
        <button type="button" className="h-10 rounded-sm border border-border text-sm" onClick={() => add("dist")}>
          Dimension
        </button>
        <button type="button" className="h-10 rounded-sm border border-border text-sm" onClick={() => add("fix")}>
          Fix
        </button>
      </div>
    </Section>
  );
}

function HoleFields({ id }: { id: string }) {
  const doc = useCad(activeDoc);
  const feature = doc.features.find((f) => f.id === id);
  if (!feature || feature.kind !== "hole") return null;
  const place = feature.places[0];
  return (
    <Section title={feature.name}>
      <NumField
        label="Diameter"
        value={resolveRef(feature.diameter, feature.diameterRef, doc.parameters)}
        min={0.2}
        onChange={(diameter) => useCad.getState().patchHole(id, { diameter })}
      />
      <Toggle on={feature.depth == null} label="Through All" onClick={() => useCad.getState().patchHole(id, { depth: feature.depth == null ? 8 : null })} />
      {feature.depth != null && (
        <NumField label="Depth" value={feature.depth} min={0.2} onChange={(depth) => useCad.getState().patchHole(id, { depth })} />
      )}
      {place?.mode === "abs" && (
        <>
          <NumField label="X" value={resolveRef(place.x, place.xRef, doc.parameters)} onChange={(x) => updateAbs(id, place, { x })} />
          <NumField label="Y" value={resolveRef(place.y, place.yRef, doc.parameters)} onChange={(y) => updateAbs(id, place, { y })} />
          {feature.places.length === 1 && (
            <button type="button" className="h-10 rounded-sm border border-border text-sm" onClick={() => useCad.getState().makePattern(id)}>
              Circular pattern ×6
            </button>
          )}
        </>
      )}
      {place?.mode === "pcd" && (
        <>
          <NumField
            label="Bolt circle"
            value={resolveRef(place.pcd, place.pcdRef, doc.parameters)}
            min={1}
            onChange={(pcd) => useCad.getState().patchHolePlace(id, 0, { ...place, pcd, pcdRef: undefined })}
          />
          <NumField
            label="Count"
            unit="шт"
            value={resolveRef(place.count, place.countRef, doc.parameters)}
            min={1}
            max={24}
            onChange={(count) => useCad.getState().patchHolePlace(id, 0, { ...place, count: Math.round(count), countRef: undefined })}
          />
        </>
      )}
      {place?.mode === "inset" && (
        <>
          <NumField
            label="Inset X"
            value={resolveRef(place.insetX, place.insetXRef, doc.parameters)}
            onChange={(insetX) => writeInset(id, "insetX", insetX)}
          />
          <NumField
            label="Inset Y"
            value={resolveRef(place.insetY, place.insetYRef, doc.parameters)}
            onChange={(insetY) => writeInset(id, "insetY", insetY)}
          />
          <p className="text-sm text-muted">{feature.places.length} holes from the contour corners.</p>
        </>
      )}
    </Section>
  );
}

function writeInset(id: string, key: "insetX" | "insetY", value: number) {
  const state = useCad.getState();
  const doc = state.docs.find((d) => d.id === state.activeId);
  const feature = doc?.features.find((f) => f.id === id);
  if (!feature || feature.kind !== "hole") return;
  const first = feature.places.find((p) => p.mode === "inset");
  if (!first || first.mode !== "inset") return;
  const ref = key === "insetX" ? first.insetXRef : first.insetYRef;
  if (ref) {
    const scale = ref.scale ?? 1;
    state.setParam(ref.paramId, scale === 0 ? value : (value - (ref.offset ?? 0)) / scale);
    return;
  }
  feature.places.forEach((place, index) => {
    if (place.mode !== "inset") return;
    state.patchHolePlace(id, index, { ...place, [key]: value });
  });
}

function updateAbs(id: string, place: Extract<HolePlace, { mode: "abs" }>, patch: { x?: number; y?: number }) {
  const doc = useCad.getState().docs.find((d) => d.id === useCad.getState().activeId);
  if (!doc) return;
  const x = patch.x ?? resolveRef(place.x, place.xRef, doc.parameters);
  const y = patch.y ?? resolveRef(place.y, place.yRef, doc.parameters);
  useCad.getState().patchHolePlace(id, 0, { mode: "abs", x, y });
}

function constraintLabel(c: Sketch["constraints"][number]): string {
  if (c.type === "h") return "Horizontal";
  if (c.type === "v") return "Vertical";
  if (c.type === "dist") return "Dimension";
  if (c.type === "radius") return c.display === "diameter" ? "Diameter" : "Radius";
  if (c.type === "fixed") return "Fix";
  if (c.type === "equal") return "Equal";
  if (c.type === "parallel") return "Parallel";
  if (c.type === "perp") return "Perpendicular";
  if (c.type === "coincident") return "Coincident";
  if (c.type === "sum0") return "Symmetric";
  return `Coordinate ${c.axis.toUpperCase()}`;
}

function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}
