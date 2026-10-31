import { test } from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3 } from "three";
import { CameraRig } from "./camera-rig.ts";

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
    camera.position.distanceTo(base.clone().addScaledVector(right, 1.15)) <
      1e-8,
  );
  assert.ok(camera.quaternion.equals(orientation));
  rig.update({ x: 0, y: 0 }, 1 / 60);
  assert.ok(camera.position.distanceTo(base) < 1e-8);
});
test("optional eyes rotate independently of translation axes; blinks hold orientation", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  rig.setMode("position");
  const base = camera.position.clone(),
    q = camera.quaternion.clone();
  const right = new Vector3(1, 0, 0).applyQuaternion(q);
  rig.update({ x: 0.5, y: 0 }, 1 / 60, { x: 0.8, y: 0.2 });
  assert.ok(camera.quaternion.angleTo(q) > 0.1);
  const eyeRotation = camera.quaternion.clone();
  rig.update({ x: 1, y: 0 }, 1 / 60, null);
  assert.ok(camera.quaternion.equals(eyeRotation));
  assert.ok(
    camera.position.distanceTo(base.addScaledVector(right, 1.15)) < 1e-8,
  );
  const held = camera.position.clone();
  rig.update(null, 1, { x: 0, y: 0 });
  assert.ok(camera.position.equals(held));
  assert.ok(camera.quaternion.equals(eyeRotation));
});
test("clutch anchoring preserves a nonzero absolute input across manual movement and mode changes", () => {
  const camera = new PerspectiveCamera();
  const rig = new CameraRig(camera);
  const motion = { x: 0.7, y: -0.2 },
    eyes = { x: 0.3, y: -0.1 };
  rig.setMode("position");
  rig.update(motion, 1 / 60, eyes);
  rig.drag(30, 10);
  const p = camera.position.clone(),
    q = camera.quaternion.clone();
  rig.rebase(motion, eyes);
  rig.update(motion, 1 / 60, eyes);
  assert.ok(camera.position.distanceTo(p) < 1e-8);
  assert.ok(camera.quaternion.angleTo(q) < 1e-7);
  rig.setMode("look");
  const look = camera.quaternion.clone();
  rig.rebase(motion);
  rig.update(motion, 1 / 60);
  assert.ok(camera.quaternion.angleTo(look) < 1e-7);
});
