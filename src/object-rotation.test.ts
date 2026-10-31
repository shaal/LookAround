import { test } from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import { ObjectRotation, smoothGazeSignal } from "./object-rotation.ts";

test("holding gaze holds the object angle without drift, and neutral restores its starting angle", () => {
  const rotation = new Quaternion();
  const controller = new ObjectRotation(rotation);
  controller.update({ x: 0.7, y: -0.3 });
  const held = rotation.clone();
  for (let i = 0; i < 600; i++) controller.update({ x: 0.7, y: -0.3 });
  assert.ok(rotation.equals(held));
  controller.update(null);
  assert.ok(rotation.equals(held));
  controller.update({ x: 0, y: 0 });
  assert.ok(rotation.angleTo(new Quaternion()) < 1e-8);
});

test("rebasing and disabling gaze preserve the visible angle; reset restores the model", () => {
  const rotation = new Quaternion();
  const controller = new ObjectRotation(rotation);
  const signal = { x: 0.7, y: -0.3 };
  controller.update(signal);
  const held = rotation.clone();
  controller.rebase(signal);
  controller.update(signal);
  assert.ok(rotation.angleTo(held) < 1e-7);
  controller.rebase();
  controller.update(null);
  assert.ok(rotation.angleTo(held) < 1e-7);
  controller.reset();
  assert.ok(rotation.angleTo(new Quaternion()) < 1e-8);
});

test("continuous gaze turns through full revolutions and centered eyes hold the final angle", () => {
  const rotation = new Quaternion();
  const controller = new ObjectRotation(rotation);
  controller.setMode("continuous");
  let previous = 0,
    total = 0;
  for (let i = 0; i < 60 * 8; i++) {
    controller.update({ x: 1, y: 0 }, 1 / 60);
    const forward = new Vector3(0, 0, 1).applyQuaternion(rotation);
    const yaw = Math.atan2(forward.x, forward.z);
    total += Math.atan2(Math.sin(yaw - previous), Math.cos(yaw - previous));
    previous = yaw;
  }
  assert.ok(total > Math.PI * 2);
  const held = rotation.clone();
  for (let i = 0; i < 600; i++) controller.update({ x: 0, y: 0 }, 1 / 60);
  assert.ok(rotation.equals(held));
  assert.ok(rotation.angleTo(new Quaternion()) > 0.1);
});

test("centering stops continuous gaze immediately even with maximum smoothing", () => {
  const previous = { x: 0.8, y: -0.5 };
  const stopped = smoothGazeSignal(
    previous,
    { x: 0, y: 0 },
    1 / 60,
    1,
    "continuous",
  );
  assert.deepEqual(stopped, { x: 0, y: 0 });
  const vertical = smoothGazeSignal(
    previous,
    { x: 0, y: 0.7 },
    1 / 60,
    1,
    "continuous",
  );
  assert.equal(vertical.x, 0);
  assert.ok(vertical.y !== 0);
  const horizontal = smoothGazeSignal(
    previous,
    { x: 0.5, y: 0 },
    1 / 60,
    1,
    "continuous",
  );
  assert.equal(horizontal.y, 0);
  const following = smoothGazeSignal(
    previous,
    { x: 0, y: 0 },
    1 / 60,
    1,
    "follow",
  );
  assert.ok(following.x > 0);
  const rotation = new Quaternion();
  const controller = new ObjectRotation(rotation);
  controller.setMode("continuous");
  controller.update(previous, 1 / 60);
  const held = rotation.clone();
  controller.update(stopped, 1 / 60);
  assert.ok(rotation.equals(held));
});

test("continuous diagonal rotation has the same speed at different frame rates", () => {
  const run = (fps: number) => {
    const rotation = new Quaternion();
    const controller = new ObjectRotation(rotation);
    controller.setMode("continuous");
    for (let i = 0; i < fps * 3; i++)
      controller.update({ x: 0.6, y: -0.4 }, 1 / fps);
    return rotation;
  };
  assert.ok(run(20).angleTo(run(120)) < 1e-7);
});

test("switching between follow and continuous preserves the current angle at nonzero gaze", () => {
  const rotation = new Quaternion();
  const controller = new ObjectRotation(rotation);
  const signal = { x: 0.7, y: -0.3 };
  controller.update(signal);
  const following = rotation.clone();
  controller.setMode("continuous", signal);
  assert.ok(rotation.equals(following));
  controller.update({ x: 0, y: 0 });
  assert.ok(rotation.equals(following));
  for (let i = 0; i < 60; i++) controller.update(signal, 1 / 60);
  const accumulated = rotation.clone();
  controller.rebase(signal);
  controller.update({ x: 0, y: 0 });
  assert.ok(rotation.equals(accumulated));
  controller.setMode("follow", signal);
  controller.update(signal);
  assert.ok(rotation.angleTo(accumulated) < 1e-7);
});

test("continuous gaze holds on missing or invalid input and does not catch up after a long frame", () => {
  const rotation = new Quaternion();
  const controller = new ObjectRotation(rotation);
  controller.setMode("continuous");
  controller.update({ x: 0.7, y: -0.3 });
  const held = rotation.clone();
  controller.update(null, 10);
  controller.update({ x: NaN, y: 0 }, 1 / 60);
  controller.update({ x: 1, y: 0 }, NaN);
  controller.update({ x: 1, y: 0 }, -1);
  assert.ok(rotation.equals(held));
  controller.update({ x: 1, y: 0 }, 10);
  assert.ok(Math.abs(rotation.angleTo(held) - 1.1 * 0.05) < 1e-7);
  controller.reset();
  controller.update({ x: 0, y: 0 });
  assert.ok(rotation.equals(new Quaternion()));
});

test("continuous gaze supports both axes, reverses direction, and turns faster with more deflection", () => {
  const rotation = new Quaternion();
  const controller = new ObjectRotation(rotation);
  controller.setMode("continuous");
  controller.update({ x: 0.4, y: 0 }, 1 / 60);
  const slower = rotation.angleTo(new Quaternion());
  assert.ok(new Vector3(0, 0, 1).applyQuaternion(rotation).x > 0);
  controller.update({ x: -0.4, y: 0 }, 1 / 60);
  assert.ok(rotation.angleTo(new Quaternion()) < 1e-7);
  controller.update({ x: 0.8, y: 0 }, 1 / 60);
  assert.ok(Math.abs(rotation.angleTo(new Quaternion()) - 2 * slower) < 1e-7);
  controller.reset();
  controller.update({ x: 0, y: 0.5 }, 1 / 60);
  assert.ok(new Vector3(0, 0, 1).applyQuaternion(rotation).y < 0);
});
