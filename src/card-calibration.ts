import type { Sample } from "./tracking-math";

export interface CardPoint {
  x: number;
  y: number;
}
export type CardIssue =
  | "not-found"
  | "beside-face"
  | "small"
  | "clipped"
  | "landscape"
  | "edges"
  | "ambiguous"
  | null;
export const CARD_MAX_FRAME_AGE_MS = 1000;
const CARD_MAX_FRAME_GAP_MS = 750;
const CARD_HOLD_GRACE_MS = 450;
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
  paused = false;
  private first: CardObservation | null = null;
  private anchor: CardPoint[] | null = null;
  private recent: CardObservation[] = [];
  private filtered: CardDetection | null = null;
  private heldMs = 0;
  private pausedAt: number | null = null;
  private lastObservationAt: number | null = null;
  private frames: CardObservation[] = [];
  private lastTimestamp = -1;
  private firstSign = 0;
  private lens: { focal: number; spread: number } | null = null;
  private dimensions = "";

  private clearHold(instruction: string) {
    this.first = null;
    this.anchor = null;
    this.recent = [];
    this.filtered = null;
    this.heldMs = 0;
    this.paused = false;
    this.pausedAt = null;
    this.frames = [];
    this.progress = 0;
    this.instruction = instruction;
  }

  get trackedView(): CardDetection | null {
    return this.filtered;
  }

  private pauseHold(instruction: string, now: number) {
    if (!this.first) {
      this.clearHold(instruction);
      return;
    }
    this.pausedAt ??= now;
    if (now - this.pausedAt > CARD_HOLD_GRACE_MS) {
      this.clearHold(instruction);
      return;
    }
    this.paused = true;
    this.instruction = "Keep holding—checking the outline…";
  }

  observe(view: CardObservation | null, now: number) {
    if (this.result || this.error) return;
    if (
      !Number.isFinite(now) ||
      (view &&
        (!Number.isFinite(view.timestamp) ||
          now - view.timestamp > CARD_MAX_FRAME_AGE_MS ||
          now < view.timestamp))
    ) {
      this.clearHold("Waiting for a clear card view.");
      return;
    }
    if (view && view.timestamp <= this.lastTimestamp) return;
    const elapsed =
      this.lastObservationAt === null
        ? 0
        : Math.max(0, now - this.lastObservationAt);
    this.lastObservationAt = now;
    if (!view) {
      this.pauseHold("Waiting for a clear card view.", now);
      return;
    }
    if (
      this.lastTimestamp >= 0 &&
      view.timestamp - this.lastTimestamp > CARD_MAX_FRAME_GAP_MS
    )
      this.clearHold("Hold still.");
    this.lastTimestamp = view.timestamp;
    if (this.pausedAt !== null && now - this.pausedAt > CARD_HOLD_GRACE_MS)
      this.clearHold("Hold this position still.");
    const dimensions = `${view.width}x${view.height}`;
    if (this.dimensions && dimensions !== this.dimensions) {
      this.error = "Camera size changed. Start the scan again.";
      return;
    }
    this.dimensions = dimensions;
    const shortEdge = Math.min(
      ...view.corners.map((p, i) => {
        const next = view.corners[(i + 1) % view.corners.length];
        return Math.hypot(p.x - next.x, p.y - next.y);
      }),
    );
    if (
      shortEdge <
      Math.max(1, view.width / 640) *
        (this.stage < 3 ? 45 : 18) *
        (this.first ? 0.92 : 1)
    ) {
      this.pauseHold(
        "Card found. Bring it closer to the camera for these tilts.",
        now,
      );
      return;
    }
    const tolerance = Math.max((view.width / 640) * 5, shortEdge * 0.035);
    const displacement = (corners: CardPoint[]) =>
      this.anchor
        ? Math.max(
            ...corners.map((p, i) =>
              Math.hypot(p.x - this.anchor![i].x, p.y - this.anchor![i].y),
            ),
          )
        : 0;
    if (displacement(view.corners) > tolerance * 2) {
      this.clearHold("The card moved. Hold this position still.");
      this.recent.push(view);
      return;
    }
    this.recent.push(view);
    this.recent = this.recent.slice(-5);
    this.filtered = {
      ...view,
      corners: view.corners.map((_, i) => ({
        x: median(this.recent.map((f) => f.corners[i].x)),
        y: median(this.recent.map((f) => f.corners[i].y)),
      })),
    };
    if (this.recent.length < 3) {
      this.instruction = "Keep the card steady while its outline settles…";
      return;
    }
    if (displacement(this.filtered.corners) > tolerance) {
      this.clearHold("The card moved. Hold this position still.");
      this.recent.push(view);
      return;
    }
    if (
      this.first &&
      Math.max(
        ...view.corners.map((p, i) =>
          Math.hypot(
            p.x - this.filtered!.corners[i].x,
            p.y - this.filtered!.corners[i].y,
          ),
        ),
      ) > tolerance
    ) {
      this.pauseHold("Keep the card steady.", now);
      return;
    }
    const h = cardHomography(this.filtered);
    const focal = this.lens?.focal ?? (h ? fit([h]) : null);
    if (!h || !focal) {
      this.pauseHold("Turn one card edge farther toward the camera.", now);
      return;
    }
    const pose = cardPose(h, focal);
    const lowTilt = this.first ? 0.26 : 0.3;
    const highTilt = this.first ? 0.76 : 0.72;
    const sideways =
      Math.abs(pose.tiltX) >= lowTilt && Math.abs(pose.tiltX) <= highTilt;
    const vertical =
      Math.abs(pose.tiltY) >= lowTilt && Math.abs(pose.tiltY) <= highTilt;
    const acceptable =
      pose.residual < 0.06 &&
      (this.stage === 0
        ? sideways
        : this.stage === 1
          ? sideways && Math.sign(pose.tiltX) !== this.firstSign
          : this.stage === 2
            ? vertical && Math.abs(pose.tiltX) < (this.first ? 0.35 : 0.3)
            : Math.abs(pose.tiltX) < (this.first ? 0.24 : 0.2) &&
              Math.abs(pose.tiltY) < (this.first ? 0.24 : 0.2));
    const prompt =
      this.stage === 0
        ? "Turn one edge toward the camera."
        : this.stage === 1
          ? "Turn the opposite edge toward the camera."
          : this.stage === 2
            ? "Tip the top or bottom edge toward the camera."
            : "Face the camera. Hold the card flat beside your eyes, at the same depth.";
    if (!acceptable || pose.depth < 15 || pose.depth > 200) {
      this.pauseHold(prompt, now);
      return;
    }
    if (
      !Number.isFinite(view.sample.position.z) ||
      Math.abs(view.sample.position.z) < 1
    ) {
      this.pauseHold("Keep your face visible and look toward the camera.", now);
      return;
    }
    // Classification uses a temporal median, but measurement always retains
    // each original quad with its face pose from the SAME captured frame.
    const rawH = cardHomography(view);
    const rawPose = rawH ? cardPose(rawH, focal) : null;
    if (
      !rawPose ||
      !Number.isFinite(rawPose.residual) ||
      rawPose.residual >= 0.06 ||
      rawPose.depth < 15 ||
      rawPose.depth > 200
    ) {
      this.pauseHold("Keep the card steady.", now);
      return;
    }
    if (this.first) this.heldMs += Math.min(elapsed, CARD_MAX_FRAME_GAP_MS);
    this.paused = false;
    this.pausedAt = null;
    this.anchor ??= this.filtered.corners.map((p) => ({ ...p }));
    this.first ??= view;
    this.frames.push(view);
    this.progress = Math.min(1, this.heldMs / 800, this.frames.length / 6);
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
          ? "Captured. Turn the opposite edge toward the camera."
          : this.stage === 2
            ? "Captured. Tip the top or bottom edge toward the camera."
            : "Captured. Hold the card flat beside your eyes, at eye depth.",
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
