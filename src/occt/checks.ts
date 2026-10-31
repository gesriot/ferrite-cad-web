import { EXPECTED_TUBE_VOLUME, type Inspect } from "./brep.ts";

const BBOX: { min: [number, number, number]; max: [number, number, number] } = {
  min: [-10, -10, 0],
  max: [10, 10, 20],
};

export function tubeErrors(info: Inspect): string[] {
  const errors: string[] = [];
  if (!info.valid) errors.push("BRepCheck_Analyzer rejected the shape");
  if (!info.solidValid) errors.push("BRepCheck_Analyzer rejected the solid");
  if (info.solids !== 1) errors.push(`expected 1 solid, got ${info.solids}`);
  if (info.solidType !== "TopAbs_SOLID") errors.push(`solid ShapeType is ${info.solidType}`);
  const delta = Math.abs(info.volume - EXPECTED_TUBE_VOLUME);
  if (!(delta < 1e-6)) {
    errors.push(`volume ${info.volume} != ${EXPECTED_TUBE_VOLUME} (delta ${delta})`);
  }
  for (let i = 0; i < 3; i++) {
    if (Math.abs(info.bounds.min[i] - BBOX.min[i]) > 1e-6) errors.push(`bbox min[${i}]=${info.bounds.min[i]}`);
    if (Math.abs(info.bounds.max[i] - BBOX.max[i]) > 1e-6) errors.push(`bbox max[${i}]=${info.bounds.max[i]}`);
  }
  if ((info.surfaces.CYLINDRE ?? 0) < 2) errors.push(`cylindrical faces: ${info.surfaces.CYLINDRE ?? 0}`);
  if ((info.surfaces.PLANE ?? 0) < 2) errors.push(`planar faces: ${info.surfaces.PLANE ?? 0}`);
  if (!info.analyticOnly) errors.push(`non-analytic surfaces ${JSON.stringify(info.surfaces)}`);
  return errors;
}

export const STEP_MARKERS = ["ISO-10303-21", "MANIFOLD_SOLID_BREP", "CYLINDRICAL_SURFACE", "PLANE", "CLOSED_SHELL"] as const;

export function stepErrors(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  return STEP_MARKERS.filter((marker) => !text.includes(marker)).map((marker) => `STEP missing ${marker}`);
}
