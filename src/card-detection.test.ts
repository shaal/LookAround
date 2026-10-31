import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { CardPoint } from "./card-calibration.ts";

const require = createRequire(import.meta.url);
const cv = require("@techstark/opencv-js");
if (!cv.Mat)
  await new Promise<void>((resolve) => {
    cv.onRuntimeInitialized = resolve;
  });
const scope: { detectCardCorners?: Function } = {};
runInNewContext(
  readFileSync(new URL("../public/card-detection.js", import.meta.url), "utf8"),
  { self: scope },
);
function detect(x = 90, clip = false) {
  const image = new cv.Mat(
    360,
    640,
    cv.CV_8UC4,
    new cv.Scalar(20, 25, 30, 255),
  );
  cv.rectangle(
    image,
    new cv.Point(clip ? 0 : x, 90),
    new cv.Point(x + 160, 191),
    new cv.Scalar(220, 225, 230, 255),
    -1,
  );
  const face = Array.from({ length: 455 }, () => ({ x: 0.53, y: 0.5 }));
  face[234].x = 0.44;
  face[454].x = 0.62;
  try {
    return scope.detectCardCorners!(cv, image.data, 640, 360, face) as
      | CardPoint[]
      | null;
  } finally {
    image.delete();
  }
}

test("the actual local OpenCV detector finds and refines a card beside the face", () => {
  const corners = detect();
  assert.ok(corners);
  const expected = [
    { x: 90, y: 90 },
    { x: 250, y: 90 },
    { x: 250, y: 191 },
    { x: 90, y: 191 },
  ];
  corners.forEach((p, i) =>
    assert.ok(Math.hypot(p.x - expected[i].x, p.y - expected[i].y) < 2),
  );
});

test("clipped cards and rectangles over the face are rejected", () => {
  assert.equal(detect(90, true), null);
  assert.equal(detect(260), null);
});

test("a tilted card is detected without requiring its visible aspect ratio to be frontal", () => {
  const image = new cv.Mat(
    360,
    640,
    cv.CV_8UC4,
    new cv.Scalar(20, 25, 30, 255),
  );
  const expected = [
    { x: 110, y: 85 },
    { x: 245, y: 100 },
    { x: 245, y: 190 },
    { x: 110, y: 210 },
  ];
  const polygon = cv.matFromArray(
    4,
    1,
    cv.CV_32SC2,
    expected.flatMap((p) => [p.x, p.y]),
  );
  const face = Array.from({ length: 455 }, () => ({ x: 0.53, y: 0.5 }));
  face[234].x = 0.44;
  face[454].x = 0.62;
  try {
    cv.fillConvexPoly(image, polygon, new cv.Scalar(220, 225, 230, 255));
    const corners = scope.detectCardCorners!(cv, image.data, 640, 360, face) as
      | CardPoint[]
      | null;
    assert.ok(corners);
    corners.forEach((p, i) =>
      assert.ok(Math.hypot(p.x - expected[i].x, p.y - expected[i].y) < 2),
    );
  } finally {
    polygon.delete();
    image.delete();
  }
});
