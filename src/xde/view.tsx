import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { DefinitionMesh, XdeNode, XdeReport } from "./types";
import { fitPerspective } from "./fit.ts";

/**
 * Read-only assembly view. Meshes are definition-frame triangles from the XDE
 * worker. Each occurrence's world matrix is applied once. Highlight is local
 * viewer state and is not written back to the document.
 */
export function AssemblyView({
  report,
  meshes,
  selected,
  onSelect,
}: {
  report: XdeReport;
  meshes: DefinitionMesh[];
  selected: string | null;
  onSelect: (occurrenceId: string | null) => void;
}) {
  const highlighted = useMemo(() => highlightSet(report.nodes, selected), [report.nodes, selected]);
  const boundsLabel = useMemo(() => meshes.map((mesh) => `${mesh.definitionId}:${formatBox(mesh.positions)}`).join("|"), [meshes]);
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const selectRef = useRef(onSelect);
  const highlightRef = useRef(highlighted);
  const materialsRef = useRef<Map<string, THREE.MeshStandardMaterial>>(new Map());
  selectRef.current = onSelect;
  highlightRef.current = highlighted;
  const [fitMax, setFitMax] = useState("");
  const [points, setPoints] = useState<Record<string, { x: number; y: number }>>({});
  const [viewEpoch, setViewEpoch] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    setViewEpoch((value) => value + 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "block h-full w-full";
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff6ea, 0x2a241c, 0.55));
    const key = new THREE.DirectionalLight(0xfff8f0, 1.2);
    key.position.set(80, 140, 60);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xb7c4d6, 0.4);
    fill.position.set(-70, 40, -50);
    scene.add(fill);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 20000);
    camera.position.set(160, 120, 180);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.zoomToCursor = true;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;

    const root = new THREE.Group();
    // Display only. CAD stays Z-up; this does not bake into the mesh or the STEP.
    root.rotation.x = -Math.PI / 2;
    scene.add(root);

    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.MeshStandardMaterial[] = [];
    const occurrenceMaterials = new Map<string, THREE.MeshStandardMaterial>();
    const byDefinition = new Map<number, THREE.BufferGeometry>();
    for (const source of meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(source.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(source.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
      geometries.push(geometry);
      byDefinition.set(source.definitionId, geometry);
    }
    const byOccurrence = new Map<string, THREE.Mesh>();
    for (const node of report.nodes) {
      if (node.isAssembly) continue;
      const geometry = byDefinition.get(node.definitionId);
      if (!geometry) continue;
      const material = new THREE.MeshStandardMaterial({
        color: materialColor(node.color.effective?.rgb ?? null),
        metalness: 0.08,
        roughness: 0.55,
        side: THREE.DoubleSide,
      });
      materials.push(material);
      occurrenceMaterials.set(node.occurrenceId, material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrixFromRowMajor3x4(node.world));
      mesh.matrixWorldNeedsUpdate = true;
      mesh.userData.occurrenceId = node.occurrenceId;
      root.add(mesh);
      byOccurrence.set(node.occurrenceId, mesh);
    }
    materialsRef.current = occurrenceMaterials;

    const paint = () => {
      for (const [id, material] of materialsRef.current) {
        const on = highlightRef.current.has(id);
        material.emissive.set(on ? 0xe06a2f : 0x000000);
        material.emissiveIntensity = on ? 0.55 : 0;
      }
    };
    paint();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointer = (event: PointerEvent) => {
      if (event.button !== 0) return;
      root.updateMatrixWorld(true);
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...byOccurrence.values()], false);
      const id = hits[0]?.object.userData.occurrenceId;
      selectRef.current(typeof id === "string" ? id : null);
    };
    renderer.domElement.addEventListener("pointerdown", onPointer);

    const resize = () => {
      const width = el.clientWidth || 1;
      const height = el.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    const project = () => {
      if (!alive) return;
      root.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      const rect = renderer.domElement.getBoundingClientRect();
      const next: Record<string, { x: number; y: number }> = {};
      for (const [id, mesh] of byOccurrence) {
        const box = new THREE.Box3().setFromObject(mesh);
        if (box.isEmpty()) continue;
        const center = box.getCenter(new THREE.Vector3());
        center.project(camera);
        next[id] = {
          x: rect.left + (center.x * 0.5 + 0.5) * rect.width,
          y: rect.top + (-center.y * 0.5 + 0.5) * rect.height,
        };
      }
      setPoints(next);
    };

    const fit = () => {
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const corners: Array<[number, number, number]> = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push([x, y, z]);
      const width = renderer.domElement.clientWidth || el.clientWidth || 1;
      const height = renderer.domElement.clientHeight || el.clientHeight || 1;
      const framed = fitPerspective({
        fov: camera.fov,
        aspect: width / height,
        center: [center.x, center.y, center.z],
        direction: [1, 0.7, 1],
        corners,
      });
      const direction = new THREE.Vector3(1, 0.7, 1).normalize();
      camera.position.copy(center).addScaledVector(direction, framed.distance);
      camera.near = framed.near;
      camera.far = framed.far;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      camera.updateMatrixWorld(true);
      let maxAbsX = 0;
      let maxAbsY = 0;
      for (const corner of corners) {
        const projected = new THREE.Vector3(...corner).project(camera);
        maxAbsX = Math.max(maxAbsX, Math.abs(projected.x));
        maxAbsY = Math.max(maxAbsY, Math.abs(projected.y));
      }
      setFitMax(`${maxAbsX.toFixed(4)},${maxAbsY.toFixed(4)}`);
      project();
    };
    fitRef.current = fit;
    fit();
    controls.addEventListener("end", project);

    let frame = 0;
    let still = 0;
    const previous = new THREE.Vector3();
    const loop = () => {
      frame = requestAnimationFrame(loop);
      previous.copy(camera.position);
      controls.update();
      renderer.render(scene, camera);
      if (still < 3) {
        if (previous.distanceToSquared(camera.position) < 1e-8) still += 1;
        else still = 0;
        if (still === 1) project();
      }
    };
    loop();

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointer);
      controls.removeEventListener("end", project);
      controls.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      materialsRef.current = new Map();
      renderer.dispose();
      renderer.domElement.remove();
      fitRef.current = null;
    };
  }, [report, meshes]);

  useEffect(() => {
    for (const [id, material] of materialsRef.current) {
      const on = highlightRef.current.has(id);
      material.emissive.set(on ? 0xe06a2f : 0x000000);
      material.emissiveIntensity = on ? 0.55 : 0;
    }
  }, [highlighted]);

  return (
    <div className="grid min-h-[420px] gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="relative min-h-[420px] overflow-hidden rounded-sm border border-border bg-[#100e0c]">
        <div
          ref={host}
          className="absolute inset-0"
          data-xde-canvas="yes"
          data-xde-fit={fitMax}
          data-xde-view={viewEpoch}
          data-xde-highlighted={[...highlighted].join(" ")}
          data-definition-bounds={boundsLabel}
        />
        <button type="button" onClick={() => fitRef.current?.()} className="absolute top-2 right-2 rounded-sm border border-border bg-surface/90 px-2 py-1 text-xs">
          Fit all
        </button>
      </div>
      <aside className="max-h-[520px] overflow-auto rounded-sm border border-border bg-surface">
        <div className="border-b border-border px-3 py-2 text-xs text-faint" data-xde-counts="yes">
          {report.partOccurrences} part occurrences · {report.partDefinitions} part definitions · {report.assemblyDefinitions} assemblies
        </div>
        <Tree nodes={report.nodes} selected={selected} points={points} onSelect={onSelect} />
      </aside>
    </div>
  );
}

function Tree({
  nodes,
  selected,
  points,
  onSelect,
}: {
  nodes: XdeNode[];
  selected: string | null;
  points: Record<string, { x: number; y: number }>;
  onSelect: (occurrenceId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const byParent = new Map<string | null, XdeNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentOccurrenceId) ?? [];
    list.push(node);
    byParent.set(node.parentOccurrenceId, list);
  }
  useEffect(() => {
    setCollapsed(new Set());
  }, [nodes]);
  useEffect(() => {
    if (!selected) return;
    const parents = new Map(nodes.map((node) => [node.occurrenceId, node.parentOccurrenceId]));
    setCollapsed((current) => {
      const next = new Set(current);
      let parent = parents.get(selected) ?? null;
      while (parent) {
        next.delete(parent);
        parent = parents.get(parent) ?? null;
      }
      return next;
    });
  }, [selected, nodes]);
  useEffect(() => {
    if (!selected) return;
    document.querySelector(`[data-occurrence="${cssEscape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, nodes, collapsed]);
  const render = (parent: string | null, depth: number): ReactNode =>
    (byParent.get(parent) ?? []).map((node) => {
      const point = points[node.occurrenceId];
      const name = node.definitionName || node.occurrenceName || "(unnamed)";
      const children = byParent.get(node.occurrenceId) ?? [];
      const open = !collapsed.has(node.occurrenceId);
      return (
        <div key={node.occurrenceId}>
          <div className="flex items-stretch" style={{ paddingLeft: 8 + depth * 14 }}>
            {children.length > 0 ? (
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${name} ${node.occurrenceId}`}
                data-disclosure={node.occurrenceId}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(node.occurrenceId)) next.delete(node.occurrenceId);
                    else next.add(node.occurrenceId);
                    return next;
                  })
                }
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (event.key === "ArrowLeft") next.add(node.occurrenceId);
                    else next.delete(node.occurrenceId);
                    return next;
                  });
                }}
                className="w-6 shrink-0 text-xs text-faint"
              >
                {open ? "–" : "+"}
              </button>
            ) : (
              <span className="w-6 shrink-0" />
            )}
            <button
              type="button"
              data-occurrence={node.occurrenceId}
              data-parent-occurrence={node.parentOccurrenceId ?? ""}
              data-definition={name}
              data-occurrence-name={node.occurrenceName}
              data-selected={selected === node.occurrenceId ? "yes" : "no"}
              data-expanded={children.length > 0 && open ? "yes" : "no"}
              data-screen-x={point ? String(Math.round(point.x)) : undefined}
              data-screen-y={point ? String(Math.round(point.y)) : undefined}
              onClick={() => onSelect(node.occurrenceId)}
              className={
                selected === node.occurrenceId
                  ? "flex min-w-0 flex-1 items-center gap-2 bg-surface-2 px-2 py-1.5 text-left text-sm text-fg"
                  : "flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm text-muted hover:bg-bg hover:text-fg"
              }
            >
              <span className="font-mono text-[10px] text-faint">{node.isAssembly ? "asm" : "part"}</span>
              <span className="truncate">{name}</span>
            </button>
          </div>
          {children.length > 0 && open ? render(node.occurrenceId, depth + 1) : null}
        </div>
      );
    });
  return <div data-xde-tree="yes">{render(null, 0)}</div>;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function highlightSet(nodes: XdeNode[], selected: string | null): Set<string> {
  const set = new Set<string>();
  if (!selected) return set;
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentOccurrenceId) continue;
    const list = children.get(node.parentOccurrenceId) ?? [];
    list.push(node.occurrenceId);
    children.set(node.parentOccurrenceId, list);
  }
  const walk = (id: string) => {
    if (set.has(id)) return;
    set.add(id);
    for (const child of children.get(id) ?? []) walk(child);
  };
  walk(selected);
  return set;
}

function materialColor(rgb: [number, number, number] | null): THREE.Color {
  const color = new THREE.Color();
  if (!rgb) {
    color.setRGB(0.62, 0.58, 0.52);
    return color;
  }
  color.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
  return color;
}

function matrixFromRowMajor3x4(values: number[]): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  matrix.set(
    values[0] ?? 1,
    values[1] ?? 0,
    values[2] ?? 0,
    values[3] ?? 0,
    values[4] ?? 0,
    values[5] ?? 1,
    values[6] ?? 0,
    values[7] ?? 0,
    values[8] ?? 0,
    values[9] ?? 0,
    values[10] ?? 1,
    values[11] ?? 0,
    0,
    0,
    0,
    1,
  );
  return matrix;
}

function formatBox(positions: Float32Array): string {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index] ?? 0;
    const y = positions[index + 1] ?? 0;
    const z = positions[index + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return [minX, minY, minZ, maxX, maxY, maxZ].map((value) => value.toFixed(4)).join(",");
}