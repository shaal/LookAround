import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function worker(deferred = false, detectionFails = false) {
  const messages: any[] = [];
  const runtime: any = deferred ? {} : { Mat: class {} };
  const self: any = {
    cv: runtime,
    postMessage: (message: any) => messages.push(message),
  };
  let closed = 0;
  const bitmap = { width: 960, height: 540, close: () => closed++ };
  const points = [{ x: 0.5, y: 0.5 }];
  runInNewContext(
    readFileSync(
      new URL("../public/vision-worker.js", import.meta.url),
      "utf8",
    ) + "\nlandmarker = fakeLandmarker;",
    {
      self,
      performance: { now: () => 1000 },
      importScripts: () => {
        self.detectCardCorners = () => {
          if (detectionFails) throw new Error("Bad card frame");
          return [
            { x: 10, y: 20 },
            { x: 110, y: 20 },
            { x: 110, y: 80 },
            { x: 10, y: 80 },
          ];
        };
      },
      OffscreenCanvas: class {
        getContext() {
          return {
            drawImage() {},
            getImageData() {
              return { data: new Uint8Array(4) };
            },
          };
        }
      },
      fakeLandmarker: {
        detectForVideo: () => ({
          faceLandmarks: [points],
          faceBlendshapes: [],
          facialTransformationMatrixes: [{ data: [1, 2, 3] }],
        }),
      },
    },
  );
  return {
    self,
    messages,
    runtime,
    bitmap,
    get closed() {
      return closed;
    },
  };
}

test("card and face results share one captured bitmap and timestamp; stopping scan keeps face tracking", async () => {
  const w = worker();
  await w.self.onmessage({ data: { type: "card-start" } });
  await w.self.onmessage({
    data: { type: "frame", timestamp: 321, bitmap: w.bitmap },
  });
  const result = w.messages.find((m) => m.type === "result");
  assert.equal(result.timestamp, 321);
  assert.equal(result.width, 960);
  assert.equal(result.points.length, 1);
  assert.equal(result.card.corners[0].x, 15);
  assert.equal(result.card.corners[0].y, 30);
  assert.equal(w.closed, 1);
  await w.self.onmessage({ data: { type: "card-stop" } });
  await w.self.onmessage({
    data: { type: "frame", timestamp: 421, bitmap: w.bitmap },
  });
  assert.equal(w.messages.at(-1).card, null);
  assert.equal(w.closed, 2);
});

test("cancelling while OpenCV initializes cannot reactivate a cancelled card scan", async () => {
  const w = worker(true);
  const pending = w.self.onmessage({ data: { type: "card-start" } });
  await w.self.onmessage({ data: { type: "card-stop" } });
  w.runtime.Mat = class {};
  w.runtime.onRuntimeInitialized();
  await pending;
  assert.ok(!w.messages.some((m) => m.type === "card-ready"));
  await w.self.onmessage({
    data: { type: "frame", timestamp: 321, bitmap: w.bitmap },
  });
  assert.equal(w.messages.at(-1).card, null);
});

test("card detector errors preserve the face result and close the captured frame", async () => {
  const w = worker(false, true);
  await w.self.onmessage({ data: { type: "card-start" } });
  await w.self.onmessage({
    data: { type: "frame", timestamp: 321, bitmap: w.bitmap },
  });
  assert.ok(w.messages.some((m) => m.type === "card-error"));
  assert.ok(!w.messages.some((m) => m.type === "error"));
  assert.equal(w.messages.at(-1).type, "result");
  assert.equal(w.messages.at(-1).card, null);
  assert.equal(w.closed, 1);
});
