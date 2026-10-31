import type { Sample } from "./tracking-math";

export interface CardPoint {
  x: number;
  y: number;
}
export interface CardDetection {
  corners: CardPoint[];
  width: number;
  height: number;
}
export interface CardMeasurement {
  distanceCm: number;
  cmPerPoseUnit: number;
  focalPixels: number;
  focalSpread: number;
}
export interface CardObservation extends CardDetection {
  timestamp: number;
  sample: Sample;
}
const CARD_WIDTH = 8.56,
  CARD_HEIGHT = 5.398;
const median = (a: number[]) =>
  [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const norm = (a: number[]) => Math.hypot(...a);
const dot = (a: number[], b: number[]) =>
  a.reduce((s, x, i) => s + x * b[i], 0);

function solve(rows: number[][], values: number[]): number[] | null {
  const a = rows.map((r, i) => [...r, values[i]]);
  for (let i = 0; i < values.length; i++) {
    let pivot = i;
    for (let j = i + 1; j < a.length; j++)
      if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    if (Math.abs(a[pivot][i]) < 1e-10) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const divisor = a[i][i];
    a[i] = a[i].map((v) => v / divisor);
    for (let j = 0; j < a.length; j++)
      if (j !== i) {
        const factor = a[j][i];
        a[j] = a[j].map((v, k) => v - factor * a[i][k]);
      }
  }
  return a.map((r) => r[values.length]);
}

// Source-image pixels only; CSS mirroring never enters this calculation.
export function cardHomography(view: CardDetection): number[] | null {
  if (
    view.corners.length !== 4 ||
    ![view.width, view.height].every(Number.isFinite) ||
    view.width <= 0 ||
    view.height <= 0 ||
    !view.corners.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  )
    return null;
  const physical = [
    [-CARD_WIDTH / 2, -CARD_HEIGHT / 2],
    [CARD_WIDTH / 2, -CARD_HEIGHT / 2],
    [CARD_WIDTH / 2, CARD_HEIGHT / 2],
    [-CARD_WIDTH / 2, CARD_HEIGHT / 2],
  ];
  const rows: number[][] = [],
    values: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = physical[i];
    const u = (view.corners[i].x - view.width / 2) / view.width;
    const v = (view.corners[i].y - view.height / 2) / view.width;
    rows.push(
      [x, y, 1, 0, 0, 0, -u * x, -u * y],
      [0, 0, 0, x, y, 1, -v * x, -v * y],
    );
    values.push(u, v);
  }
  const h = solve(rows, values);
  return h ? [...h, 1] : null;
}

function constraints(h: number[]) {
  const scale = h[0] ** 2 + h[1] ** 2 + h[3] ** 2 + h[4] ** 2;
  return [
    [(h[0] * h[1] + h[3] * h[4]) / scale, (h[6] * h[7]) / scale],
    [
      (h[0] ** 2 + h[3] ** 2 - h[1] ** 2 - h[4] ** 2) / scale,
      (h[6] ** 2 - h[7] ** 2) / scale,
    ],
  ];
}

function fit(homographies: number[][]): number | null {
  const equations = homographies.flatMap(constraints);
  const information = equations.reduce((s, [, b]) => s + b * b, 0);
  if (information < 1e-5) return null;
  const square = -equations.reduce((s, [a, b]) => s + a * b, 0) / information;
  const focal = Math.sqrt(square);
  return Number.isFinite(focal) && focal >= 0.35 && focal <= 3 ? focal : null;
}

export function cardPose(h: number[], focal: number) {
  const a = [h[0] / focal, h[3] / focal, h[6]];
  const b = [h[1] / focal, h[4] / focal, h[7]];
  const na = norm(a),
    nb = norm(b);
  const depth = 2 / (na + nb);
  return {
    depth,
    tiltX: a[2] / na,
    tiltY: b[2] / nb,
    residual: Math.max(
      Math.abs(dot(a, b) / (na * nb)),
      Math.abs(na - nb) / ((na + nb) / 2),
    ),
  };
}

/** Constrained square-pixel lens, centered principal point, no distortion. */
export function fitCardLens(
  views: CardDetection[],
): { focal: number; spread: number } | null {
  const hs = views.map(cardHomography);
  if (views.length < 3 || hs.some((h) => !h)) return null;
  const valid = hs as number[][];
  const focal = fit(valid);
  if (!focal || valid.some((h) => cardPose(h, focal).residual > 0.06))
    return null;
  const leaveOut = valid.map((_, i) => fit(valid.filter((_, j) => i !== j)));
  if (leaveOut.some((f) => !f || Math.abs(f - focal) / focal > 0.12))
    return null;
  // Perturb corners with a localization-error floor, not just observed jitter.
  // This catches apparently stable, but poorly conditioned, card views.
  let random = 1234567;
  const jitter = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return (random / 0xffffffff) * 2 - 1;
  };
  const estimates: number[] = [];
  for (let trial = 0; trial < 48; trial++) {
    const perturbed = views.map((view) =>
      cardHomography({
        ...view,
        corners: view.corners.map((p) => ({
          x: p.x + jitter() * Math.max(1, view.width / 640) * 1.5,
          y: p.y + jitter() * Math.max(1, view.width / 640) * 1.5,
        })),
      }),
    );
    if (perturbed.some((h) => !h)) continue;
    const estimate = fit(perturbed as number[][]);
    if (estimate) estimates.push(estimate);
  }
  estimates.sort((a, b) => a - b);
  if (estimates.length < 40) return null;
  const spread =
    Math.max(
      Math.abs(estimates[2] - focal),
      Math.abs(estimates[estimates.length - 3] - focal),
    ) / focal;
  return spread <= 0.18 ? { focal, spread } : null;
}

export class CardCalibration {
  readonly views: CardDetection[] = [];
  stage = 0;
  progress = 0;
  instruction =
    "Hold a standard bank-sized card beside your face, with one edge turned toward the camera.";
  error = "";
  result: CardMeasurement | null = null;
  private first: CardObservation | null = null;
  private frames: CardObservation[] = [];
  private lastTimestamp = -1;
  private firstSign = 0;
  private lens: { focal: number; spread: number } | null = null;
  private dimensions = "";

  private clearHold(instruction: string) {
    this.first = null;
    this.frames = [];
    this.progress = 0;
    this.instruction = instruction;
  }

  observe(view: CardObservation | null, now: number) {
    if (this.result || this.error) return;
    if (
      !view ||
      !Number.isFinite(now) ||
      !Number.isFinite(view.timestamp) ||
      now - view.timestamp > 250 ||
      now < view.timestamp
    ) {
      this.clearHold("Show your face and all four card edges.");
      return;
    }
    if (view.timestamp <= this.lastTimestamp) return;
    if (this.lastTimestamp >= 0 && view.timestamp - this.lastTimestamp > 250)
      this.clearHold("Hold still.");
    this.lastTimestamp = view.timestamp;
    const dimensions = `${view.width}x${view.height}`;
    if (this.dimensions && dimensions !== this.dimensions) {
      this.error = "Camera size changed. Start the scan again.";
      return;
    }
    this.dimensions = dimensions;
    const h = cardHomography(view);
    const focal = this.lens?.focal ?? (h ? fit([h]) : null);
    if (!h || !focal) {
      this.clearHold("Turn one card edge farther toward the camera.");
      return;
    }
    const pose = cardPose(h, focal);
    const sideways =
      Math.abs(pose.tiltX) >= 0.3 && Math.abs(pose.tiltX) <= 0.72;
    const vertical =
      Math.abs(pose.tiltY) >= 0.3 && Math.abs(pose.tiltY) <= 0.72;
    const acceptable =
      pose.residual < 0.06 &&
      (this.stage === 0
        ? sideways
        : this.stage === 1
          ? sideways && Math.sign(pose.tiltX) !== this.firstSign
          : this.stage === 2
            ? vertical && Math.abs(pose.tiltX) < 0.3
            : Math.abs(pose.tiltX) < 0.2 && Math.abs(pose.tiltY) < 0.2);
    const prompt =
      this.stage === 0
        ? "Turn one edge toward the camera."
        : this.stage === 1
          ? "Turn the opposite edge toward the camera."
          : this.stage === 2
            ? "Tip the top or bottom edge toward the camera."
            : "Face the camera. Hold the card flat beside your eyes, at the same depth.";
    if (!acceptable || pose.depth < 15 || pose.depth > 200) {
      this.clearHold(prompt);
      return;
    }
    if (
      !view.sample.eyesValid ||
      !Number.isFinite(view.sample.position.z) ||
      Math.abs(view.sample.position.z) < 1
    ) {
      this.clearHold("Keep your face visible and look toward the camera.");
      return;
    }
    if (
      this.first &&
      view.corners.some(
        (p, i) =>
          Math.hypot(
            p.x - this.first!.corners[i].x,
            p.y - this.first!.corners[i].y,
          ) >
          (view.width / 640) * 3,
      )
    )
      this.clearHold("Hold still.");
    this.first ??= view;
    this.frames.push(view);
    this.progress = Math.min(1, (view.timestamp - this.first.timestamp) / 800);
    this.instruction =
      this.stage === 3 ? "Hold still beside your eyes…" : "Hold this tilt…";
    if (this.progress < 1 || this.frames.length < 6) return;
    const combined: CardDetection = {
      ...view,
      corners: view.corners.map((_, i) => ({
        x: median(this.frames.map((f) => f.corners[i].x)),
        y: median(this.frames.map((f) => f.corners[i].y)),
      })),
    };
    if (this.stage < 3) {
      this.views.push(combined);
      if (this.stage === 0) this.firstSign = Math.sign(pose.tiltX);
      this.stage++;
      if (this.stage === 3) {
        this.lens = fitCardLens(this.views);
        if (!this.lens) {
          this.error =
            "The views disagree. Retry with the whole card clearly visible and stronger tilts.";
          return;
        }
      }
      this.clearHold(
        this.stage === 1
          ? "Now turn the opposite edge toward the camera."
          : this.stage === 2
            ? "Now tip the top or bottom edge toward the camera."
            : "Now hold the card flat beside your eyes, at eye depth.",
      );
      return;
    }
    const paired = this.frames.map((frame) => {
      const pose = cardPose(cardHomography(frame)!, this.lens!.focal);
      return {
        depth: pose.depth,
        ratio: pose.depth / Math.abs(frame.sample.position.z),
      };
    });
    const ratio = median(paired.map((p) => p.ratio));
    if (paired.some((p) => Math.abs(p.ratio - ratio) / ratio > 0.08)) {
      this.clearHold("Keep your head and card still together.");
      return;
    }
    this.result = {
      distanceCm: median(paired.map((p) => p.depth)),
      cmPerPoseUnit: ratio,
      focalPixels: this.lens!.focal * view.width,
      focalSpread: this.lens!.spread,
    };
    this.instruction = "Put the card away.";
    this.progress = 1;
  }
}
