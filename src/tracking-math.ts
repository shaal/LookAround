import { Matrix4, Quaternion, Vector3 } from "three";

export interface Point {
  x: number;
  y: number;
  z?: number;
}
export interface Sample {
  rotation: Quaternion;
  position: Vector3;
  eyeX: number;
  eyeY: number;
  eyesValid: boolean;
  timestamp: number;
}
export interface Neutral {
  rotation: Quaternion;
  position: Vector3;
  eyeX: number;
  eyeY: number;
}
export interface Signal {
  x: number;
  y: number;
  z?: number;
}
export type Source = "head" | "eyes" | "combined";

export const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
export const ZERO: Signal = { x: 0, y: 0 };

export function rotationFromMatrix(data: ArrayLike<number>): Quaternion | null {
  if (data.length !== 16 || Array.from(data).some((n) => !Number.isFinite(n)))
    return null;
  const matrix = new Matrix4().fromArray(Array.from(data));
  const scale = new Vector3().setFromMatrixScale(matrix);
  if (Math.min(scale.x, scale.y, scale.z) < 1e-6) return null;
  return new Quaternion()
    .setFromRotationMatrix(new Matrix4().extractRotation(matrix))
    .normalize();
}

// Convert to pixels before constructing the eye basis: normalized video x/y
// have different units on a rectangular image. Axes always point image-right.
export function measureEye(
  points: readonly Point[],
  corners: [number, number],
  iris: number,
  lids: [number, number],
  width: number,
  height: number,
) {
  const a = points[corners[0]],
    b = points[corners[1]],
    p = points[iris];
  const upper = points[lids[0]],
    lower = points[lids[1]];
  if (!a || !b || !p || !upper || !lower || width <= 0 || height <= 0)
    return null;
  const [left, right] = a.x < b.x ? [a, b] : [b, a];
  const dx = (right.x - left.x) * width,
    dy = (right.y - left.y) * height;
  const span = Math.hypot(dx, dy);
  if (span < 5) return null;
  const ux = dx / span,
    uy = dy / span;
  const px = (p.x - (left.x + right.x) / 2) * width;
  const py = (p.y - (left.y + right.y) / 2) * height;
  return {
    x: (px * ux + py * uy) / span,
    y: (-px * uy + py * ux) / span,
    open:
      Math.hypot((lower.x - upper.x) * width, (lower.y - upper.y) * height) /
        span >
      0.13,
  };
}

export function sampleFromFace(
  matrix: ArrayLike<number>,
  points: readonly Point[],
  width: number,
  height: number,
  timestamp: number,
  blink: number,
): Sample | null {
  const rotation = rotationFromMatrix(matrix);
  if (!rotation) return null;
  const a = measureEye(points, [33, 133], 468, [159, 145], width, height);
  const b = measureEye(points, [362, 263], 473, [386, 374], width, height);
  const valid = !!a?.open && !!b?.open && blink < 0.45;
  return {
    rotation,
    position: new Vector3(matrix[12], matrix[13], matrix[14]),
    eyeX: a && b ? (a.x + b.x) / 2 : 0,
    eyeY: a && b ? (a.y + b.y) / 2 : 0,
    eyesValid: valid,
    timestamp,
  };
}

export function neutralFromSamples(samples: readonly Sample[]): Neutral {
  if (!samples.length) throw new Error("No calibration samples");
  const reference = samples[0].rotation;
  const q = new Quaternion(0, 0, 0, 0);
  for (const s of samples) {
    const sign = reference.dot(s.rotation) < 0 ? -1 : 1;
    q.x += s.rotation.x * sign;
    q.y += s.rotation.y * sign;
    q.z += s.rotation.z * sign;
    q.w += s.rotation.w * sign;
  }
  const median = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const eyes = samples.filter((s) => s.eyesValid);
  return {
    rotation: q.normalize(),
    position: new Vector3(
      median(samples.map((s) => s.position.x)),
      median(samples.map((s) => s.position.y)),
      median(samples.map((s) => s.position.z)),
    ),
    eyeX: eyes.length ? median(eyes.map((s) => s.eyeX)) : 0,
    eyeY: eyes.length ? median(eyes.map((s) => s.eyeY)) : 0,
  };
}

export function relativeAngles(
  rotation: Quaternion,
  neutral: Quaternion,
): Signal {
  const relative = neutral.clone().invert().multiply(rotation);
  const forward = new Vector3(0, 0, 1).applyQuaternion(relative);
  return {
    x: -Math.atan2(forward.x, forward.z), // Subject-right on unmirrored input.
    y: -Math.atan2(forward.y, Math.hypot(forward.x, forward.z)), // Down-positive.
  };
}

export function deadzone(value: number, size: number): number {
  return Math.sign(value) * clamp((Math.abs(value) - size) / (1 - size), 0, 1);
}

export function isFresh(sample: Sample | null, now: number): sample is Sample {
  return (
    !!sample &&
    Number.isFinite(sample.timestamp) &&
    now >= sample.timestamp &&
    now - sample.timestamp <= 250
  );
}

// Calibrate the monocular pose scale from the user's neutral viewing distance.
// XYZ offsets are in cm, with y down and z away from the screen. Steering gain,
// inversion and normalized deadzones must not alter physical translation.
export function positionSignal(
  sample: Sample | null,
  neutral: Neutral | null,
  now: number,
  eyeDistanceCm: number,
): Signal | null {
  if (!isFresh(sample, now) || !neutral) return null;
  const depth = Math.abs(neutral.position.z);
  if (
    depth < 1e-3 ||
    !Number.isFinite(eyeDistanceCm) ||
    eyeDistanceCm <= 0 ||
    ![...sample.position, ...neutral.position].every(Number.isFinite)
  )
    return null;
  const scale = eyeDistanceCm / depth;
  return {
    x: -(sample.position.x - neutral.position.x) * scale,
    y: -(sample.position.y - neutral.position.y) * scale,
    z: -(sample.position.z - neutral.position.z) * scale,
  };
}

export function controlSignal(
  sample: Sample | null,
  neutral: Neutral | null,
  source: Source,
  now: number,
  sensitivity: number,
  zone: number,
  invert: boolean,
): Signal | null {
  // An invalid frame bypasses smoothing entirely, including eyes-only blinks.
  if (!isFresh(sample, now) || !neutral) return null;
  if (source === "eyes" && !sample.eyesValid) return null;
  const head = relativeAngles(sample.rotation, neutral.rotation);
  const h = { x: head.x / 0.32, y: head.y / 0.24 };
  const eyesReliable =
    sample.eyesValid && Math.abs(head.x) < 0.55 && Math.abs(head.y) < 0.4;
  const e = eyesReliable
    ? {
        x: -(sample.eyeX - neutral.eyeX) / 0.12,
        y: (sample.eyeY - neutral.eyeY) / 0.085,
      }
    : ZERO;
  if (source === "eyes" && !eyesReliable) return null;
  const raw =
    source === "head"
      ? h
      : source === "eyes"
        ? e
        : {
            x: h.x + clamp(e.x, -1, 1) * 0.2,
            y: h.y + clamp(e.y, -1, 1) * 0.2,
          };
  return {
    x: deadzone(raw.x * sensitivity, zone) * (invert ? -1 : 1),
    y: deadzone(raw.y * sensitivity, zone),
  };
}

export function smoothSignal(
  previous: Signal,
  next: Signal,
  dt: number,
  smoothing: number,
): Signal {
  const alpha = 1 - Math.exp(-Math.max(0, dt) / (0.025 + smoothing * 0.2));
  return {
    x: previous.x + (next.x - previous.x) * alpha,
    y: previous.y + (next.y - previous.y) * alpha,
    ...(previous.z !== undefined || next.z !== undefined
      ? { z: (previous.z ?? 0) + ((next.z ?? 0) - (previous.z ?? 0)) * alpha }
      : {}),
  };
}
