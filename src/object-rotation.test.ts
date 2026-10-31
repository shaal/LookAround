import { test } from "node:test";
import assert from "node:assert/strict";
import { Quaternion } from "three";
import { ObjectRotation } from "./object-rotation.ts";

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
