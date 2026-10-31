import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { boxCorners, fitPerspective, type Vec3 } from "./fit.ts";

/** Display transform used by the assembly view: CAD Z-up becomes Three Y-up. */
function display(point: Vec3): Vec3 {
  return [point[0], point[2], -point[1]];
}

function frame(box: [number, number, number, number, number, number], width: number, height: number) {
  const raw = boxCorners([box[0], box[1], box[2]], [box[3], box[4], box[5]]).map(display);
  const center = new THREE.Vector3();
  for (const corner of raw) center.add(new THREE.Vector3(...corner));
  center.multiplyScalar(1 / raw.length);
  const fit = fitPerspective({
    fov: 38,
    aspect: width / height,
    center: [center.x, center.y, center.z],
    direction: [1, 0.7, 1],
    corners: raw,
  });
  const camera = new THREE.PerspectiveCamera(38, width / height, fit.near, fit.far);
  const direction = new THREE.Vector3(1, 0.7, 1).normalize();
  camera.position.copy(center).addScaledVector(direction, fit.distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  let maxAbsX = 0;
  let maxAbsY = 0;
  for (const corner of raw) {
    const projected = new THREE.Vector3(...corner).project(camera);
    maxAbsX = Math.max(maxAbsX, Math.abs(projected.x));
    maxAbsY = Math.max(maxAbsY, Math.abs(projected.y));
  }
  return { fit, maxAbsX, maxAbsY };
}

const boxes = {
  plate: [0, 0, 0, 60, 40, 10] as [number, number, number, number, number, number],
  nested: [0, 0, 0, 50, 60, 20] as [number, number, number, number, number, number],
  rotated: [0, 20, 0, 100, 70, 25] as [number, number, number, number, number, number],
};

test("fit keeps plate corners inside a narrow and a wide frustum", () => {
  for (const [width, height] of [[280, 420], [800, 420]] as const) {
    const framed = frame(boxes.plate, width, height);
    assert.ok(framed.maxAbsX <= 1 && framed.maxAbsY <= 1, `${width}x${height} x=${framed.maxAbsX} y=${framed.maxAbsY}`);
    assert.ok(framed.fit.maxAbsX <= 0.96 && framed.fit.maxAbsY <= 0.96);
    assert.ok(framed.fit.near < framed.fit.far);
  }
});

test("fit is not a single huge multiplier of the vertical-only distance", () => {
  const framed = frame(boxes.plate, 280, 420);
  const size = new THREE.Vector3(60, 10, 40);
  const radius = size.length() * 0.5;
  const vertical = (radius / Math.tan((38 * Math.PI) / 360)) * 1.35;
  assert.ok(framed.fit.distance < vertical * 8, `distance ${framed.fit.distance} vs vertical ${vertical}`);
  assert.ok(framed.fit.distance > vertical);
});

test("nested and rotated bounds fit both aspects", () => {
  for (const box of [boxes.nested, boxes.rotated]) {
    for (const [width, height] of [[280, 420], [800, 420]] as const) {
      const framed = frame(box, width, height);
      assert.ok(framed.maxAbsX <= 1 && framed.maxAbsY <= 1, `${width}x${height} x=${framed.maxAbsX} y=${framed.maxAbsY}`);
    }
  }
});
