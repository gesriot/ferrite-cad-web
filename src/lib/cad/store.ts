import { create } from "zustand";
import { buildModel } from "./build";
import { evaluate, hasConflict, mergeSolved } from "./evaluate";
import { coerceParameterValue } from "./format";
import { makeSamples } from "./samples";
import { download, geometriesToStl, safeName } from "./stl";
import type { ChamferFeature, Constraint, Doc, FilletFeature, HoleFeature, HolePlace, ParamRef, Plane, Sel, Sketch, SolidFeature, SolveReport, Tool } from "./types";
import { uid } from "./types";

export type SnapStep = 0 | 0.1 | 1 | 5 | 10;
export type FrameMode = "all" | "sel";

export type OcctMesh = { positions: Float32Array; normals: Float32Array; indices: Uint32Array };

export type ExchangeModel = {
  planeName: string;
  sketchName: string;
  curveCount: number;
  extrudeName: string;
  distanceSource: string;
  distanceMm: number;
  bodyName: string;
  area: number;
};

export type ExchangeView = {
  kind: "fcad" | "step";
  fileName: string;
  editable: boolean;
  dirty: boolean;
  busy: boolean;
  refusal: string | null;
  message: string;
  volume: number | null;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  model: ExchangeModel | null;
};

export type GateActionId = "download" | "download-source" | "cancel" | "discard";

export type DocumentGate = {
  title: string;
  body: string;
  actions: { id: GateActionId; label: string }[];
};

type History = { docs: Doc[]; activeId: string };

export type CadState = {
  docs: Doc[];
  activeId: string;
  reports: Record<string, SolveReport>;
  evalDoc: Doc;
  selection: Sel | null;
  past: History[];
  future: History[];
  gesturing: boolean;
  tool: Tool;
  snap: SnapStep;
  workPlane: Plane;
  workOffset: number;
  projection: "persp" | "ortho";
  showSketches: boolean;
  showGrid: boolean;
  hiddenIds: string[];
  isolateId: string | null;
  holeDia: number;
  holeThrough: boolean;
  holeDepth: number;
  filletRadius: number;
  chamferDist: number;
  message: string;
  issues: string[];
  drawer: "tree" | "inspector" | null;
  helpOpen: boolean;
  frameTick: number;
  frameMode: FrameMode;
  poly: { x: number; y: number }[];
  geomTick: number;
  occtStatus: string;
  occtMesh: OcctMesh | null;
  exchange: ExchangeView | null;
  transition: DocumentGate | null;
};

type Actions = {
  setTool: (tool: Tool) => void;
  setSnap: (snap: SnapStep) => void;
  setWorkPlane: (workPlane: Plane) => void;
  setWorkOffset: (workOffset: number) => void;
  setProjection: (projection: "persp" | "ortho") => void;
  toggleSketches: () => void;
  toggleGrid: () => void;
  flash: (message: string) => void;
  setIssues: (issues: string[]) => void;
  setOcct: (occtMesh: OcctMesh | null, occtStatus: string) => void;
  setExchange: (exchange: ExchangeView | null) => void;
  setTransition: (transition: DocumentGate | null) => void;
  setDrawer: (drawer: CadState["drawer"]) => void;
  setHelp: (helpOpen: boolean) => void;
  select: (selection: Sel | null) => void;
  frame: (frameMode: FrameMode) => void;
  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  focusDoc: (id: string) => void;
  newDoc: () => void;
  closeDoc: (id: string) => void;
  renameDoc: (name: string) => void;
  openSample: (id: string) => void;
  restoreSamples: () => void;
  importDoc: (raw: unknown) => void;
  exportJSON: () => void;
  exportSTL: () => void;
  setParam: (id: string, value: number) => void;
  renameParam: (id: string, name: string) => void;
  addParam: () => void;
  deleteParam: (id: string) => void;
  deleteSelection: () => void;
  addRect: (x0: number, y0: number, x1: number, y1: number) => void;
  addCircle: (cx: number, cy: number, r: number) => void;
  addPoly: (pts: { x: number; y: number }[]) => void;
  pushPoly: (p: { x: number; y: number }) => void;
  popPoly: () => void;
  clearPoly: () => void;
  addHole: (plane: Plane, offset: number, x: number, y: number, travel: 1 | -1) => void;
  addFillet: () => void;
  addChamfer: () => void;
  dragPoint: (sketchId: string, pointId: string, x: number, y: number) => void;
  setConstraintValue: (sketchId: string, constraintId: string, value: number) => void;
  deleteConstraint: (sketchId: string, constraintId: string) => void;
  addEdgeConstraint: (sketchId: string, loopId: string, index: number, kind: "h" | "v" | "dist" | "fix") => void;
  setSketchOffset: (id: string, offset: number) => void;
  setSketchPlane: (id: string, plane: Plane) => void;
  patchSolid: (id: string, part: Partial<Pick<SolidFeature, "depth" | "angle" | "mode" | "symmetric" | "flipped" | "axis" | "operation" | "name">>) => void;
  patchHole: (id: string, part: Partial<Pick<HoleFeature, "diameter" | "depth" | "travel" | "name">>) => void;
  patchHolePlace: (id: string, index: number, place: HolePlace) => void;
  makePattern: (id: string) => void;
  patchFillet: (id: string, radius: number) => void;
  patchChamfer: (id: string, distance: number) => void;
  setHoleDraft: (part: Partial<Pick<CadState, "holeDia" | "holeThrough" | "holeDepth" | "filletRadius" | "chamferDist">>) => void;
  toggleHidden: (id?: string) => void;
  showAll: () => void;
  isolate: () => void;
};

const KEY = "ferrite-cad-v1";
function isDoc(v: unknown): v is Doc {
  if (!v || typeof v !== "object") return false;
  const d = v as Doc;
  return typeof d.id === "string" && typeof d.name === "string" && Array.isArray(d.sketches) && Array.isArray(d.features) && Array.isArray(d.parameters);
}
function loadSaved(): { docs: Doc[]; activeId: string } | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { v?: number; docs?: unknown; activeId?: string };
    if (data.v !== 1 || !Array.isArray(data.docs)) return null;
    const docs = data.docs.filter(isDoc);
    if (!docs.length) return null;
    return {
      docs,
      activeId: docs.some((d) => d.id === data.activeId) && data.activeId ? data.activeId : docs[0].id
    };
  } catch {
    return null;
  }
}
function sameDocs(a: Doc[], b: Doc[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function boot(): Pick<CadState, "docs" | "activeId" | "reports" | "evalDoc" | "selection"> {
  const saved = loadSaved();
  const docs = saved?.docs ?? makeSamples();
  const activeId = saved?.activeId ?? docs[0].id;
  const doc = docs.find((d) => d.id === activeId) ?? docs[0];
  const ev = evaluate(doc);
  const selection: Sel | null = doc.features.some((f) => f.id === "solid-flange") ? {
    kind: "feature",
    id: "solid-flange"
  } : null;
  return {
    docs,
    activeId: doc.id,
    reports: ev.reports,
    evalDoc: ev.doc,
    selection: doc.id === "doc-flange" ? selection : null
  };
}
const booted = boot();
export const useCad = create<CadState & Actions>((set, get) => {
  const remember = (history?: boolean) => {
    const s = get();
    if (!history || s.gesturing) return {
      past: s.past,
      future: s.future
    };
    return {
      past: [...s.past, {
        docs: s.docs,
        activeId: s.activeId
      }].slice(-40),
      future: [] as History[]
    };
  };
  const write = (next: Doc, history?: boolean, extra?: { sketchId: string; pins: { id: string; x: number; y: number }[] }) => {
    const ev = evaluate(next, extra);
    if (hasConflict(ev.reports)) {
      get().flash("Constraints conflict with each other");
      return false;
    }
    const merged = {
      ...next,
      sketches: next.sketches.map((s) => {
        const solved = ev.doc.sketches.find((k) => k.id === s.id);
        return solved ? mergeSolved(s, solved) : s;
      })
    };
    const ev2 = evaluate(merged);
    if (hasConflict(ev2.reports)) {
      get().flash("Constraints conflict with each other");
      return false;
    }
    const hist = remember(history);
    set({
      docs: get().docs.map((d) => d.id === merged.id ? merged : d),
      ...hist,
      reports: ev2.reports,
      evalDoc: ev2.doc,
      geomTick: get().geomTick + 1,
      message: ""
    });
    return true;
  };
  const patch = (recipe: (doc: Doc) => void, history = true) => {
    if (get().exchange) {
      get().flash("Another document is active — the command is not applied to the hidden model.");
      return false;
    }
    const current = get().docs.find((d) => d.id === get().activeId);
    if (!current) return false;
    const next = structuredClone(current);
    recipe(next);
    return write(next, history);
  };
  const openInspector = () => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) set({ drawer: "inspector" });
  };
  return {
    ...booted,
    past: [],
    future: [],
    gesturing: false,
    tool: "select",
    snap: 1,
    workPlane: "XY",
    workOffset: 0,
    projection: "persp",
    showSketches: true,
    showGrid: true,
    hiddenIds: [],
    isolateId: null,
    holeDia: 6,
    holeThrough: true,
    holeDepth: 8,
    filletRadius: 2,
    chamferDist: 1.5,
    message: "",
    issues: [],
    drawer: null,
    helpOpen: false,
    frameTick: 1,
    frameMode: "all",
    poly: [],
    geomTick: 1,
    occtStatus: "",
    occtMesh: null,
    exchange: null,
    transition: null,
    setTool: (tool) => set({
      tool,
      poly: tool === "poly" ? get().poly : []
    }),
    setSnap: (snap) => set({ snap }),
    setWorkPlane: (workPlane) => set({ workPlane }),
    setWorkOffset: (workOffset) => set({ workOffset }),
    setProjection: (projection) => set({ projection }),
    toggleSketches: () => set({ showSketches: !get().showSketches }),
    toggleGrid: () => set({ showGrid: !get().showGrid }),
    flash: (message) => {
      clearTimeout(flashTimer);
      set({ message });
      flashTimer = setTimeout(() => set({ message: "" }), 3800);
    },
    setIssues: (issues) => set({ issues }),
    setOcct: (occtMesh, occtStatus) => set({
      occtMesh,
      occtStatus
    }),
    setExchange: (exchange) => set({
      exchange,
      selection: null,
      poly: [],
      ...exchange ? {
        hiddenIds: [],
        isolateId: null
      } : {}
    }),
    setTransition: (transition) => set({ transition }),
    setDrawer: (drawer) => set({ drawer }),
    setHelp: (helpOpen) => set({ helpOpen }),
    select: (selection) => {
      if (get().exchange) return;
      set({ selection });
    },
    frame: (frameMode) => set({
      frameMode,
      frameTick: get().frameTick + 1
    }),
    beginGesture: () => {
      if (get().exchange) return;
      const s = get();
      if (s.gesturing) return;
      set({
        gesturing: true,
        past: [...s.past, {
          docs: s.docs,
          activeId: s.activeId
        }].slice(-40),
        future: []
      });
    },
    endGesture: () => {
      const s = get();
      const last = s.past[s.past.length - 1];
      set({
        gesturing: false,
        past: last && last.activeId === s.activeId && sameDocs(last.docs, s.docs) ? s.past.slice(0, -1) : s.past
      });
    },
    undo: () => {
      const s = get();
      if (s.exchange) {
        s.flash("Example undo is unavailable while another document is open.");
        return;
      }
      const prev = s.past[s.past.length - 1];
      if (!prev || s.gesturing) return;
      const doc = prev.docs.find((d) => d.id === prev.activeId) ?? prev.docs[0];
      const ev = evaluate(doc);
      set({
        docs: prev.docs,
        activeId: doc.id,
        past: s.past.slice(0, -1),
        future: [...s.future, {
          docs: s.docs,
          activeId: s.activeId
        }],
        reports: ev.reports,
        evalDoc: ev.doc,
        geomTick: s.geomTick + 1,
        selection: null,
        poly: [],
        frameTick: s.frameTick + 1,
        frameMode: "all"
      });
    },
    redo: () => {
      const s = get();
      if (s.exchange) {
        s.flash("Example redo is unavailable while another document is open.");
        return;
      }
      const next = s.future[s.future.length - 1];
      if (!next || s.gesturing) return;
      const doc = next.docs.find((d) => d.id === next.activeId) ?? next.docs[0];
      const ev = evaluate(doc);
      set({
        docs: next.docs,
        activeId: doc.id,
        future: s.future.slice(0, -1),
        past: [...s.past, {
          docs: s.docs,
          activeId: s.activeId
        }].slice(-40),
        reports: ev.reports,
        evalDoc: ev.doc,
        geomTick: s.geomTick + 1,
        selection: null,
        poly: [],
        frameTick: s.frameTick + 1,
        frameMode: "all"
      });
    },
    focusDoc: (id) => {
      if (get().exchange) {
        get().flash("Close the open document first.");
        return;
      }
      const doc = get().docs.find((d) => d.id === id);
      if (!doc) return;
      const ev = evaluate(doc);
      set({
        activeId: id,
        reports: ev.reports,
        evalDoc: ev.doc,
        geomTick: get().geomTick + 1,
        selection: null,
        poly: [],
        hiddenIds: [],
        isolateId: null,
        frameTick: get().frameTick + 1,
        frameMode: "all",
        drawer: null
      });
    },
    newDoc: () => {
      if (get().exchange) {
        get().flash("Close the open document first.");
        return;
      }
      const s = get();
      const doc = {
        id: uid("doc"),
        name: `Part ${s.docs.length + 1}`,
        unit: "mm" as const,
        parameters: [],
        sketches: [],
        features: []
      };
      const ev = evaluate(doc);
      set({
        past: [...s.past, {
          docs: s.docs,
          activeId: s.activeId
        }].slice(-40),
        future: [],
        docs: [...s.docs, doc],
        activeId: doc.id,
        reports: ev.reports,
        evalDoc: ev.doc,
        geomTick: s.geomTick + 1,
        selection: null,
        poly: [],
        tool: "rect",
        frameTick: s.frameTick + 1,
        frameMode: "all"
      });
    },
    closeDoc: (id) => {
      if (get().exchange) {
        get().flash("Close the open document first.");
        return;
      }
      const s = get();
      const docs = s.docs.filter((d) => d.id !== id);
      const nextDocs = docs.length ? docs : [{
        id: uid("doc"),
        name: "Part",
        unit: "mm" as const,
        parameters: [],
        sketches: [],
        features: []
      }];
      const activeId = s.activeId === id ? nextDocs[0].id : s.activeId;
      const doc = nextDocs.find((d) => d.id === activeId) ?? nextDocs[0];
      const ev = evaluate(doc);
      set({
        past: [...s.past, {
          docs: s.docs,
          activeId: s.activeId
        }].slice(-40),
        future: [],
        docs: nextDocs,
        activeId: doc.id,
        reports: ev.reports,
        evalDoc: ev.doc,
        geomTick: s.geomTick + 1,
        selection: null
      });
    },
    renameDoc: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      patch((doc) => {
        doc.name = trimmed.slice(0, 48);
      });
    },
    openSample: (id) => {
      if (get().exchange) {
        get().flash("Close the open document first.");
        return;
      }
      if (get().docs.find((d) => d.id === id)) {
        get().focusDoc(id);
        return;
      }
      const sample = makeSamples().find((d) => d.id === id);
      if (!sample) return;
      const s = get();
      const docs = [...s.docs, structuredClone(sample)];
      const ev = evaluate(sample);
      set({
        past: [...s.past, {
          docs: s.docs,
          activeId: s.activeId
        }].slice(-40),
        future: [],
        docs,
        activeId: sample.id,
        reports: ev.reports,
        evalDoc: ev.doc,
        geomTick: s.geomTick + 1,
        selection: null,
        frameTick: s.frameTick + 1,
        frameMode: "all"
      });
    },
    restoreSamples: () => {
      if (get().exchange) {
        get().flash("Close the open document first.");
        return;
      }
      const s = get();
      const docs = makeSamples();
      const ev = evaluate(docs[0]);
      set({
        past: [...s.past, {
          docs: s.docs,
          activeId: s.activeId
        }].slice(-40),
        future: [],
        docs,
        activeId: docs[0].id,
        reports: ev.reports,
        evalDoc: ev.doc,
        selection: {
          kind: "feature",
          id: "solid-flange"
        },
        geomTick: s.geomTick + 1,
        hiddenIds: [],
        isolateId: null,
        frameTick: s.frameTick + 1,
        frameMode: "all",
        message: "Examples restored"
      });
    },
    importDoc: (raw) => {
      if (get().exchange) {
        get().flash("Close the open document first.");
        return;
      }
      const candidate = raw && typeof raw === "object" && "sketches" in raw ? raw : null;
      if (!isDoc(candidate)) {
        get().flash("This is not a Ferrite document");
        return;
      }
      const s = get();
      const doc = structuredClone(candidate);
      if (s.docs.some((d) => d.id === doc.id)) doc.id = uid("doc");
      const ev = evaluate(doc);
      if (hasConflict(ev.reports)) {
        get().flash("The file has conflicting constraints");
        return;
      }
      set({
        past: [...s.past, {
          docs: s.docs,
          activeId: s.activeId
        }].slice(-40),
        future: [],
        docs: [...s.docs, doc],
        activeId: doc.id,
        reports: ev.reports,
        evalDoc: ev.doc,
        geomTick: s.geomTick + 1,
        selection: null,
        frameTick: s.frameTick + 1,
        frameMode: "all"
      });
    },
    exportJSON: () => {
      if (get().exchange) {
        get().flash("Another document is on screen. The example JSON is not saved.");
        return;
      }
      const doc = get().docs.find((d) => d.id === get().activeId);
      if (!doc) return;
      download(`${safeName(doc.name)}.ferrite.json`, JSON.stringify(doc, null, 2), "application/json");
    },
    exportSTL: () => {
      if (get().exchange) {
        get().flash("Use Export STEP for this document.");
        return;
      }
      const { evalDoc, hiddenIds, isolateId } = get();
      const hidden = new Set(hiddenIds);
      if (isolateId) {
        for (const feature of evalDoc.features) if (feature.id !== isolateId) hidden.add(feature.id);
      }
      const built = buildModel(evalDoc, hidden);
      if (!built.bodies.length) {
        get().flash("Nothing to export");
        return;
      }
      const buf = geometriesToStl(built.bodies.map((b) => b.geometry));
      for (const body of built.bodies) body.geometry.dispose();
      download(`${safeName(evalDoc.name)}.stl`, buf, "model/stl");
      get().flash("STL saved");
    },
    setParam: (id, value) => {
      if (!Number.isFinite(value)) return;
      patch((doc) => {
        const p = doc.parameters.find((item) => item.id === id);
        if (!p) return;
        p.value = coerceParameterValue(p.unit, value);
      });
    },
    renameParam: (id, name) => patch((doc) => {
      const p = doc.parameters.find((item) => item.id === id);
      if (p && name.trim()) p.name = name.trim().slice(0, 32);
    }),
    addParam: () => patch((doc) => {
      doc.parameters.push({
        id: uid("p"),
        name: `Parameter ${doc.parameters.length + 1}`,
        value: 10,
        unit: "мм"
      });
    }),
    deleteParam: (id) => patch((doc) => {
      doc.parameters = doc.parameters.filter((p) => p.id !== id);
    }),
    deleteSelection: () => {
      if (get().exchange) {
        get().flash("Delete is blocked while the example is hidden.");
        return;
      }
      const sel = get().selection;
      if (!sel) return;
      if (sel.kind === "point" || sel.kind === "edge") {
        get().flash("Delete a feature in the tree or remove a constraint");
        return;
      }
      if (patch((doc) => {
        if (sel.kind === "sketch") {
          const solids = doc.features.filter((f) => f.kind === "solid" && f.sketchId === sel.id).map((f) => f.id);
          doc.features = doc.features.filter((f) => {
            if (f.kind === "solid" && f.sketchId === sel.id) return false;
            if ((f.kind === "fillet" || f.kind === "chamfer") && solids.includes(f.targetId)) return false;
            return true;
          });
          doc.sketches = doc.sketches.filter((s) => s.id !== sel.id);
        } else {
          const feature = doc.features.find((f) => f.id === sel.id);
          doc.features = doc.features.filter((f) => {
            if (f.id === sel.id) return false;
            if (feature?.kind === "solid" && (f.kind === "fillet" || f.kind === "chamfer") && f.targetId === feature.id) return false;
            return true;
          });
        }
      })) set({ selection: null });
    },
    addRect: (x0, y0, x1, y1) => {
      const xL = Math.min(x0, x1);
      const xR = Math.max(x0, x1);
      const yB = Math.min(y0, y1);
      const yT = Math.max(y0, y1);
      if (xR - xL < .4 || yT - yB < .4) {
        get().flash("Rectangle is too small");
        return;
      }
      const ids = [
        uid("pt"),
        uid("pt"),
        uid("pt"),
        uid("pt")
      ];
      const sid = uid("sk");
      const solid = blankSolid(sid, "Extrude");
      const sketch = {
        id: sid,
        name: "Rectangle",
        plane: get().workPlane,
        offset: get().workOffset,
        points: [
          {
            id: ids[0],
            x: xL,
            y: yB
          },
          {
            id: ids[1],
            x: xR,
            y: yB
          },
          {
            id: ids[2],
            x: xR,
            y: yT
          },
          {
            id: ids[3],
            x: xL,
            y: yT
          }
        ],
        loops: [{
          id: uid("loop"),
          kind: "poly" as const,
          pointIds: ids
        }],
        constraints: [
          {
            id: uid("c"),
            type: "h",
            a: ids[0],
            b: ids[1]
          },
          {
            id: uid("c"),
            type: "v",
            a: ids[1],
            b: ids[2]
          },
          {
            id: uid("c"),
            type: "h",
            a: ids[2],
            b: ids[3]
          },
          {
            id: uid("c"),
            type: "v",
            a: ids[3],
            b: ids[0]
          },
          {
            id: uid("c"),
            type: "dist",
            a: ids[0],
            b: ids[1],
            value: +(xR - xL).toFixed(3)
          },
          {
            id: uid("c"),
            type: "dist",
            a: ids[0],
            b: ids[3],
            value: +(yT - yB).toFixed(3)
          },
          {
            id: uid("c"),
            type: "fixed",
            pointId: ids[0],
            x: xL,
            y: yB
          }
        ]
      };
      if (patch((doc) => {
        sketch.name = `Sketch ${doc.sketches.length + 1}`;
        solid.name = `Extrude ${doc.features.filter((f) => f.kind === "solid").length + 1}`;
        doc.sketches.push(sketch as Sketch);
        doc.features.push(solid);
      })) {
        set({
          selection: {
            kind: "feature",
            id: solid.id
          },
          tool: "select"
        });
        openInspector();
      }
    },
    addCircle: (cx, cy, r) => {
      if (r < .3) {
        get().flash("Circle is too small");
        return;
      }
      const cid = uid("pt");
      const sid = uid("sk");
      const lid = uid("loop");
      const solid = blankSolid(sid, "Extrude");
      const sketch = {
        id: sid,
        name: "Circle",
        plane: get().workPlane,
        offset: get().workOffset,
        points: [{
          id: cid,
          x: cx,
          y: cy
        }],
        loops: [{
          id: lid,
          kind: "circle" as const,
          centerId: cid,
          radius: r
        }],
        constraints: [{
          id: uid("c"),
          type: "fixed",
          pointId: cid,
          x: cx,
          y: cy
        }, {
          id: uid("c"),
          type: "radius",
          loopId: lid,
          value: +r.toFixed(3),
          display: "diameter"
        }]
      };
      if (patch((doc) => {
        sketch.name = `Sketch ${doc.sketches.length + 1}`;
        solid.name = `Extrude ${doc.features.filter((f) => f.kind === "solid").length + 1}`;
        doc.sketches.push(sketch as Sketch);
        doc.features.push(solid);
      })) {
        set({
          selection: {
            kind: "feature",
            id: solid.id
          },
          tool: "select"
        });
        openInspector();
      }
    },
    addPoly: (pts) => {
      if (pts.length < 3) {
        get().flash("At least three points are required");
        return;
      }
      const ids = pts.map(() => uid("pt"));
      const sid = uid("sk");
      const solid = blankSolid(sid, "Extrude");
      const constraints: Constraint[] = [{
        id: uid("c"),
        type: "fixed",
        pointId: ids[0]!,
        x: pts[0]!.x,
        y: pts[0]!.y
      }];
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const ang = Math.abs(Math.atan2(dy, dx));
        if (ang < .12 || Math.abs(ang - Math.PI) < .12) constraints.push({
          id: uid("c"),
          type: "h",
          a: ids[i],
          b: ids[(i + 1) % ids.length]
        });
        if (Math.abs(ang - Math.PI / 2) < .12) constraints.push({
          id: uid("c"),
          type: "v",
          a: ids[i],
          b: ids[(i + 1) % ids.length]
        });
      });
      const sketch = {
        id: sid,
        name: "Polygon",
        plane: get().workPlane,
        offset: get().workOffset,
        points: pts.map((p, i) => ({
          id: ids[i],
          x: p.x,
          y: p.y
        })),
        loops: [{
          id: uid("loop"),
          kind: "poly" as const,
          pointIds: ids
        }],
        constraints
      };
      if (patch((doc) => {
        sketch.name = `Sketch ${doc.sketches.length + 1}`;
        solid.name = `Extrude ${doc.features.filter((f) => f.kind === "solid").length + 1}`;
        doc.sketches.push(sketch as Sketch);
        doc.features.push(solid);
      })) set({
        selection: {
          kind: "feature",
          id: solid.id
        },
        tool: "select",
        poly: []
      });
      openInspector();
    },
    pushPoly: (p) => set({ poly: [...get().poly, p] }),
    popPoly: () => set({ poly: get().poly.slice(0, -1) }),
    clearPoly: () => set({ poly: [] }),
    addHole: (plane, offset, x, y, travel) => {
      const s = get();
      const hole = {
        id: uid("hole"),
        kind: "hole" as const,
        name: "Hole",
        plane,
        offset,
        travel,
        diameter: s.holeDia,
        depth: s.holeThrough ? null : s.holeDepth,
        places: [{
          mode: "abs" as const,
          x,
          y
        }]
      };
      if (patch((doc) => {
        hole.name = `Hole ${doc.features.filter((f) => f.kind === "hole").length + 1}`;
        doc.features.push(hole as HoleFeature);
      })) {
        set({ selection: {
          kind: "feature",
          id: hole.id
        } });
        openInspector();
      }
    },
    addFillet: () => addRound(get, patch, set, "fillet", openInspector),
    addChamfer: () => addRound(get, patch, set, "chamfer", openInspector),
    dragPoint: (sketchId, pointId, x, y) => {
      const current = get().docs.find((d) => d.id === get().activeId);
      if (!current) return;
      const next = structuredClone(current);
      const sketch = next.sketches.find((s) => s.id === sketchId);
      const pt = sketch?.points.find((p) => p.id === pointId);
      if (!sketch || !pt) return;
      const fixed = sketch.constraints.find((c) => c.type === "fixed" && c.pointId === pointId);
      if (fixed && fixed.type === "fixed") {
        fixed.x = x;
        fixed.y = y;
      }
      pt.x = x;
      pt.y = y;
      if (!write(next, true, {
        sketchId,
        pins: [{
          id: pointId,
          x,
          y
        }]
      })) get().flash("The point is driven by a dimension — edit the number");
    },
    setConstraintValue: (sketchId, constraintId, value) => {
      if (!Number.isFinite(value)) return;
      patch((doc) => {
        const c = doc.sketches.find((s) => s.id === sketchId)?.constraints.find((item) => item.id === constraintId);
        if (!c) return;
        if (c.type === "dist" || c.type === "radius" || c.type === "coord") {
          if (c.ref) {
            const ref = c.ref;
            const p = doc.parameters.find((item) => item.id === ref.paramId);
            if (p) {
              const scale = ref.scale ?? 1;
              p.value = scale === 0 ? value : (value - (ref.offset ?? 0)) / scale;
              p.value = coerceParameterValue(p.unit, p.value);
            }
          } else c.value = value;
        }
        if (c.type === "fixed") {
              /* edited via point */
            }
      });
    },
    deleteConstraint: (sketchId, constraintId) => patch((doc) => {
      const sketch = doc.sketches.find((s) => s.id === sketchId);
      if (sketch) sketch.constraints = sketch.constraints.filter((c) => c.id !== constraintId);
    }),
    addEdgeConstraint: (sketchId, loopId, index, kind) => {
      patch((doc) => {
        const sketch = doc.sketches.find((s) => s.id === sketchId);
        const loop = sketch?.loops.find((l) => l.id === loopId);
        if (!sketch || !loop || loop.kind !== "poly") return;
        const a = loop.pointIds[index];
        const b = loop.pointIds[(index + 1) % loop.pointIds.length];
        const pa = sketch.points.find((p) => p.id === a);
        const pb = sketch.points.find((p) => p.id === b);
        if (!a || !b || !pa || !pb) return;
        if (kind === "fix") {
          if (!sketch.constraints.some((c) => c.type === "fixed" && c.pointId === a)) sketch.constraints.push({
            id: uid("c"),
            type: "fixed",
            pointId: a,
            x: pa.x,
            y: pa.y
          });
          return;
        }
        if (kind === "h" || kind === "v") {
          if (sketch.constraints.some((c) => c.type === kind && (c.a === a && c.b === b || c.a === b && c.b === a))) return;
          sketch.constraints.push({
            id: uid("c"),
            type: kind,
            a,
            b
          });
          return;
        }
        const value = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        sketch.constraints.push({
          id: uid("c"),
          type: "dist",
          a,
          b,
          value: +value.toFixed(3)
        });
      });
    },
    setSketchOffset: (id, offset) => patch((doc) => {
      const sketch = doc.sketches.find((s) => s.id === id);
      if (!sketch) return;
      if (sketch.offsetRef) {
        const ref = sketch.offsetRef;
        const p = doc.parameters.find((item) => item.id === ref.paramId);
        if (p) {
          const scale = ref.scale ?? 1;
          p.value = scale === 0 ? offset : (offset - (ref.offset ?? 0)) / scale;
        }
      } else sketch.offset = offset;
    }),
    setSketchPlane: (id, plane) => patch((doc) => {
      const sketch = doc.sketches.find((s) => s.id === id);
      if (sketch) sketch.plane = plane;
    }),
    patchSolid: (id, part) => patch((doc) => {
      const feature = doc.features.find((f) => f.id === id);
      if (!feature || feature.kind !== "solid") return;
      if (part.depth != null) {
        if (feature.depthRef) writeRef(doc, feature.depthRef, part.depth);
        else feature.depth = Math.max(.05, part.depth);
      }
      if (part.angle != null) feature.angle = Math.min(360, Math.max(.1, part.angle));
      if (part.mode) feature.mode = part.mode;
      if (part.symmetric != null) feature.symmetric = part.symmetric;
      if (part.flipped != null) feature.flipped = part.flipped;
      if (part.axis) feature.axis = part.axis;
      if (part.operation) feature.operation = part.operation;
      if (part.name) feature.name = part.name.slice(0, 48);
    }),
    patchHole: (id, part) => patch((doc) => {
      const feature = doc.features.find((f) => f.id === id);
      if (!feature || feature.kind !== "hole") return;
      if (part.diameter != null) {
        if (feature.diameterRef) writeRef(doc, feature.diameterRef, part.diameter);
        else feature.diameter = Math.max(.2, part.diameter);
      }
      if (part.depth !== undefined) feature.depth = part.depth == null ? null : Math.max(.1, part.depth);
      if (part.travel) feature.travel = part.travel;
      if (part.name) feature.name = part.name.slice(0, 48);
    }),
    patchHolePlace: (id, index, place) => patch((doc) => {
      const feature = doc.features.find((f) => f.id === id);
      if (!feature || feature.kind !== "hole" || !feature.places[index]) return;
      feature.places[index] = place;
    }),
    makePattern: (id) => patch((doc) => {
      const feature = doc.features.find((f) => f.id === id);
      if (!feature || feature.kind !== "hole") return;
      const place = feature.places[0];
      if (!place || place.mode !== "abs") return;
      feature.places = [{
        mode: "pcd",
        cx: 0,
        cy: 0,
        pcd: +Math.max(1, Math.hypot(place.x, place.y) * 2).toFixed(3),
        count: 6,
        startDeg: 0
      }];
      feature.name = "Pattern";
    }),
    patchFillet: (id, radius) => patch((doc) => {
      const feature = doc.features.find((f) => f.id === id);
      if (!feature || feature.kind !== "fillet") return;
      if (feature.radiusRef) writeRef(doc, feature.radiusRef, radius);
      else feature.radius = Math.max(0, radius);
    }),
    patchChamfer: (id, distance) => patch((doc) => {
      const feature = doc.features.find((f) => f.id === id);
      if (!feature || feature.kind !== "chamfer") return;
      if (feature.distanceRef) writeRef(doc, feature.distanceRef, distance);
      else feature.distance = Math.max(0, distance);
    }),
    setHoleDraft: (part) => set(part),
    toggleHidden: (id) => {
      if (get().exchange) {
        get().flash("Hide applies to another document and is not run.");
        return;
      }
      const sel = get().selection;
      const target = id ?? (sel && (sel.kind === "feature" || sel.kind === "sketch") ? sel.id : undefined);
      if (!target) return;
      const hidden = new Set(get().hiddenIds);
      if (hidden.has(target)) hidden.delete(target);
      else hidden.add(target);
      set({
        hiddenIds: [...hidden],
        geomTick: get().geomTick + 1
      });
    },
    showAll: () => {
      if (get().exchange) {
        get().flash("Show applies to another document and is not run.");
        return;
      }
      set({
        hiddenIds: [],
        isolateId: null,
        geomTick: get().geomTick + 1
      });
    },
    isolate: () => {
      if (get().exchange) {
        get().flash("Isolate applies to another document and is not run.");
        return;
      }
      const sel = get().selection;
      const id = sel && (sel.kind === "feature" || sel.kind === "sketch") ? sel.id : null;
      set({
        isolateId: get().isolateId === id ? null : id,
        geomTick: get().geomTick + 1
      });
    }
  };
});
function writeRef(doc: Doc, ref: ParamRef, value: number) {
  const p = doc.parameters.find((item) => item.id === ref.paramId);
  if (!p) return;
  const scale = ref.scale ?? 1;
  p.value = scale === 0 ? value : (value - (ref.offset ?? 0)) / scale;
  p.value = coerceParameterValue(p.unit, p.value);
}
function blankSolid(sketchId: string, name: string): SolidFeature {
  return {
    id: uid("solid"),
    kind: "solid",
    name,
    sketchId,
    mode: "extrude",
    depth: 10,
    symmetric: false,
    flipped: false,
    angle: 360,
    axis: "Y",
    operation: "new"
  };
}
function addRound(get: () => CadState & Actions, patch: (recipe: (doc: Doc) => void, history?: boolean) => boolean, set: (partial: Partial<CadState>) => void, kind: "fillet" | "chamfer", openInspector: () => void) {
  const s = get();
  const doc = s.docs.find((d) => d.id === s.activeId);
  if (!doc) return;
  const sel = s.selection;
  const selected = sel?.kind === "feature" ? doc.features.find((f) => f.id === sel.id) : undefined;
  const solids = doc.features.filter((f) => f.kind === "solid");
  const target = selected?.kind === "solid" ? selected : selected?.kind === "fillet" || selected?.kind === "chamfer" ? solids.find((f) => f.id === selected.targetId) : solids[solids.length - 1];
  if (!target) {
    s.flash("Build a solid first");
    return;
  }
  const other = kind === "fillet" ? "chamfer" : "fillet";
  if (doc.features.some((f) => f.kind === other && f.targetId === target.id)) {
    s.flash(kind === "fillet" ? "Delete the chamfer first" : "Delete the fillet first");
    return;
  }
  const existing = doc.features.find((f) => f.kind === kind && f.targetId === target.id);
  if (existing) {
    set({ selection: {
      kind: "feature",
      id: existing.id
    } });
    openInspector();
    return;
  }
  const feature: FilletFeature | ChamferFeature = kind === "fillet" ? {
    id: uid("fil"),
    kind: "fillet",
    name: "Fillet",
    targetId: target.id,
    radius: s.filletRadius
  } : {
    id: uid("ch"),
    kind: "chamfer",
    name: "Chamfer",
    targetId: target.id,
    distance: s.chamferDist
  };
  if (patch((draft) => {
    draft.features.push(feature);
  })) {
    set({ selection: {
      kind: "feature",
      id: feature.id
    } });
    openInspector();
  }
}
if (typeof window !== "undefined") {
  let timer: ReturnType<typeof setTimeout> | undefined;
  useCad.subscribe((state, prev) => {
    if (state.docs === prev.docs && state.activeId === prev.activeId) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      localStorage.setItem(KEY, JSON.stringify({
        v: 1,
        docs: state.docs,
        activeId: state.activeId
      }));
    }, 180);
  });
}
export function activeDoc(state: CadState): Doc {
  return state.docs.find((d) => d.id === state.activeId) ?? state.docs[0];
}
export function hiddenFeatureIds(state: CadState): Set<string> {
  const hidden = new Set(state.hiddenIds);
  if (!state.isolateId) return hidden;
  const doc = activeDoc(state);
  const keep = new Set([state.isolateId]);
  const selected = doc.features.find((f) => f.id === state.isolateId);
  if (selected?.kind === "solid") keep.add(selected.id);
  if (selected?.kind === "hole" || selected?.kind === "fillet" || selected?.kind === "chamfer") {
    keep.add(selected.id);
    for (const feature of doc.features) if (feature.kind === "solid") keep.add(feature.id);
  }
  for (const feature of doc.features) if ((feature.kind === "fillet" || feature.kind === "chamfer") && keep.has(feature.targetId)) keep.add(feature.id);
  const sketchSel = doc.sketches.find((s) => s.id === state.isolateId);
  if (sketchSel) {
    keep.add(sketchSel.id);
    for (const feature of doc.features) if (feature.kind === "solid" && feature.sketchId === sketchSel.id) keep.add(feature.id);
  }
  for (const feature of doc.features) if (!keep.has(feature.id)) hidden.add(feature.id);
  return hidden;
}
export function dofLabel(report: SolveReport | undefined): string {
  if (!report) return "no sketch";
  if (report.status === "conflict") return "Conflicting Constraints";
  if (report.status === "defined") return "Fully Defined";
  return report.dof === 1 ? "Under Defined · 1 DOF" : `Under Defined · ${report.dof} DOF`;
}