import { test } from "node:test";
import assert from "node:assert/strict";
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from "three";
import {
  BANK_CARD_WIDTH_CM,
  ScreenWindow,
  viewportWidthCm,
  type HeadPerspective,
} from "./screen-window.ts";

const calibration = {
  screenWidthCm: 53,
  eyeDistanceCm: 60,
  objectDistanceCm: 61,
};
const viewport = { width: 800, height: 600, screenWidth: 1600 };
const close = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);
function setup(rotated = false, perspective: HeadPerspective = "window") {
  const camera = new PerspectiveCamera(40, 4 / 3, 0.01, 100);
  const origin = new Vector3(3, 2, 8);
  const orientation = rotated
    ? new Quaternion().setFromEuler(new Euler(0.2, -0.4, 0.1))
    : new Quaternion();
  camera.position.copy(origin);
  camera.quaternion.copy(orientation);
  const world = (x: number, y: number, z: number) =>
    new Vector3(x, y, z)
      .multiplyScalar(0.1)
      .applyQuaternion(orientation)
      .add(origin);
  const window = new ScreenWindow(camera);
  window.capture(calibration, viewport, world(0, 0, -61), perspective);
  const project = (point: Vector3) => {
    camera.updateMatrixWorld();
    return point.clone().project(camera);
  };
  return { camera, window, world, project };
}

test("screen corners remain pinned under independent XYZ motion and a rotated screen frame", () => {
  for (const rotated of [false, true]) {
    const { window, world, project } = setup(rotated);
    for (const motion of [
      { x: 10, y: 0, z: 0 },
      { x: 0, y: -8, z: 0 },
      { x: 0, y: 0, z: -15 },
      { x: -7, y: 4, z: 20 },
    ]) {
      assert.ok(window.apply(motion));
      for (const x of [-1, 1])
        for (const y of [-1, 1]) {
          const projected = project(world(x * 13.25, y * 9.9375, -60));
          close(projected.x, x);
          close(projected.y, y);
        }
    }
  }
});

test("points behind and in front of the screen have opposite correct parallax", () => {
  const { window, world, project } = setup();
  window.apply({ x: 10, y: 0, z: 0 });
  assert.ok(project(world(0, 0, -120)).x > 0);
  assert.ok(project(world(0, 0, -30)).x < 0);
  close(project(world(0, 0, -60)).x, 0);
});

test("leaning toward the screen moves the camera forward and preserves screen-relative scale", () => {
  const { camera, window, world, project } = setup();
  const width = () =>
    project(world(5, 0, -120)).x - project(world(-5, 0, -120)).x;
  const initial = width(),
    startZ = camera.position.z;
  window.apply({ x: 0, y: 0, z: -10 });
  close(camera.position.z, startZ - 1);
  close(window.eyeDistanceCm, 50);
  close(width() / initial, 50 / 110 / (60 / 120));
});

test("clutch rebasing preserves both pose and projection and does not rescale the world", () => {
  const { camera, window } = setup();
  window.apply({ x: 7, y: 2, z: -20 });
  const p = camera.position.clone(),
    q = camera.quaternion.clone(),
    projection = camera.projectionMatrix.clone();
  window.rebase({ x: 20, y: -5, z: 10 });
  window.apply({ x: 20, y: -5, z: 10 });
  close(camera.position.distanceTo(p), 0);
  close(camera.quaternion.angleTo(q), 0);
  camera.projectionMatrix.elements.forEach((value, i) =>
    close(value, projection.elements[i]),
  );
  window.apply({ x: 21, y: -5, z: 10 });
  close(camera.position.x - p.x, 0.1);
});

test("resize updates the fixed-plane projection without a new tracking frame", () => {
  const { camera, window, world, project } = setup();
  window.apply({ x: 7, y: 3, z: 5 });
  const p = camera.position.clone();
  window.resize({ width: 400, height: 300, screenWidth: 1600 });
  close(camera.position.distanceTo(p), 0);
  const corner = project(world(6.625, 4.96875, -60));
  close(corner.x, 1);
  close(corner.y, 1);
  const inverse = camera.projectionMatrix
    .clone()
    .multiply(camera.projectionMatrixInverse);
  inverse.elements.forEach((value, i) => close(value, i % 5 === 0 ? 1 : 0));
});

test("impossible or nonfinite eye distances freeze the last valid pose and projection", () => {
  const { camera, window } = setup();
  const p = camera.position.clone(),
    projection = camera.projectionMatrix.clone();
  assert.equal(window.apply({ x: 0, y: 0, z: -60 }), false);
  assert.equal(window.apply({ x: NaN, y: 0, z: 0 }), false);
  assert.ok(camera.position.equals(p));
  assert.ok(camera.projectionMatrix.equals(projection));
});

test("matching a bank card gives physical canvas width and compensates browser zoom", () => {
  const measured = {
    ...calibration,
    pixelsPerCm: 256.8 / BANK_CARD_WIDTH_CM,
    calibrationPixelRatio: 1,
  };
  close(
    viewportWidthCm(measured, {
      width: 600,
      height: 400,
      screenWidth: 1600,
      pixelRatio: 1,
    }),
    20,
  );
  close(
    viewportWidthCm(measured, {
      width: 300,
      height: 200,
      screenWidth: 1600,
      pixelRatio: 2,
    }),
    20,
  );
  close(viewportWidthCm({ ...measured, pixelsPerCm: -1 }, viewport), 26.5);
});

test("moving-camera perspective enlarges a fixed object on approach and lets it leave center", () => {
  for (const rotated of [false, true]) {
    const { camera, window, world, project } = setup(rotated, "camera");
    const orientation = camera.quaternion.clone();
    const projection = camera.projectionMatrix.clone();
    const pixelWidth = () =>
      ((project(world(5, 0, -61)).x - project(world(-5, 0, -61)).x) *
        viewport.width) /
      2;
    const initial = pixelWidth();
    window.apply({ x: 0, y: 0, z: -10 });
    close(pixelWidth() / initial, 61 / 51);
    window.apply({ x: 0, y: 0, z: 10 });
    close(pixelWidth() / initial, 61 / 71);
    window.apply({ x: 10, y: -8, z: -10 });
    const shifted = project(world(0, 0, -61));
    assert.ok(shifted.x < 0);
    assert.ok(shifted.y < 0);
    assert.ok(camera.quaternion.equals(orientation));
    assert.ok(camera.projectionMatrix.equals(projection));
    window.apply({ x: 30, y: 0, z: 0 });
    assert.ok(project(world(0, 0, -61)).x < -1);
  }
});

test("changing perspective preserves applied pose, frame, scale and clutch; neutral projections agree", () => {
  const { camera, window } = setup(true, "camera");
  const neutralProjection = camera.projectionMatrix.clone();
  window.setPerspective("window");
  assert.ok(camera.projectionMatrix.equals(neutralProjection));
  window.apply({ x: 8, y: -5, z: -12 });
  const position = camera.position.clone();
  const orientation = camera.quaternion.clone();
  const frame = window.frame;
  const windowProjection = camera.projectionMatrix.clone();
  window.setPerspective("camera");
  assert.ok(camera.position.equals(position));
  assert.ok(camera.quaternion.equals(orientation));
  assert.ok(window.frame.origin.equals(frame.origin));
  assert.ok(window.frame.eye.equals(frame.eye));
  close(window.frame.unitsPerCm, frame.unitsPerCm);
  assert.ok(!camera.projectionMatrix.equals(windowProjection));
  for (const mode of ["window", "camera"] as const) {
    window.setPerspective(mode);
    const projection = camera.projectionMatrix.clone();
    window.rebase({ x: -20, y: 10, z: 6 });
    window.apply({ x: -20, y: 10, z: 6 });
    assert.ok(camera.position.equals(position));
    assert.ok(camera.projectionMatrix.equals(projection));
  }
  window.setPerspective("window");
  assert.ok(camera.projectionMatrix.equals(windowProjection));
});

test("moving-camera resize and invalid input retain pose and a valid inverse projection", () => {
  const { camera, window } = setup(true, "camera");
  window.apply({ x: 8, y: -3, z: -10 });
  const position = camera.position.clone();
  const xScale = camera.projectionMatrix.elements[0];
  window.resize({ width: 400, height: 300, screenWidth: 1600 });
  assert.ok(camera.position.equals(position));
  close(camera.projectionMatrix.elements[0], xScale * 2);
  const projection = camera.projectionMatrix.clone();
  assert.equal(window.apply({ x: 0, y: 0, z: -60 }), false);
  assert.equal(window.apply({ x: NaN, y: 0, z: 0 }), false);
  assert.ok(camera.position.equals(position));
  assert.ok(camera.projectionMatrix.equals(projection));
  const inverse = projection.multiply(camera.projectionMatrixInverse);
  inverse.elements.forEach((value, i) => close(value, i % 5 === 0 ? 1 : 0));
});
