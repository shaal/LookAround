import { test } from "node:test";
import assert from "node:assert/strict";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import {
  controlSignal,
  deadzone,
  measureEye,
  neutralFromSamples,
  positionSignal,
  sampleFromFace,
  relativeAngles,
  rotationFromMatrix,
  smoothSignal,
  type Sample,
} from "./tracking-math.ts";

const close = (a: number, b: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);
const sample = (timestamp = 1000): Sample => ({
  rotation: new Quaternion(),
  position: new Vector3(0, 0, -60),
  eyeX: 0,
  eyeY: 0,
  eyesValid: true,
  timestamp,
});

test("head rotation is relative to a nonidentity neutral, with subject-right/down signs", () => {
  const neutral = new Quaternion().setFromEuler(new Euler(0.1, 0.3, 0.15));
  const right = neutral
    .clone()
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.2));
  const down = neutral
    .clone()
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.15));
  close(relativeAngles(right, neutral).x, 0.2);
  close(relativeAngles(right, neutral).y, 0);
  close(relativeAngles(down, neutral).y, 0.15);
});
test("matrix extraction removes scale and rejects invalid/missing transforms", () => {
  const q = new Quaternion().setFromEuler(new Euler(0.15, -0.2, 0.1));
  const matrix = new Matrix4().compose(
    new Vector3(1, 2, 3),
    q,
    new Vector3(3, 2, 4),
  );
  close(Math.abs(rotationFromMatrix(matrix.elements)!.dot(q)), 1);
  assert.equal(rotationFromMatrix([]), null);
  assert.equal(rotationFromMatrix(Array(16).fill(NaN)), null);
  assert.equal(rotationFromMatrix(Array(16).fill(0)), null);
});
test("eye measurements account for rectangular frames and roll", () => {
  const eye = [
    { x: 0.1, y: 0.2 },
    { x: 0.2, y: 0.3 },
    { x: 0.17, y: 0.27 },
    { x: 0.14, y: 0.2 },
    { x: 0.16, y: 0.3 },
  ];
  const a = measureEye(eye, [0, 1], 2, [3, 4], 1280, 720)!;
  const b = measureEye(
    eye.map((p) => ({ x: p.x * 2, y: p.y })),
    [0, 1],
    2,
    [3, 4],
    640,
    720,
  )!;
  close(a.x, b.x);
  close(a.y, b.y);
  const c = measureEye(eye, [1, 0], 2, [3, 4], 1280, 720)!;
  close(a.x, c.x);
});
test("quaternion sign flips do not cancel neutral calibration", () => {
  const a = sample(),
    b = sample();
  b.rotation.set(0, 0, 0, -1);
  close(Math.abs(neutralFromSamples([a, b]).rotation.w), 1);
});
test("face loss, stale capture, and eye-only blinks stop control; combined retains head", () => {
  const s = sample();
  s.rotation.setFromAxisAngle(new Vector3(0, 1, 0), -0.2);
  const n = neutralFromSamples([sample()]);
  assert.equal(controlSignal(null, n, "head", 1050, 1, 0.12, false), null);
  assert.equal(controlSignal(s, n, "head", 1300, 1, 0.12, false), null);
  s.eyesValid = false;
  assert.equal(controlSignal(s, n, "eyes", 1050, 1, 0.12, false), null);
  assert.ok(controlSignal(s, n, "combined", 1050, 1, 0.12, false)!.x > 0);
  const x = controlSignal(s, n, "head", 1050, 1, 0.12, false)!.x;
  close(controlSignal(s, n, "head", 1050, 1, 0.12, true)!.x, -x);
});
test("deadzone clamps input and smoothing is independent of frame rate", () => {
  close(deadzone(0.05, 0.12), 0);
  close(deadzone(2, 0.12), 1);
  close(deadzone(-2, 0.12), -1);
  const target = { x: 1, y: -1 };
  let a = { x: 0, y: 0 },
    b = { x: 0, y: 0 };
  for (let i = 0; i < 60; i++) a = smoothSignal(a, target, 1 / 60, 0.5);
  for (let i = 0; i < 30; i++) b = smoothSignal(b, target, 1 / 30, 0.5);
  close(a.x, b.x);
  close(a.y, b.y);
});

test("head-position input maps XYZ to centimeters with no normalized steering gain or saturation", () => {
  const n = neutralFromSamples([sample()]);
  const s = sample();
  s.rotation.setFromEuler(new Euler(0.3, -0.4, 0.1));
  const stationary = positionSignal(s, n, 1050, 60)!;
  close(stationary.x, 0);
  close(stationary.y, 0);
  s.position.x = -7.2;
  s.position.y = 5.4;
  const initial = positionSignal(s, n, 1050, 60)!;
  close(initial.x, 7.2);
  close(initial.y, -5.4);
  s.position.z = -30;
  const closer = positionSignal(s, n, 1050, 60)!;
  close(closer.x, initial.x);
  close(closer.y, initial.y);
  close(closer.z!, -30);
  close(positionSignal(s, n, 1050, 90)!.x, initial.x * 1.5);
  assert.equal(positionSignal(s, n, 1300, 60), null);
  n.position.z = 0;
  assert.equal(positionSignal(s, n, 1050, 60), null);
});

test("face samples extract translation separately from the rotation matrix", () => {
  const q = new Quaternion().setFromEuler(new Euler(0.1, 0.3, 0));
  const matrix = new Matrix4().compose(
    new Vector3(-4, 2, -60),
    q,
    new Vector3(1, 1, 1),
  );
  const frame = sampleFromFace(matrix.elements, [], 960, 540, 1000, 0)!;
  assert.ok(frame.position.equals(new Vector3(-4, 2, -60)));
  close(Math.abs(frame.rotation.dot(q)), 1);
  assert.equal(frame.eyesValid, false);
});
