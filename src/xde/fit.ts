import * as THREE from "three";

export type Vec3 = [number, number, number];

/**
 * Smallest camera distance along `direction` that keeps every corner inside
 * both the horizontal and vertical frustum. Near and far come from the
 * corners' camera-space depth, not from a fixed multiple of the distance.
 */
export function fitPerspective(options: {
  fov: number;
  aspect: number;
  center: Vec3;
  direction: Vec3;
  corners: Vec3[];
  margin?: number;
}): { distance: number; near: number; far: number; maxAbsX: number; maxAbsY: number } {
  const margin = options.margin ?? 0.96;
  if (!(options.aspect > 0) || !(options.fov > 0 && options.fov < 180)) {
    throw new Error("fit needs a positive aspect and a perspective FOV");
  }
  if (options.corners.length === 0) throw new Error("fit needs at least one corner");
  const direction = new THREE.Vector3(...options.direction);
  if (direction.lengthSq() === 0) throw new Error("fit direction is zero");
  direction.normalize();
  const center = new THREE.Vector3(...options.center);
  const corners = options.corners.map((corner) => new THREE.Vector3(...corner));
  const camera = new THREE.PerspectiveCamera(options.fov, options.aspect, 0.01, 1e9);
  const ndcAt = (distance: number) => {
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = 0.01;
    camera.far = Math.max(distance * 40, 1e6);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    let maxAbsX = 0;
    let maxAbsY = 0;
    for (const corner of corners) {
      const projected = corner.clone().project(camera);
      maxAbsX = Math.max(maxAbsX, Math.abs(projected.x));
      maxAbsY = Math.max(maxAbsY, Math.abs(projected.y));
    }
    return { maxAbsX, maxAbsY };
  };
  const radius = Math.max(...corners.map((corner) => corner.distanceTo(center)), 1);
  let high = Math.max(radius, 1);
  for (let guard = 0; guard < 40; guard += 1) {
    const ndc = ndcAt(high);
    if (Math.max(ndc.maxAbsX, ndc.maxAbsY) <= margin) break;
    high *= 1.5;
  }
  let low = high / 128;
  for (let step = 0; step < 32; step += 1) {
    const mid = (low + high) / 2;
    const ndc = ndcAt(mid);
    if (Math.max(ndc.maxAbsX, ndc.maxAbsY) > margin) low = mid;
    else high = mid;
  }
  const fitted = ndcAt(high);
  let nearDepth = Infinity;
  let farDepth = 0;
  for (const corner of corners) {
    const depth = -corner.clone().applyMatrix4(camera.matrixWorldInverse).z;
    if (depth > 0) {
      nearDepth = Math.min(nearDepth, depth);
      farDepth = Math.max(farDepth, depth);
    }
  }
  const near = Number.isFinite(nearDepth) ? Math.max(nearDepth * 0.5, 0.01) : 0.01;
  const far = Math.max(farDepth * 1.2, near + 1);
  return { distance: high, near, far, maxAbsX: fitted.maxAbsX, maxAbsY: fitted.maxAbsY };
}

export function boxCorners(min: Vec3, max: Vec3): Vec3[] {
  const corners: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
  return corners;
}
