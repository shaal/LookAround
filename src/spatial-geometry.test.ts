import { test } from "node:test";
import assert from "node:assert/strict";
import { Euler, PerspectiveCamera, Vector3 } from "three";
import { ScreenWindow, type HeadPerspective } from "./screen-window.ts";
import { CameraRig } from "./camera-rig.ts";
import {
  boxCorners,
  screenIntersection,
  spatialGeometry,
} from "./spatial-geometry.ts";

const close = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);

function setup(perspective: HeadPerspective = "window") {
  const camera = new PerspectiveCamera(40, 4 / 3, 0.01, 100);
  camera.position.set(3, 2, 8);
  camera.quaternion.setFromEuler(new Euler(0.2, -0.4, 0.1));
  const origin = camera.position.clone();
  const rotation = camera.quaternion.clone();
  const world = (point: Vector3) =>
    point.clone().multiplyScalar(0.1).applyQuaternion(rotation).add(origin);
  const window = new ScreenWindow(camera);
  window.capture(
    { screenWidthCm: 70.8, eyeDistanceCm: 46, objectDistanceCm: 61 },
    { width: 800, height: 600, screenWidth: 1600 },
    world(new Vector3(0, 0, -61)),
    perspective,
  );
  const corners = boxCorners(
    new Vector3(-5, -5, -63),
    new Vector3(5, 5, -59),
  ).map(world);
  return { camera, window, corners };
}

for (const perspective of ["window", "camera"] as const)
  test(`overview image agrees with the actual ${perspective} perspective under XYZ movement`, () => {
    const { camera, window, corners } = setup(perspective);
    for (const input of [
      { x: 0, y: 0, z: 0 },
      { x: 9, y: -4, z: -12 },
      { x: -8, y: 5, z: 18 },
    ]) {
      window.apply(input);
      camera.updateMatrixWorld();
      const geometry = spatialGeometry(window.frame, corners);
      close(geometry.center.z, -15);
      close(geometry.frame.eye.z, 46 + input.z);
      assert.ok(geometry.image);
      for (let i = 0; i < corners.length; i++) {
        const ndc = corners[i].clone().project(camera);
        close(geometry.image[i].x, (ndc.x * geometry.frame.widthCm) / 2);
        close(geometry.image[i].y, (ndc.y * geometry.frame.heightCm) / 2);
        close(geometry.image[i].z, 0);
      }
    }
  });

test("depth readout reveals the modest size change of a nearby behind-screen object", () => {
  const { window, corners } = setup();
  const neutral = spatialGeometry(window.frame, corners);
  close(neutral.depthScale!, 1);
  close(neutral.eyeToObjectCm, 61);
  window.apply({ x: 0, y: 0, z: -10 });
  const closer = spatialGeometry(window.frame, corners);
  close(closer.eyeToObjectCm, 51);
  close(closer.depthScale!, 36 / 51 / (46 / 61));
  assert.ok(closer.depthScale! < 1);
  window.apply({ x: 0, y: 0, z: 10 });
  assert.ok(spatialGeometry(window.frame, corners).depthScale! > 1);
});

test("overview follows applied pose across invalid input and clutch rebasing", () => {
  const { window, corners } = setup();
  window.apply({ x: 7, y: 2, z: -10 });
  const before = spatialGeometry(window.frame, corners);
  assert.equal(window.apply({ x: 100, y: 2, z: -50 }), false);
  assert.ok(window.frame.eye.equals(before.frame.eye));
  window.rebase({ x: -20, y: 9, z: 12 });
  window.apply({ x: -20, y: 9, z: 12 });
  const after = spatialGeometry(window.frame, corners);
  assert.ok(after.frame.eye.equals(before.frame.eye));
  close(after.depthScale!, before.depthScale!);
  // Reading or changing a snapshot must never move the real camera frame.
  after.frame.eye.set(0, 0, 0);
  after.frame.origin.set(0, 0, 0);
  assert.ok(window.frame.eye.equals(before.frame.eye));
  assert.ok(window.frame.origin.equals(before.frame.origin));
});

test("screen-plane objects retain their image scale, and points behind the eye have no image", () => {
  const eye = new Vector3(5, 2, 36);
  const point = new Vector3(7, 4, 0);
  assert.ok(screenIntersection(eye, point)!.equals(point));
  assert.equal(screenIntersection(eye, new Vector3(0, 0, 40)), null);
  const { window, corners } = setup();
  const geometry = spatialGeometry(window.frame, corners);
  const atScreen = corners.map((v) =>
    v
      .clone()
      .add(
        new Vector3(0, 0, 15 * geometry.frame.unitsPerCm).applyQuaternion(
          geometry.frame.orientation,
        ),
      ),
  );
  window.apply({ x: 0, y: 0, z: -15 });
  close(spatialGeometry(window.frame, atScreen).depthScale!, 1);
});

test("the overview's pre-tracking preview does not change the camera or its projection", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  rig.resize({ width: 800, height: 600, screenWidth: 1600 });
  const position = camera.position.clone();
  const projection = camera.projectionMatrix.clone();
  const preview = rig.screenFrame;
  assert.equal(preview.perspective, "camera");
  close(preview.eye.z, 46);
  assert.ok(camera.position.equals(position));
  assert.ok(camera.projectionMatrix.equals(projection));
  rig.setMode("position");
  close(rig.screenFrame.unitsPerCm, preview.unitsPerCm);
  close(rig.screenFrame.widthCm, preview.widthCm);
});

test("camera-perspective size readout grows on approach and shrinks on retreat", () => {
  const { window, corners } = setup("camera");
  window.apply({ x: 0, y: 0, z: -10 });
  close(spatialGeometry(window.frame, corners).depthScale!, 61 / 51);
  window.apply({ x: 0, y: 0, z: 10 });
  close(spatialGeometry(window.frame, corners).depthScale!, 61 / 71);
});

test("an object behind the camera cannot produce a mirrored overview image", () => {
  for (const perspective of ["window", "camera"] as const) {
    const { camera, window } = setup(perspective);
    const point = camera.position
      .clone()
      .add(new Vector3(0, 0, 1).applyQuaternion(camera.quaternion));
    const geometry = spatialGeometry(window.frame, [point]);
    assert.equal(geometry.image, null);
    assert.equal(geometry.depthScale, null);
  }
});
