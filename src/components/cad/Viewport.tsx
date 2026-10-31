import { clsx } from "clsx";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildModel, disposeBodies, planeMatrix, sketchPoint, type BuiltBody } from "@/lib/cad/build";
import { formatNum } from "@/lib/cad/format";
import { circlePoints, sketchEdges, snap as snapStep } from "@/lib/cad/geom2d";
import { activeDoc, hiddenFeatureIds, useCad } from "@/lib/cad/store";
import type { Plane, Sel, Vec2 } from "@/lib/cad/types";

type ViewName = "iso" | "top" | "front" | "right";

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const look = useRef<(view: ViewName) => void>(() => {});
  const tool = useCad((s) => s.tool);
  const poly = useCad((s) => s.poly.length);
  const empty = useCad((s) => !s.evalDoc.features.some((f) => f.kind === "solid"));
  const projection = useCad((s) => s.projection);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = "block h-full w-full";
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.add(new THREE.HemisphereLight(0xfff6ea, 0x2a241c, 0.45));
    const key = new THREE.DirectionalLight(0xfff8f0, 1.25);
    key.position.set(80, 120, 40);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xb7c4d6, 0.35);
    fill.position.set(-60, 30, -40);
    scene.add(fill);

    const persp = new THREE.PerspectiveCamera(38, 1, 0.05, 8000);
    const ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.05, 8000);
    let camera: THREE.Camera = persp;
    persp.position.set(120, 90, 130);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.zoomToCursor = true;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    controls.target.set(0, 12, 0);
    controls.update();

    const cadRoot = new THREE.Group();
    cadRoot.rotation.x = -Math.PI / 2;
    scene.add(cadRoot);
    const solidGroup = new THREE.Group();
    const occtGroup = new THREE.Group();
    const sketchGroup = new THREE.Group();
    const previewGroup = new THREE.Group();
    cadRoot.add(solidGroup, occtGroup, sketchGroup, previewGroup);

    let grid: THREE.GridHelper | null = null;
    let gridStep = 0;
    const axesScene = new THREE.Scene();
    const axesCam = new THREE.PerspectiveCamera(50, 1, 0.1, 20);
    const axesGroup = new THREE.Group();
    axesGroup.add(new THREE.AxesHelper(1.15));
    axesScene.add(axesGroup);

    let mode: "persp" | "ortho" = "persp";
    let built: BuiltBody[] = [];
    let hover: Vec2 | null = null;
    let shapeDrag: { kind: "rect" | "circle"; start: Vec2; pointerId: number } | null = null;
    let pointDrag: { sketchId: string; pointId: string; pointerId: number } | null = null;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const canonical = (plane: Plane) => (plane === "XY" ? new THREE.Vector3(0, 0, 1) : plane === "XZ" ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(1, 0, 0));

    const toSketch = (plane: Plane, local: THREE.Vector3) => {
      if (plane === "XY") return { x: local.x, y: local.y, offset: local.z };
      if (plane === "XZ") return { x: local.x, y: local.z, offset: -local.y };
      return { x: local.y, y: local.z, offset: local.x };
    };

    const modelRay = () => {
      const ray = raycaster.ray.clone();
      ray.applyMatrix4(cadRoot.matrixWorld.clone().invert());
      return ray;
    };

    const setPointer = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return rect;
    };

    const planeHit = (plane: Plane, offset: number) => {
      const n = canonical(plane);
      const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, n.clone().multiplyScalar(offset));
      const hit = modelRay().intersectPlane(pl, new THREE.Vector3());
      if (!hit) return null;
      const sk = toSketch(plane, hit);
      return { x: sk.x, y: sk.y };
    };

    const project = (plane: Plane, offset: number, p: Vec2, rect: DOMRect) => {
      const world = sketchPoint(plane, offset, p.x, p.y);
      cadRoot.localToWorld(world);
      world.project(camera);
      return { x: (world.x * 0.5 + 0.5) * rect.width, y: (-world.y * 0.5 + 0.5) * rect.height };
    };

    const snapPoint = (p: Vec2, plane: Plane, offset: number, rect: DOMRect): Vec2 => {
      const state = useCad.getState();
      let x = snapStep(p.x, state.snap);
      let y = snapStep(p.y, state.snap);
      let best = 12;
      for (const sketch of state.evalDoc.sketches) {
        if (sketch.plane !== plane) continue;
        for (const pt of sketch.points) {
          const px = project(plane, sketch.offset, pt, rect);
          const d = Math.hypot(px.x - project(plane, offset, { x, y }, rect).x, px.y - project(plane, offset, { x, y }, rect).y);
          if (d < best) {
            best = d;
            x = pt.x;
            y = pt.y;
          }
        }
      }
      return { x, y };
    };

    const disposeObject = (obj: THREE.Object3D) => {
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments || child instanceof THREE.Sprite) {
          child.geometry?.dispose?.();
          const mat = child.material;
          const mats = Array.isArray(mat) ? mat : [mat];
          for (const m of mats) {
            if (m && "map" in m && m.map instanceof THREE.Texture) m.map.dispose();
            m?.dispose();
          }
        }
      });
    };

    const selectedIds = () => {
      const s = useCad.getState();
      const ids = new Set<string>();
      const sel = s.selection;
      if (!sel) return ids;
      if (sel.kind === "feature") ids.add(sel.id);
      if (sel.kind === "sketch") {
        for (const f of s.evalDoc.features) if (f.kind === "solid" && f.sketchId === sel.id) ids.add(f.id);
      }
      return ids;
    };

    const restyle = () => {
      const ids = selectedIds();
      solidGroup.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const mat = child.material as THREE.MeshStandardMaterial;
        const mine = (child.userData.ids as string[] | undefined)?.some((id) => ids.has(id));
        mat.emissive.set(mine ? 0xe06a2f : 0x000000);
        mat.emissiveIntensity = mine ? 0.22 : 0;
      });
    };

    const labelSprite = (text: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.clearRect(0, 0, 256, 64);
      ctx.font = "500 26px 'IBM Plex Mono', monospace";
      const w = Math.min(236, ctx.measureText(text).width + 28);
      ctx.fillStyle = "rgba(20, 18, 16, 0.78)";
      ctx.beginPath();
      ctx.roundRect(128 - w / 2, 10, w, 44, 8);
      ctx.fill();
      ctx.fillStyle = "#e0b15a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 128, 33);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      sprite.userData.label = true;
      return sprite;
    };

    const rebuildSketches = () => {
      disposeObject(sketchGroup);
      sketchGroup.clear();
      disposeObject(previewGroup);
      previewGroup.clear();
      const state = useCad.getState();
      if (state.showSketches) {
        const stored = activeDoc(state);
        const sel = state.selection;
        const activeSketch =
          sel?.kind === "sketch" || sel?.kind === "point" || sel?.kind === "edge"
            ? sel.kind === "sketch"
              ? sel.id
              : sel.sketchId
            : sel?.kind === "feature"
              ? stored.features.find((f) => f.id === sel.id && f.kind === "solid")?.kind === "solid"
                ? (stored.features.find((f) => f.id === sel.id) as { sketchId?: string }).sketchId
                : undefined
              : undefined;
        for (const sketch of state.evalDoc.sketches) {
          if (state.hiddenIds.includes(sketch.id)) continue;
          const positions: number[] = [];
          for (const edge of sketchEdges(sketch)) {
            const a = sketchPoint(sketch.plane, sketch.offset, edge.p.x, edge.p.y);
            const b = sketchPoint(sketch.plane, sketch.offset, edge.q.x, edge.q.y);
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
          }
          for (const loop of sketch.loops) {
            if (loop.kind !== "circle") continue;
            const c = sketch.points.find((p) => p.id === loop.centerId);
            if (!c) continue;
            const pts = circlePoints(c.x, c.y, loop.radius, 64);
            for (let i = 0; i < pts.length; i++) {
              const a = sketchPoint(sketch.plane, sketch.offset, pts[i].x, pts[i].y);
              const q = pts[(i + 1) % pts.length];
              const b = sketchPoint(sketch.plane, sketch.offset, q.x, q.y);
              positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            }
          }
          if (positions.length) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
            const line = new THREE.LineSegments(
              geom,
              new THREE.LineBasicMaterial({
                color: sketch.id === activeSketch ? 0xf0c56e : 0x8a7348,
                depthTest: true,
              }),
            );
            sketchGroup.add(line);
          }
          const source = stored.sketches.find((s) => s.id === sketch.id);
          const editingSketch = sel?.kind === "sketch" || sel?.kind === "point" || sel?.kind === "edge";
          if (!source || sketch.id !== activeSketch || (!editingSketch && state.tool === "select")) continue;
          const centroid = sketch.points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
          const npts = Math.max(1, sketch.points.length);
          centroid.x /= npts;
          centroid.y /= npts;
          let radiusSlot = 0;
          for (const c of source.constraints) {
            if (c.type === "dist") {
              const a = sketch.points.find((p) => p.id === c.a);
              const b = sketch.points.find((p) => p.id === c.b);
              if (!a || !b) continue;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const len = Math.hypot(dx, dy) || 1;
              let nx = -dy / len;
              let ny = dx / len;
              const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
              if ((mid.x + nx - centroid.x) * nx + (mid.y + ny - centroid.y) * ny < 0) {
                nx *= -1;
                ny *= -1;
              }
              const off = 8;
              const p1 = sketchPoint(sketch.plane, sketch.offset, a.x + nx * off, a.y + ny * off);
              const p2 = sketchPoint(sketch.plane, sketch.offset, b.x + nx * off, b.y + ny * off);
              const dim = new THREE.BufferGeometry().setFromPoints([
                sketchPoint(sketch.plane, sketch.offset, a.x, a.y),
                p1,
                p1,
                p2,
                p2,
                sketchPoint(sketch.plane, sketch.offset, b.x, b.y),
              ]);
              sketchGroup.add(new THREE.LineSegments(dim, new THREE.LineBasicMaterial({ color: 0x8d7340, depthTest: false })));
              const sprite = labelSprite(formatNum(len));
              if (sprite) {
                sprite.position.copy(p1).add(p2).multiplyScalar(0.5);
                sketchGroup.add(sprite);
              }
            }
            if (c.type === "radius") {
              const loop = sketch.loops.find((l) => l.id === c.loopId);
              if (!loop || loop.kind !== "circle") continue;
              const center = sketch.points.find((p) => p.id === loop.centerId);
              if (!center) continue;
              const slot = radiusSlot++;
              const ang = slot * 2.15 + 0.4;
              const ex = Math.cos(ang);
              const ey = Math.sin(ang);
              const at = sketchPoint(sketch.plane, sketch.offset, center.x + ex * loop.radius, center.y + ey * loop.radius);
              const from = sketchPoint(sketch.plane, sketch.offset, center.x, center.y);
              const lab = sketchPoint(sketch.plane, sketch.offset, center.x + ex * (loop.radius + 8), center.y + ey * (loop.radius + 8));
              const dim = new THREE.BufferGeometry().setFromPoints([from, at]);
              sketchGroup.add(new THREE.LineSegments(dim, new THREE.LineBasicMaterial({ color: 0x8d7340, depthTest: false })));
              const sprite = labelSprite(`${c.display === "diameter" ? "Ø" : "R"}${formatNum(c.display === "diameter" ? loop.radius * 2 : loop.radius)}`);
              if (sprite) {
                sprite.position.copy(lab);
                sketchGroup.add(sprite);
              }
            }
          }
          for (const pt of sketch.points) {
            const mesh = new THREE.Mesh(
              new THREE.SphereGeometry(0.7, 10, 8),
              new THREE.MeshBasicMaterial({ color: 0xf3efe6, depthTest: false }),
            );
            mesh.position.copy(sketchPoint(sketch.plane, sketch.offset, pt.x, pt.y));
            mesh.userData.point = { sketchId: sketch.id, pointId: pt.id };
            sketchGroup.add(mesh);
          }
        }
      }
      if (state.tool !== "select") {
        const helper = new THREE.Mesh(
          new THREE.PlaneGeometry(220, 220),
          new THREE.MeshBasicMaterial({ color: 0xe06a2f, transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false }),
        );
        helper.applyMatrix4(planeMatrix(state.workPlane, state.workOffset));
        previewGroup.add(helper);
      }
      const drawPoly = [...state.poly];
      if (state.tool === "poly" && hover) drawPoly.push(hover);
      if (drawPoly.length > 1) {
        const geom = new THREE.BufferGeometry().setFromPoints(drawPoly.map((p) => sketchPoint(state.workPlane, state.workOffset, p.x, p.y)));
        previewGroup.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xe06a2f, depthTest: false })));
      }
    };

    const frameBox = (selOnly: boolean) => {
      const box = new THREE.Box3();
      const ids = selectedIds();
      const exchange = useCad.getState().exchange;
      if (!exchange) {
        solidGroup.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          if (selOnly && ids.size && !(child.userData.ids as string[] | undefined)?.some((id) => ids.has(id))) return;
          box.expandByObject(child);
        });
      }
      occtGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) box.expandByObject(child);
      });
      if (box.isEmpty()) box.set(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 20, 20));
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 0.7 + 12;
      const dist = radius / Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2);
      persp.up.set(0, 1, 0);
      persp.position.set(center.x + dist * 0.85, center.y + dist * 0.62, center.z + dist * 0.85);
      controls.target.copy(center);
      if (mode === "ortho") {
        ortho.position.copy(persp.position);
        ortho.up.copy(persp.up);
      }
      camera.lookAt(center);
      controls.update();
    };

    const lookAt = (view: ViewName) => {
      const box = new THREE.Box3();
      if (!useCad.getState().exchange) box.expandByObject(solidGroup);
      if (occtGroup.children.length) box.expandByObject(occtGroup);
      if (box.isEmpty()) box.set(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 16, 20));
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const dist = Math.max(size.x, size.y, size.z) * 1.5 + 30;
      const up = new THREE.Vector3(0, 1, 0);
      const pos = center.clone();
      if (view === "iso") pos.add(new THREE.Vector3(dist * 0.85, dist * 0.62, dist * 0.85));
      if (view === "top") {
        pos.add(new THREE.Vector3(0, dist, 0.01));
        up.set(0, 0, -1);
      }
      if (view === "front") pos.add(new THREE.Vector3(0, size.y * 0.2, dist));
      if (view === "right") pos.add(new THREE.Vector3(dist, size.y * 0.2, 0));
      persp.up.copy(up);
      persp.position.copy(pos);
      ortho.up.copy(up);
      ortho.position.copy(pos);
      controls.target.copy(center);
      camera.lookAt(center);
      controls.update();
    };
    look.current = lookAt;

    const rebuildSolids = () => {
      disposeObject(solidGroup);
      solidGroup.clear();
      disposeBodies(built);
      const state = useCad.getState();
      const result = buildModel(state.evalDoc, hiddenFeatureIds(state));
      built = result.bodies;
      if (result.issues.join("|") !== state.issues.join("|")) state.setIssues(result.issues);
      for (const body of result.bodies) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xc8c1b6,
          metalness: 0.7,
          roughness: 0.36,
          envMapIntensity: 0.95,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        const mesh = new THREE.Mesh(body.geometry, mat);
        mesh.userData.ids = body.ids;
        solidGroup.add(mesh);
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(body.geometry, 22),
          new THREE.LineBasicMaterial({ color: 0x241f1a }),
        );
        mesh.add(edges);
      }
      restyle();
    };

    let lastGeom = -1;
    let overlayKey = "";
    const sync = () => {
      const state = useCad.getState();
      const locked = Boolean(state.exchange);
      solidGroup.visible = !locked;
      sketchGroup.visible = !locked && state.showSketches;
      previewGroup.visible = !locked;
      controls.mouseButtons.LEFT = !locked && state.tool !== "select" ? null : THREE.MOUSE.ROTATE;
      if (state.projection !== mode) {
        const dist = camera.position.distanceTo(controls.target);
        if (state.projection === "ortho") {
          const aspect = el.clientWidth / Math.max(1, el.clientHeight);
          const h = dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2);
          ortho.top = h;
          ortho.bottom = -h;
          ortho.left = -h * aspect;
          ortho.right = h * aspect;
          ortho.zoom = 1;
          ortho.position.copy(persp.position);
          ortho.up.copy(persp.up);
          ortho.lookAt(controls.target);
          ortho.updateProjectionMatrix();
          controls.object = ortho;
          camera = ortho;
        } else {
          persp.position.copy(ortho.position);
          persp.up.copy(ortho.up);
          persp.lookAt(controls.target);
          controls.object = persp;
          camera = persp;
        }
        mode = state.projection;
      }
      if (state.geomTick !== lastGeom) {
        const first = lastGeom < 0;
        lastGeom = state.geomTick;
        rebuildSolids();
        rebuildSketches();
        if (first || state.frameMode) {
          /* frame on demand below */
        }
        if (first) frameBox(false);
      }
      const sel = state.selection;
      const key = JSON.stringify({
        sel,
        show: state.showSketches,
        poly: state.poly,
        tool: state.tool,
        plane: state.workPlane,
        off: state.workOffset,
        hover,
        hidden: state.hiddenIds,
      });
      if (key !== overlayKey) {
        overlayKey = key;
        rebuildSketches();
        restyle();
      }
    };

    const resize = () => {
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
      if (mode === "ortho") {
        const dist = ortho.position.distanceTo(controls.target);
        const vh = (dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) / Math.max(0.05, ortho.zoom);
        ortho.top = vh;
        ortho.bottom = -vh;
        ortho.left = -vh * (w / h);
        ortho.right = vh * (w / h);
        ortho.updateProjectionMatrix();
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const pickPoint = (ev: PointerEvent): Sel | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      const state = useCad.getState();
      let best = 14;
      let found: Sel | null = null;
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      for (const sketch of state.evalDoc.sketches) {
        if (!state.showSketches || state.hiddenIds.includes(sketch.id)) continue;
        for (const pt of sketch.points) {
          const px = project(sketch.plane, sketch.offset, pt, rect);
          const d = Math.hypot(px.x - mx, px.y - my);
          if (d < best) {
            best = d;
            found = { kind: "point", sketchId: sketch.id, pointId: pt.id };
          }
        }
        for (const edge of sketchEdges(sketch)) {
          const a = project(sketch.plane, sketch.offset, edge.p, rect);
          const b = project(sketch.plane, sketch.offset, edge.q, rect);
          const d = distToSeg(mx, my, a.x, a.y, b.x, b.y);
          if (d < best && d < 8) {
            best = d;
            found = { kind: "edge", sketchId: sketch.id, loopId: edge.loopId, index: edge.index };
          }
        }
      }
      return found;
    };

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const state = useCad.getState();
      if (state.exchange) return;
      setPointer(ev);
      const rect = renderer.domElement.getBoundingClientRect();
      if (state.tool === "rect" || state.tool === "circle") {
        const hit = planeHit(state.workPlane, state.workOffset);
        if (!hit) return;
        ev.stopPropagation();
        shapeDrag = { kind: state.tool, start: snapPoint(hit, state.workPlane, state.workOffset, rect), pointerId: ev.pointerId };
        el.setPointerCapture(ev.pointerId);
        controls.enabled = false;
        return;
      }
      if (state.tool === "poly") {
        const hit = planeHit(state.workPlane, state.workOffset);
        if (!hit) return;
        ev.stopPropagation();
        const p = snapPoint(hit, state.workPlane, state.workOffset, rect);
        const poly = state.poly;
        if (poly.length >= 3) {
          const a = project(state.workPlane, state.workOffset, poly[0], rect);
          const b = project(state.workPlane, state.workOffset, p, rect);
          if (Math.hypot(a.x - b.x, a.y - b.y) < 14) {
            state.addPoly(poly);
            return;
          }
        }
        state.pushPoly(p);
        return;
      }
      if (state.tool === "hole") {
        ev.stopPropagation();
        const meshes = solidGroup.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
        const hits = raycaster.intersectObjects(meshes, false);
        if (hits[0]?.face) {
          const local = cadRoot.worldToLocal(hits[0].point.clone());
          const n = hits[0].face.normal.clone().normalize();
          const ax = Math.abs(n.x);
          const ay = Math.abs(n.y);
          const az = Math.abs(n.z);
          const plane: Plane = az >= ay && az >= ax ? "XY" : ay >= ax ? "XZ" : "YZ";
          const sk = toSketch(plane, local);
          const travel = canonical(plane).dot(n) > 0 ? -1 : 1;
          state.addHole(plane, sk.offset, sk.x, sk.y, travel);
          return;
        }
        const hit = planeHit(state.workPlane, state.workOffset);
        if (hit) {
          const p = snapPoint(hit, state.workPlane, state.workOffset, rect);
          state.addHole(state.workPlane, state.workOffset, p.x, p.y, -1);
        }
        return;
      }
      const picked = pickPoint(ev);
      if (picked?.kind === "point") {
        ev.stopPropagation();
        state.beginGesture();
        pointDrag = { sketchId: picked.sketchId, pointId: picked.pointId, pointerId: ev.pointerId };
        el.setPointerCapture(ev.pointerId);
        controls.enabled = false;
        state.select(picked);
        return;
      }
      if (picked) {
        state.select(picked);
        return;
      }
      const meshes = solidGroup.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
      const hits = raycaster.intersectObjects(meshes, false);
      const ids = hits[0]?.object.userData.ids as string[] | undefined;
      state.select(ids?.[0] ? { kind: "feature", id: ids[0] } : null);
    };

    const onPointerMove = (ev: PointerEvent) => {
      const state = useCad.getState();
      if (state.exchange) return;
      const rect = setPointer(ev);
      const hit = planeHit(state.workPlane, state.workOffset);
      const readout = document.getElementById("cad-readout");
      if (hit && readout) {
        const p = snapPoint(hit, state.workPlane, state.workOffset, rect);
        readout.textContent = `X ${formatNum(p.x)}   Y ${formatNum(p.y)}`;
        hover = state.tool === "poly" ? p : null;
      }
      if (shapeDrag && hit) {
        const p = snapPoint(hit, state.workPlane, state.workOffset, rect);
        disposeObject(previewGroup);
        const pts =
          shapeDrag.kind === "rect"
            ? [shapeDrag.start, { x: p.x, y: shapeDrag.start.y }, p, { x: shapeDrag.start.x, y: p.y }, shapeDrag.start]
            : circlePoints(shapeDrag.start.x, shapeDrag.start.y, Math.hypot(p.x - shapeDrag.start.x, p.y - shapeDrag.start.y), 48).concat([
                circlePoints(shapeDrag.start.x, shapeDrag.start.y, Math.hypot(p.x - shapeDrag.start.x, p.y - shapeDrag.start.y), 48)[0],
              ]);
        const geom = new THREE.BufferGeometry().setFromPoints(pts.map((q) => sketchPoint(state.workPlane, state.workOffset, q.x, q.y)));
        previewGroup.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xe06a2f, depthTest: false })));
      }
      if (pointDrag && hit) {
        const sketch = state.evalDoc.sketches.find((s) => s.id === pointDrag!.sketchId);
        if (!sketch) return;
        const p = snapPoint(hit, sketch.plane, sketch.offset, rect);
        state.dragPoint(pointDrag.sketchId, pointDrag.pointId, p.x, p.y);
      }
      if (state.tool === "poly") rebuildSketches();
    };

    const onPointerUp = (ev: PointerEvent) => {
      const state = useCad.getState();
      if (shapeDrag && shapeDrag.pointerId === ev.pointerId) {
        const rect = setPointer(ev);
        const hit = planeHit(state.workPlane, state.workOffset);
        if (hit) {
          const p = snapPoint(hit, state.workPlane, state.workOffset, rect);
          if (shapeDrag.kind === "rect") state.addRect(shapeDrag.start.x, shapeDrag.start.y, p.x, p.y);
          else state.addCircle(shapeDrag.start.x, shapeDrag.start.y, Math.hypot(p.x - shapeDrag.start.x, p.y - shapeDrag.start.y));
        }
        shapeDrag = null;
        controls.enabled = true;
      }
      if (pointDrag && pointDrag.pointerId === ev.pointerId) {
        pointDrag = null;
        state.endGesture();
        controls.enabled = true;
      }
    };

    el.addEventListener("pointerdown", onPointerDown, true);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("contextmenu", (ev) => ev.preventDefault());

    let shownOcct: ReturnType<typeof useCad.getState>["occtMesh"] = null;
    const syncOcct = () => {
      const data = useCad.getState().occtMesh;
      if (data === shownOcct) return;
      shownOcct = data;
      disposeObject(occtGroup);
      occtGroup.clear();
      if (!data) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: 0xd7c4a4,
          metalness: 0.72,
          roughness: 0.3,
          envMapIntensity: 1,
        }),
      );
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 18), new THREE.LineBasicMaterial({ color: 0x241f1a })));
      occtGroup.add(mesh);
    };

    let framed = 0;
    const unsub = useCad.subscribe(() => {
      syncOcct();
      sync();
      const tick = useCad.getState().frameTick;
      if (tick !== framed) {
        framed = tick;
        frameBox(useCad.getState().frameMode === "sel");
      }
    });
    syncOcct();
    sync();
    framed = useCad.getState().frameTick;

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      if (useCad.getState().showGrid) {
        const dist = camera.position.distanceTo(controls.target);
        const raw = (2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) / 14;
        const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 0.1)));
        const n = raw / pow;
        const step = n < 2 ? pow : n < 5 ? 2 * pow : 5 * pow;
        if (Math.abs(step - gridStep) > 1e-6) {
          gridStep = step;
          if (grid) scene.remove(grid);
          grid = new THREE.GridHelper(step * 40, 40, 0x5c5348, 0x2b2722);
          grid.position.y = -0.05;
          scene.add(grid);
        }
      } else if (grid) {
        scene.remove(grid);
        grid = null;
        gridStep = 0;
      }
      sketchGroup.traverse((child) => {
        if (child instanceof THREE.Sprite && child.userData.label) {
          const dist = camera.position.distanceTo(controls.target);
          const s = THREE.MathUtils.clamp(dist * 0.016, 5, 14);
          child.scale.set(s * 2.2, s * 0.55, 1);
        }
      });
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, el.clientWidth, el.clientHeight);
      renderer.render(scene, camera);
      axesGroup.quaternion.copy(cadRoot.quaternion);
      const offset = camera.position.clone().sub(controls.target);
      if (offset.lengthSq() < 1e-6) offset.set(1, 1, 1);
      axesCam.position.copy(offset.normalize().multiplyScalar(3.4));
      axesCam.up.copy(camera.up);
      axesCam.lookAt(0, 0, 0);
      const s = 92;
      renderer.clearDepth();
      renderer.setScissorTest(true);
      renderer.setViewport(12, 12, s, s);
      renderer.setScissor(12, 12, s, s);
      renderer.render(axesScene, axesCam);
      renderer.setScissorTest(false);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      unsub();
      ro.disconnect();
      el.removeEventListener("pointerdown", onPointerDown, true);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      disposeObject(solidGroup);
      disposeObject(sketchGroup);
      disposeObject(previewGroup);
      disposeBodies(built);
      pmrem.dispose();
      scene.environment?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // mount once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative h-full min-h-0 w-full bg-[radial-gradient(ellipse_at_center,#2a241c_0%,#141210_68%)]">
      <div ref={host} className="absolute inset-0 touch-none" />
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="pointer-events-auto flex gap-1">
            {(
              [
                ["iso", "Isometric"],
                ["top", "Top"],
                ["front", "Front"],
                ["right", "Right"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => look.current(id)}
                className="h-9 rounded-sm border border-border bg-surface/90 px-2.5 text-xs text-muted backdrop-blur-sm hover:text-fg"
              >
                {label}
              </button>
            ))}
          </div>
          <div className="pointer-events-auto flex gap-1">
            <button
              type="button"
              onClick={() => useCad.getState().setProjection(projection === "persp" ? "ortho" : "persp")}
              className={clsx("h-9 rounded-sm border border-border bg-surface/90 px-2.5 text-xs backdrop-blur-sm", projection === "ortho" ? "text-brass" : "text-muted")}
            >
              {projection === "ortho" ? "Orthographic" : "Perspective"}
            </button>
            <button type="button" onClick={() => useCad.getState().frame("all")} className="h-9 rounded-sm border border-border bg-surface/90 px-2.5 text-xs text-muted backdrop-blur-sm hover:text-fg">
              Fit All
            </button>
          </div>
        </div>
        <div className="flex items-end justify-between gap-2">
          {empty ? (
            <div className="pointer-events-none max-w-sm rounded-sm border border-border bg-surface/90 px-3 py-3 text-sm text-pretty text-muted backdrop-blur-sm">
              On the {useCad.getState().workPlane} plane, drag a rectangle or circle to create a solid.
            </div>
          ) : (
            <div />
          )}
          {tool === "poly" && (
            <div className="rounded-sm border border-border bg-surface/90 px-3 py-2 text-xs text-brass backdrop-blur-sm">
              {poly === 0 ? "Place contour points" : `${poly} · close at the first point or press Enter`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
