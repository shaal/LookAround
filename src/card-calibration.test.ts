import { test } from "node:test";
import assert from "node:assert/strict";
import { Euler, Quaternion, Vector3 } from "three";
import {
  CardCalibration,
  cardHomography,
  cardPose,
  fitCardLens,
  type CardDetection,
} from "./card-calibration.ts";
import { positionSignal, type Sample } from "./tracking-math.ts";

function card(
  yaw: number,
  pitch = 0,
  depth = 30,
  focal = 900,
  offsetX = 0,
  offsetY = 0,
): CardDetection {
  const rotation = new Quaternion().setFromEuler(new Euler(pitch, yaw, 0));
  return {
    width: 1280,
    height: 720,
    corners: [
      [-4.28, -2.699],
      [4.28, -2.699],
      [4.28, 2.699],
      [-4.28, 2.699],
    ].map(([x, y]) => {
      const p = new Vector3(x, y, 0)
        .applyQuaternion(rotation)
        .add(new Vector3(-12 + offsetX, -2 + offsetY, depth));
      return { x: 640 + (focal * p.x) / p.z, y: 360 + (focal * p.y) / p.z };
    }),
  };
}
function face(timestamp: number): Sample {
  return {
    timestamp,
    rotation: new Quaternion(),
    position: new Vector3(0, 0, -65),
    eyeX: 0,
    eyeY: 0,
    eyesValid: true,
  };
}
const views = () => [card(0.55), card(-0.55), card(0, 0.55)];

test("three tilted card views recover lens and camera depth in source-image units", () => {
  const lens = fitCardLens(views());
  assert.ok(lens);
  assert.ok(Math.abs(lens.focal * 1280 - 900) < 1e-6);
  const pose = cardPose(cardHomography(card(0, 0, 52))!, lens.focal);
  assert.ok(Math.abs(pose.depth - 52) < 1e-7);
  const scaled = views().map((v) => ({
    ...v,
    width: v.width / 2,
    height: v.height / 2,
    corners: v.corners.map((p) => ({ x: p.x / 2, y: p.y / 2 })),
  }));
  const smaller = fitCardLens(scaled);
  assert.ok(smaller);
  assert.ok(Math.abs(smaller.focal - lens.focal) < 1e-7);
});

test("frontal, weak and inconsistent card views cannot become successful calibration", () => {
  assert.equal(fitCardLens([card(0), card(0), card(0)]), null);
  assert.equal(fitCardLens([card(0.02), card(-0.02), card(0, 0.02)]), null);
  assert.equal(
    fitCardLens([
      card(0.55, 0, 30, 600),
      card(-0.55, 0, 30, 1500),
      card(0, 0.55, 30, 900),
    ]),
    null,
  );
  assert.equal(
    cardHomography({ ...card(0), corners: Array(4).fill({ x: 0, y: 0 }) }),
    null,
  );
});

test("small corner noise yields an approximate lens rather than an exact-looking fit", () => {
  const noisy = [card(0.55, 0, 25), card(-0.55, 0, 25), card(0, 0.55, 25)].map(
    (view, j) => ({
      ...view,
      corners: view.corners.map((p, i) => ({
        x: p.x + Math.sin(i * 4 + j) * 0.4,
        y: p.y + Math.cos(i * 3 + j) * 0.4,
      })),
    }),
  );
  const lens = fitCardLens(noisy);
  assert.ok(lens);
  assert.ok(Math.abs(lens.focal * 1280 - 900) / 900 < 0.08);
  assert.ok(lens.spread > 0);
});

test("guided holds use opposite and vertical tilts then paired frontal face depth", () => {
  const session = new CardCalibration();
  let timestamp = 1000;
  for (const view of [...views(), card(0, 0, 52)]) {
    for (let i = 0; i < 16; i++) {
      session.observe(
        { ...view, timestamp, sample: face(timestamp) },
        timestamp + 20,
      );
      timestamp += 100;
    }
  }
  assert.ok(session.result, session.error || session.instruction);
  assert.ok(Math.abs(session.result.distanceCm - 52) < 1e-6);
  assert.ok(Math.abs(session.result.cmPerPoseUnit - 0.8) < 1e-6);
  // Recentring after putting the card away retains the measured pose scale.
  const neutral = { ...face(timestamp), position: new Vector3(0, 0, -60) };
  const moved = { ...face(timestamp), position: new Vector3(-10, 0, -50) };
  const signal = positionSignal(
    moved,
    neutral,
    timestamp,
    Math.abs(neutral.position.z) * session.result.cmPerPoseUnit,
  )!;
  assert.ok(Math.abs(signal.x - 8) < 1e-6);
  assert.ok(Math.abs(signal.z! + 8) < 1e-6);
});

test("duplicates, stale frames and long capture gaps cannot complete a hold", () => {
  const session = new CardCalibration(),
    view = card(0.55);
  const observe = (timestamp: number, now = timestamp) =>
    session.observe({ ...view, timestamp, sample: face(timestamp) }, now);
  observe(1000);
  for (let i = 0; i < 20; i++) observe(1000);
  assert.equal(session.progress, 0);
  observe(1100);
  observe(1200);
  observe(1300);
  observe(1400);
  assert.ok(session.progress > 0);
  observe(2300);
  assert.equal(session.progress, 0);
  observe(2400, 3501);
  assert.equal(session.progress, 0);
  observe(3600);
  observe(3700);
  session.observe(null, 3800);
  assert.equal(session.progress, 0);
  session.observe(
    {
      ...view,
      corners: view.corners.map((p) => ({ x: p.x + 25, y: p.y })),
      timestamp: 3900,
      sample: face(3900),
    },
    3900,
  );
  assert.equal(session.views.length, 0);
  session.observe(
    {
      ...view,
      timestamp: 4000,
      sample: { ...face(4000), position: new Vector3(0, 0, NaN) },
    },
    4000,
  );
  assert.equal(session.progress, 0);
});

test("slow paired camera frames complete a hold while live movement still rejects stale samples", () => {
  const session = new CardCalibration(),
    view = card(0.55);
  for (let i = 0; i < 8; i++) {
    const timestamp = 1000 + i * 500;
    session.observe(
      { ...view, timestamp, sample: face(timestamp) },
      timestamp + 400,
    );
  }
  assert.equal(session.stage, 1);
  assert.equal(positionSignal(face(1000), face(1000), 1400, 52), null);
});

function startHold() {
  const session = new CardCalibration();
  for (let i = 0; i < 5; i++) {
    const timestamp = 1000 + i * 100;
    session.observe(
      { ...card(0.55), timestamp, sample: face(timestamp) },
      timestamp,
    );
  }
  assert.ok(session.progress > 0);
  return session;
}

test("a short outline dropout freezes progress and resumes without counting the missing frame", () => {
  const session = startHold(),
    before = session.progress;
  session.observe(null, 1500);
  assert.equal(session.progress, before);
  assert.equal(session.paused, true);
  assert.ok(session.trackedView);
  session.observe({ ...card(0.55), timestamp: 1600, sample: face(1600) }, 1600);
  assert.equal(session.paused, false);
  assert.ok(Math.abs(session.progress - before - 0.125) < 1e-8);
});

test("sustained detection loss clears the hold instead of completing it in the background", () => {
  const session = startHold(),
    before = session.progress;
  session.observe(null, 1500);
  session.observe(null, 1900);
  assert.equal(session.progress, before);
  session.observe(null, 2000);
  assert.equal(session.progress, 0);
  assert.equal(session.paused, false);
  assert.equal(session.trackedView, null);
  assert.equal(session.stage, 0);
});

test("an unstable corner pauses without counting or replacing the held measurement", () => {
  const session = startHold(),
    before = session.progress;
  const unstable = card(0.55);
  unstable.corners[1].y += 12;
  session.observe({ ...unstable, timestamp: 1500, sample: face(1500) }, 1500);
  assert.equal(session.paused, true);
  assert.equal(session.progress, before);
  session.observe({ ...card(0.55), timestamp: 1600, sample: face(1600) }, 1600);
  assert.equal(session.paused, false);
  assert.ok(session.progress > before);
  assert.equal(session.stage, 0);
});

test("large real movement resets the hold immediately", () => {
  const session = startHold();
  session.observe(
    { ...card(0.55, 0, 30, 900, 2), timestamp: 1500, sample: face(1500) },
    1500,
  );
  assert.equal(session.progress, 0);
  assert.equal(session.paused, false);
  assert.match(session.instruction, /card moved/);
});

test("a locked tilt tolerates small changes around its entry threshold", () => {
  const session = new CardCalibration();
  for (let i = 0; i < 16 && session.stage === 0; i++) {
    const timestamp = 1000 + i * 100;
    session.observe(
      { ...card(i < 5 ? 0.31 : 0.28), timestamp, sample: face(timestamp) },
      timestamp,
    );
  }
  assert.equal(session.stage, 1);
});

test("natural hand jitter and blinking retain accurate paired card measurements", () => {
  const session = new CardCalibration();
  let timestamp = 1000;
  for (const [yaw, pitch, depth] of [
    [0.55, 0, 30],
    [-0.55, 0, 30],
    [0, 0.55, 30],
    [0, 0, 52],
  ]) {
    for (let i = 0; i < 24; i++) {
      const view = card(
        yaw,
        pitch,
        depth,
        900,
        Math.sin(i * 1.7) * 0.22,
        Math.cos(i * 1.3) * 0.12,
      );
      session.observe(
        {
          ...view,
          timestamp,
          sample: { ...face(timestamp), eyesValid: i % 4 !== 0 },
        },
        timestamp,
      );
      timestamp += 100;
    }
  }
  assert.ok(session.result, session.error || session.instruction);
  assert.ok(Math.abs(session.result.distanceCm - 52) < 0.1);
  assert.ok(Math.abs(session.result.cmPerPoseUnit - 0.8) < 0.005);
});

test("a visible small card requests a closer capture instead of accepting an unreliable lens", () => {
  const session = new CardCalibration();
  for (let i = 0; i < 10; i++) {
    const timestamp = 1000 + i * 100;
    session.observe(
      { ...card(0.55, 0, 80), timestamp, sample: face(timestamp) },
      timestamp,
    );
  }
  assert.equal(session.stage, 0);
  assert.match(session.instruction, /Bring it closer/);
});
