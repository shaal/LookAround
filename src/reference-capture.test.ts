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

test("one continuous second fills the ring and captures head and eyes, never earlier", () => {
  const capture = new ReferenceCapture();
  capture.begin();
  for (let time = 1000; time < 2000; time += 50) {
    capture.observe(sample(time), time);
    assert.equal(capture.accept(time), null);
  }
  assert.equal(capture.progress(1950), 0.95);
  capture.observe(sample(2000), 2000);
  assert.equal(capture.readiness(2000), "ready");
  assert.equal(capture.progress(2000), 1);
  const neutral = capture.accept(2000)!;
  assert.ok(neutral.position.equals(new Vector3(0, 0, -60)));
  assert.equal(neutral.eyeX, 0.02);
  assert.equal(neutral.eyeY, -0.01);
  assert.equal(capture.pending, false);
  assert.equal(capture.accept(2000), null);
});

test("head movement resets the ring and requires a whole new second", () => {
  const capture = new ReferenceCapture();
  capture.begin();
  for (let time = 1000; time <= 1500; time += 50)
    capture.observe(sample(time), time);
  const moved = sample(1550);
  moved.position.x = 5;
  capture.observe(moved, 1550);
  assert.equal(capture.readiness(1550), "moving");
  assert.equal(capture.progress(1550), 0);
  for (let time = 1600; time < 2550; time += 50) {
    const next = sample(time);
    next.position.x = 5;
    capture.observe(next, time);
    assert.equal(capture.accept(time), null);
  }
  const final = sample(2550);
  final.position.x = 5;
  capture.observe(final, 2550);
  assert.equal(capture.accept(2550)!.position.x, 5);
});

test("missing face, blink, stale data and frame gaps cannot count toward the hold", () => {
  const capture = new ReferenceCapture();
  capture.begin();
  for (let time = 1000; time <= 1500; time += 50)
    capture.observe(sample(time), time);
  assert.equal(capture.progress(1800), 0);
  assert.equal(capture.accept(1800), null);
  capture.observe(sample(1800), 1800);
  assert.equal(capture.progress(1800), 0);
  capture.observe(null, 1850);
  assert.equal(capture.readiness(1850), "missing");
  const blink = sample(1900);
  blink.eyesValid = false;
  capture.observe(blink, 1900);
  assert.equal(capture.progress(1900), 0);
  capture.observe(sample(1900), 2200);
  assert.equal(capture.readiness(2200), "missing");
  capture.begin();
  assert.equal(capture.accept(2300), null);
  capture.cancel();
  capture.observe(sample(2400), 2400);
  assert.equal(capture.accept(2400), null);
});

test("eye movement and slow head drift reset stability against a fixed reference", () => {
  const capture = new ReferenceCapture();
  capture.begin();
  for (let time = 1000; time <= 1500; time += 50)
    capture.observe(sample(time), time);
  const eyes = sample(1550);
  eyes.eyeX = 0.15;
  capture.observe(eyes, 1550);
  assert.equal(capture.progress(1550), 0);
  capture.begin();
  for (let time = 2000; time <= 4000; time += 50) {
    const drift = sample(time);
    drift.position.x = (time - 2000) * 0.003;
    capture.observe(drift, time);
    assert.equal(capture.accept(time), null);
  }
});
