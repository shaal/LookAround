import { test } from "node:test";
import assert from "node:assert/strict";
import { Group, PerspectiveCamera, Vector3 } from "three";
import { CameraRig } from "./camera-rig.ts";
import { ObjectRotation } from "./object-rotation.ts";
import type { ViewMode } from "./camera-rig.ts";
import type { HeadPerspective } from "./screen-window.ts";

const navigationModes: [ViewMode, HeadPerspective][] = [
  ["orbit", "camera"],
  ["look", "camera"],
  ["position", "camera"],
  ["position", "window"],
];
function navigationSetup(
  mode: ViewMode,
  perspective: HeadPerspective = "camera",
) {
  const camera = new PerspectiveCamera(40, 4 / 3, 0.01, 100);
  const rig = new CameraRig(camera);
  rig.resize({ width: 800, height: 600, screenWidth: 1600 });
  rig.setHeadPerspective(perspective);
  rig.setMode(mode);
  return { camera, rig };
}

test("sustained deflection orbits more than 360 degrees without changing distance", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  const distance = camera.position.distanceTo(rig.target);
  let previous = rig.azimuth,
    accumulated = 0;
  for (let i = 0; i < 60 * 8; i++) {
    rig.update({ x: 1, y: 0 }, 1 / 60);
    let delta = rig.azimuth - previous;
    if (delta < -180) delta += 360;
    accumulated += delta;
    previous = rig.azimuth;
  }
  assert.ok(accumulated > 360);
  assert.ok(Math.abs(distance - camera.position.distanceTo(rig.target)) < 1e-8);
});
test("look changes orientation at a fixed position; face loss freezes the pose", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  const position = camera.position.clone(),
    orientation = camera.quaternion.clone();
  rig.setMode("look");
  rig.update({ x: 0.5, y: 0.2 }, 1 / 60);
  assert.ok(camera.position.equals(position));
  assert.ok(camera.quaternion.angleTo(orientation) > 0.1);
  const frozen = camera.quaternion.clone();
  rig.update(null, 1);
  assert.ok(camera.quaternion.equals(frozen));
});
test("look to orbit transition preserves position and smoothly faces the object", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  rig.setMode("look");
  rig.update({ x: 1, y: 0 }, 1 / 60);
  const position = camera.position.clone(),
    orientation = camera.quaternion.clone();
  rig.setMode("orbit");
  assert.ok(camera.quaternion.equals(orientation));
  for (let i = 0; i < 20; i++) rig.update(null, 1 / 60);
  assert.ok(camera.position.equals(position));
  assert.ok(
    camera
      .getWorldDirection(position.clone())
      .dot(rig.target.clone().sub(camera.position).normalize()) > 0.9999,
  );
});
test("rebasing look mode retains the visible view when tracking resumes at neutral", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  rig.setMode("look");
  rig.update({ x: 0.5, y: 0 }, 1 / 60);
  rig.rebase();
  const current = camera.quaternion.clone();
  rig.update({ x: 0, y: 0 }, 1 / 60);
  assert.ok(camera.quaternion.equals(current));
});

test("head-camera holds a camera-local displacement without drift or orientation changes", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  rig.setMode("position");
  const base = camera.position.clone(),
    orientation = camera.quaternion.clone();
  const right = new Vector3(1, 0, 0).applyQuaternion(orientation);
  for (let i = 0; i < 600; i++) rig.update({ x: 1, y: 0 }, 1 / 60);
  assert.ok(
    camera.position.distanceTo(base.clone().addScaledVector(right, 6.8 / 61)) <
      1e-8,
  );
  assert.ok(camera.quaternion.equals(orientation));
  rig.update({ x: 0, y: 0 }, 1 / 60);
  assert.ok(camera.position.distanceTo(base) < 1e-8);
});
test("gaze rotates the object while camera translation and orientation stay independent", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  rig.setMode("position");
  const base = camera.position.clone(),
    q = camera.quaternion.clone();
  const right = new Vector3(1, 0, 0).applyQuaternion(q);
  const object = new Group();
  const gaze = new ObjectRotation(object.quaternion);
  rig.update({ x: 0.5, y: 0 }, 1 / 60);
  gaze.update({ x: 0.8, y: 0.2 });
  assert.ok(object.quaternion.angleTo(q.clone().identity()) > 0.1);
  assert.ok(camera.quaternion.equals(q));
  const eyeRotation = object.quaternion.clone();
  rig.update({ x: 1, y: 0 }, 1 / 60);
  gaze.update(null);
  assert.ok(object.quaternion.equals(eyeRotation));
  assert.ok(
    camera.position.distanceTo(base.addScaledVector(right, 6.8 / 61)) < 1e-8,
  );
  const held = camera.position.clone();
  rig.update(null, 1);
  assert.ok(camera.position.equals(held));
  assert.ok(camera.quaternion.equals(q));
});

test("leaving head camera restores the symmetric projection", () => {
  const camera = new PerspectiveCamera(40, 4 / 3, 0.01, 100);
  const rig = new CameraRig(camera);
  rig.resize({ width: 800, height: 600, screenWidth: 1600 });
  const original = camera.projectionMatrix.clone();
  rig.setMode("position");
  rig.update({ x: 7, y: 3, z: -10 }, 1 / 60);
  assert.ok(!camera.projectionMatrix.equals(original));
  rig.setMode("look");
  assert.ok(camera.projectionMatrix.equals(original));
});
test("clutch anchoring preserves a nonzero absolute input across manual movement and mode changes", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  const motion = { x: 0.7, y: -0.2 };
  rig.setMode("position");
  rig.update(motion, 1 / 60);
  rig.drag(30, 10);
  const p = camera.position.clone(),
    q = camera.quaternion.clone();
  rig.rebase(motion);
  rig.update(motion, 1 / 60);
  assert.ok(camera.position.distanceTo(p) < 1e-8);
  assert.ok(camera.quaternion.angleTo(q) < 1e-7);
  rig.setMode("look");
  const look = camera.quaternion.clone();
  rig.rebase(motion);
  rig.update(motion, 1 / 60);
  assert.ok(camera.quaternion.angleTo(look) < 1e-7);
});

test("head perspective selection takes effect while held and survives navigation without recapturing", () => {
  const camera = new PerspectiveCamera(40, 4 / 3, 0.01, 100);
  const rig = new CameraRig(camera);
  rig.resize({ width: 800, height: 600, screenWidth: 1600 });
  assert.equal(rig.headPerspective, "camera");
  const orbitProjection = camera.projectionMatrix.clone();
  rig.setHeadPerspective("window");
  assert.ok(camera.projectionMatrix.equals(orbitProjection));
  rig.setMode("position");
  const input = { x: 8, y: -4, z: -10 };
  rig.update(input, 1 / 60);
  rig.drag(20, -8);
  rig.zoom(60);
  rig.rebase(input);
  const position = camera.position.clone();
  const orientation = camera.quaternion.clone();
  const scale = rig.screenFrame.unitsPerCm;
  const frame = rig.screenFrame.origin.clone();
  const windowProjection = camera.projectionMatrix.clone();
  rig.setHeadPerspective("camera");
  rig.update(null, 1 / 60);
  assert.ok(!camera.projectionMatrix.equals(windowProjection));
  assert.ok(camera.position.equals(position));
  assert.ok(camera.quaternion.equals(orientation));
  assert.ok(rig.screenFrame.origin.equals(frame));
  assert.equal(rig.screenFrame.unitsPerCm, scale);
  rig.update(input, 1 / 60);
  assert.ok(camera.position.equals(position));
  rig.setHeadPerspective("window");
  assert.ok(camera.projectionMatrix.equals(windowProjection));
  rig.setMode("look");
  assert.ok(camera.projectionMatrix.equals(orbitProjection));
  rig.setMode("position");
  assert.equal(rig.screenFrame.perspective, "window");
});

test("manual orbit and zoom have identical poses in every tracking mode", () => {
  const results = navigationModes.map(([mode, perspective]) => {
    const { camera, rig } = navigationSetup(mode, perspective);
    const distance = camera.position.distanceTo(rig.target);
    rig.drag(40, -15);
    assert.ok(
      Math.abs(camera.position.distanceTo(rig.target) - distance) < 1e-8,
    );
    const orbitPosition = camera.position.clone();
    const orbitOrientation = camera.quaternion.clone();
    rig.zoom(-120);
    assert.ok(
      Math.abs(
        camera.position.distanceTo(rig.target) - distance * Math.exp(-0.12),
      ) < 1e-8,
    );
    assert.ok(camera.quaternion.angleTo(orbitOrientation) < 1e-7);
    return {
      orbitPosition,
      orbitOrientation,
      zoomPosition: camera.position.clone(),
    };
  });
  for (const result of results) {
    assert.ok(result.orbitPosition.distanceTo(results[0].orbitPosition) < 1e-8);
    assert.ok(
      result.orbitOrientation.angleTo(results[0].orbitOrientation) < 1e-7,
    );
    assert.ok(result.zoomPosition.distanceTo(results[0].zoomPosition) < 1e-8);
  }
});

test("screen-space pan follows the cursor equally under every lens and preserves orientation", () => {
  for (const [mode, perspective] of navigationModes) {
    const { camera, rig } = navigationSetup(mode, perspective);
    if (mode === "look") rig.update({ x: 0.7, y: -0.3 }, 1 / 60);
    if (mode === "position") rig.update({ x: 8, y: -4, z: -10 }, 1 / 60);
    const position = camera.position.clone(),
      target = rig.target.clone(),
      q = camera.quaternion.clone();
    const point = camera
      .getWorldDirection(new Vector3())
      .multiplyScalar(position.distanceTo(target))
      .add(position);
    camera.updateMatrixWorld(true);
    const before = point.clone().project(camera);
    rig.pan(50, -24);
    camera.updateMatrixWorld(true);
    const after = point.clone().project(camera);
    assert.ok(Math.abs(after.x - before.x - 100 / 800) < 1e-8);
    assert.ok(Math.abs(after.y - before.y - 48 / 600) < 1e-8);
    assert.ok(
      camera.position
        .clone()
        .sub(position)
        .distanceTo(rig.target.clone().sub(target)) < 1e-8,
    );
    assert.ok(camera.quaternion.angleTo(q) < 1e-7);
  }
});

test("manual navigation preserves off-center aim and never snaps at gesture start", () => {
  for (const [mode, perspective] of navigationModes) {
    const { camera, rig } = navigationSetup(mode, perspective);
    if (mode === "look") rig.update({ x: 0.8, y: 0.4 }, 1 / 60);
    if (mode === "position") rig.update({ x: 9, y: 4, z: -8 }, 1 / 60);
    const position = camera.position.clone(),
      q = camera.quaternion.clone(),
      projection = camera.projectionMatrix.clone();
    rig.drag(0, 0);
    rig.pan(0, 0);
    rig.zoom(0);
    assert.ok(camera.position.equals(position));
    assert.ok(camera.quaternion.equals(q));
    rig.drag(0.001, 0);
    assert.ok(camera.position.distanceTo(position) < 0.001);
    assert.ok(camera.quaternion.angleTo(q) < 0.001);
    assert.ok(camera.projectionMatrix.equals(projection));
  }
});

test("resuming a held head or look input retains the manually orbited, panned and zoomed view", () => {
  for (const [mode, perspective] of navigationModes) {
    const { camera, rig } = navigationSetup(mode, perspective);
    const input =
      mode === "position" ? { x: 8, y: -4, z: -10 } : { x: 0.6, y: -0.3 };
    rig.update(input, 1 / 60);
    rig.drag(30, -12);
    rig.pan(-24, 15);
    rig.zoom(-80);
    const position = camera.position.clone(),
      q = camera.quaternion.clone(),
      projection = camera.projectionMatrix.clone();
    rig.rebase(input);
    rig.update(mode === "orbit" ? { x: 0, y: 0 } : input, 1 / 60);
    assert.ok(camera.position.distanceTo(position) < 1e-8);
    assert.ok(camera.quaternion.angleTo(q) < 1e-7);
    assert.ok(camera.projectionMatrix.equals(projection));
  }
});

test("dolly limits and resetting the pan focus are shared across modes", () => {
  for (const [mode, perspective] of navigationModes) {
    const { camera, rig } = navigationSetup(mode, perspective);
    rig.pan(140, -40);
    rig.zoom(-1e6);
    assert.ok(Math.abs(camera.position.distanceTo(rig.target) - 1.8) < 1e-8);
    rig.zoom(1e6);
    assert.ok(Math.abs(camera.position.distanceTo(rig.target) - 18) < 1e-8);
    rig.reset();
    assert.ok(rig.target.equals(new Vector3(0, 0.1, 0)));
    assert.ok(Math.abs(camera.position.distanceTo(rig.target) - 6.8) < 1e-8);
  }
});
