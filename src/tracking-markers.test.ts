import { test } from "node:test";
import assert from "node:assert/strict";
import { Euler, Quaternion, Vector3 } from "three";
import { neutralFromSamples, type Sample } from "./tracking-math.ts";
import { DEFAULT_SCREEN_CALIBRATION } from "./screen-window.ts";
import {
  headCrossPaths,
  trackingMarkerGeometry,
  TrackingMarkers,
} from "./tracking-markers.ts";

const close = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
const sample = (): Sample => ({
  rotation: new Quaternion(),
  position: new Vector3(0, 0, -60),
  eyeX: 0,
  eyeY: 0,
  eyesValid: true,
  timestamp: 1000,
});
const viewport = {
  width: 1280,
  height: 800,
  widthCm: 70.8,
  screenDistanceCm: 46,
  trackingDistanceCm: 46,
};
const neutral = () => neutralFromSamples([sample()]);
const geometry = (s: Sample) =>
  trackingMarkerGeometry(s, neutral(), 1050, viewport)!;

test("markers share the reference dot's center even with a rotated neutral", () => {
  const s = sample();
  s.rotation.setFromEuler(new Euler(0.12, 0.2, 0.1));
  s.eyeX = 0.04;
  s.eyeY = -0.01;
  const result = trackingMarkerGeometry(
    s,
    neutralFromSamples([s]),
    1050,
    viewport,
  )!;
  close(result.head.x, 640);
  close(result.head.y, 400);
  close(result.gaze!.x, 640);
  close(result.gaze!.y, 400);
  close(result.scale, 1);
  close(Math.abs(result.orientation.w), 1);
});

test("head translation moves the aim; distance changes the cross size", () => {
  const s = sample();
  s.position.x = -7.2;
  s.position.y = -6;
  const moved = geometry(s);
  close(moved.head.x, 640 + (((7.2 * 46) / 60) * 1280) / 70.8);
  close(moved.head.y, 400 + (((6 * 46) / 60) * 1280) / 70.8);
  s.position.set(0, 0, -45);
  close(geometry(s).scale, 4 / 3);
  close(geometry(s).head.x, 640);
  s.position.z = -90;
  close(geometry(s).scale, 2 / 3);
});

test("head yaw and pitch steer the cross; roll changes its axes", () => {
  const s = sample();
  s.rotation.setFromEuler(new Euler(0, -0.2, 0));
  close(geometry(s).head.x, 640 + (Math.tan(0.2) * 46 * 1280) / 70.8);
  s.rotation.setFromEuler(new Euler(0.15, 0, 0));
  close(geometry(s).head.y, 400 + (Math.tan(0.15) * 46 * 1280) / 70.8);
  s.rotation.setFromEuler(new Euler(0, 0, 0.35));
  const rolled = geometry(s);
  close(rolled.head.x, 640);
  close(rolled.head.y, 400);
  assert.notEqual(
    headCrossPaths(rolled.orientation, 1).planar,
    headCrossPaths(new Quaternion(), 1).planar,
  );
  assert.notEqual(
    headCrossPaths(new Quaternion(), 1).depth,
    "M0.00,0.00L0.00,0.00",
  );
});

test("gaze combines iris direction and head aim, independently of scene steering", () => {
  const s = sample();
  s.eyeX = -0.06;
  s.eyeY = 0.03;
  const eyes = geometry(s);
  assert.ok(eyes.gaze!.x > eyes.head.x);
  assert.ok(eyes.gaze!.y > eyes.head.y);
  close(eyes.head.x, 640);
  s.rotation.setFromEuler(new Euler(0, -0.2, 0));
  s.eyeX = (0.2 / 0.35) * 0.12;
  s.eyeY = 0;
  const compensated = geometry(s);
  assert.ok(compensated.head.x > 640);
  close(compensated.gaze!.x, 640);
});

test("blinks, invalid iris data and extreme head angles hide only the gaze", () => {
  const s = sample();
  s.eyesValid = false;
  assert.equal(geometry(s).gaze, null);
  assert.ok(geometry(s).head);
  s.eyesValid = true;
  s.eyeX = NaN;
  assert.equal(geometry(s).gaze, null);
  s.eyeX = 0;
  s.rotation.setFromEuler(new Euler(0, -0.6, 0));
  assert.equal(geometry(s).gaze, null);
  assert.ok(geometry(s).head);
});

test("missing, stale, future or invalid pose data never leaves a marker", () => {
  const n = neutral();
  assert.equal(trackingMarkerGeometry(null, n, 1050, viewport), null);
  assert.equal(trackingMarkerGeometry(sample(), null, 1050, viewport), null);
  assert.equal(trackingMarkerGeometry(sample(), n, 1300, viewport), null);
  assert.equal(trackingMarkerGeometry(sample(), n, 999, viewport), null);
  const s = sample();
  s.rotation.x = NaN;
  assert.equal(trackingMarkerGeometry(s, n, 1050, viewport), null);
  s.rotation.set(0, 0, 0, 0);
  assert.equal(trackingMarkerGeometry(s, n, 1050, viewport), null);
  s.rotation.identity();
  s.position.z = NaN;
  assert.equal(trackingMarkerGeometry(s, n, 1050, viewport), null);
});

test("offscreen aims stay at the edge, and unsafe depths or rearward rays hide", () => {
  const s = sample();
  s.position.x = -200;
  const result = geometry(s);
  assert.equal(result.head.offscreen, true);
  close(result.head.x, viewport.width - 24);
  const narrow = trackingMarkerGeometry(s, neutral(), 1050, {
    ...viewport,
    width: 120,
    height: 80,
    widthCm: 10,
  })!;
  assert.ok(narrow.head.x < 120 && narrow.head.x > 0);
  s.position.set(0, 0, -1);
  assert.equal(geometry(s), null);
  s.position.z = -500;
  assert.equal(geometry(s), null);
  s.position.z = -60;
  s.rotation.setFromEuler(new Euler(0, Math.PI, 0));
  assert.equal(geometry(s), null);
});

test("camera pose scale and screen distance remain separate after card calibration", () => {
  const s = sample();
  s.position.set(-6, 0, -54);
  const result = trackingMarkerGeometry(s, neutral(), 1050, {
    ...viewport,
    trackingDistanceCm: 60,
  })!;
  close(result.head.x, 640 + (6 * 1280) / 70.8);
  close(result.scale, 46 / 40);
});

test("renderer hides stale input and blinks, and reappears cleanly after toggling", (t) => {
  class Element {
    attrs = new Map<string, string>();
    dataset: Record<string, string> = {};
    setAttribute(name: string, value: string) {
      this.attrs.set(name, value);
    }
    toggleAttribute(name: string, present: boolean) {
      if (present) this.attrs.set(name, "");
      else this.attrs.delete(name);
    }
  }
  const elements = new Map<string, Element>();
  const svg = new Element();
  Object.assign(svg, {
    querySelector: (key: string) => {
      if (!elements.has(key)) elements.set(key, new Element());
      return elements.get(key)!;
    },
  });
  for (const [key, value] of Object.entries({
    window: { innerWidth: 1280, innerHeight: 800, screen: { width: 1280 } },
    devicePixelRatio: 1,
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const markers = new TrackingMarkers(svg as unknown as SVGSVGElement);
  const s = sample(),
    n = neutral();
  const update = (now: number) =>
    markers.update(s, n, now, 1 / 60, DEFAULT_SCREEN_CALIBRATION, 46);
  update(1050);
  assert.equal(svg.attrs.has("hidden"), true);
  markers.setEnabled(true);
  update(1050);
  assert.equal(svg.attrs.has("hidden"), false);
  assert.equal(elements.get("[data-gaze-marker]")!.attrs.has("hidden"), false);
  s.eyesValid = false;
  update(1060);
  assert.equal(svg.attrs.has("hidden"), false);
  assert.equal(elements.get("[data-gaze-marker]")!.attrs.has("hidden"), true);
  update(1300);
  assert.equal(svg.attrs.has("hidden"), true);
  s.timestamp = 1400;
  s.position.x = -6;
  s.eyesValid = true;
  update(1450);
  const head = elements.get("[data-head-marker]")!;
  const fresh = trackingMarkerGeometry(s, n, 1450, viewport)!;
  assert.equal(
    head.attrs.get("transform"),
    `translate(${fresh.head.x.toFixed(2)} ${fresh.head.y.toFixed(2)})`,
  );
  markers.setEnabled(false);
  assert.equal(svg.attrs.has("hidden"), true);
  s.position.x = -12;
  update(1460);
  assert.equal(svg.attrs.has("hidden"), true);
  markers.setEnabled(true);
  update(1460);
  assert.equal(svg.attrs.has("hidden"), false);
  assert.equal(elements.get("[data-gaze-marker]")!.attrs.has("hidden"), false);
  assert.notEqual(
    head.attrs.get("transform"),
    `translate(${fresh.head.x.toFixed(2)} ${fresh.head.y.toFixed(2)})`,
  );
});
