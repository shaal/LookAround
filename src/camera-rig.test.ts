import { test } from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera } from "three";
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
