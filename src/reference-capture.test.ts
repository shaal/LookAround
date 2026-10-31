import { test } from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import { ReferenceCapture } from "./reference-capture.ts";
import type { Sample } from "./tracking-math.ts";

const sample = (timestamp: number): Sample => ({
  rotation: new Quaternion(),
  position: new Vector3(0, 0, -60),
  eyeX: 0.02,
  eyeY: -0.01,
  eyesValid: true,
  timestamp,
});

test("stable samples never automatically accept; explicit click captures head and eyes together", () => {
  const capture = new ReferenceCapture();
  capture.begin();
  for (let time = 1000; time <= 1500; time += 50)
    capture.observe(sample(time), time);
  assert.equal(capture.pending, true);
  assert.equal(capture.readiness(1500), "ready");
  const neutral = capture.accept(1500)!;
  assert.ok(neutral.position.equals(new Vector3(0, 0, -60)));
  assert.equal(neutral.eyeX, 0.02);
  assert.equal(neutral.eyeY, -0.01);
  assert.equal(capture.pending, false);
  assert.equal(capture.accept(1500), null);
});
test("stale face, missing face, blink and a new session cannot accept an old reference", () => {
  const capture = new ReferenceCapture();
  capture.begin();
  for (const time of [1000, 1050, 1100]) capture.observe(sample(time), time);
  assert.equal(capture.accept(1400), null);
  capture.observe(null, 1400);
  assert.equal(capture.readiness(1400), "missing");
  const blink = sample(1450);
  blink.eyesValid = false;
  capture.observe(blink, 1450);
  assert.equal(capture.accept(1450), null);
  capture.begin();
  assert.equal(capture.accept(1500), null);
  capture.cancel();
  capture.observe(sample(1600), 1600);
  assert.equal(capture.accept(1600), null);
});
test("moving the head during the short reference window keeps the dot unready", () => {
  const capture = new ReferenceCapture();
  capture.begin();
  capture.observe(sample(1000), 1000);
  capture.observe(sample(1050), 1050);
  const moved = sample(1100);
  moved.position.x = 5;
  capture.observe(moved, 1100);
  assert.equal(capture.readiness(1100), "moving");
  assert.equal(capture.accept(1100), null);
});

test("a long frame gap requires a new short window before clicking", () => {
  const capture = new ReferenceCapture();
  capture.begin();
  for (const time of [1000, 1050, 1100]) capture.observe(sample(time), time);
  assert.equal(capture.readiness(1100), "ready");
  capture.observe(sample(1400), 1400);
  assert.equal(capture.readiness(1400), "settling");
  assert.equal(capture.accept(1400), null);
});
