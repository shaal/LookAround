import { Matrix4, Quaternion, Vector3 } from "three";
import type { ScreenFrame } from "./screen-window";

export interface SpatialGeometry {
  frame: ScreenFrame;
  object: Vector3[];
  image: Vector3[] | null;
  center: Vector3;
  eyeToObjectCm: number;
  depthScale: number | null;
  /** Environments only: sampled scene points seen through the screen. */
  scene?: EnvironmentView;
}

/** Intersect an eye-to-object ray with the physical display plane (Z = 0). */
export function screenIntersection(
  eye: Vector3,
  point: Vector3,
): Vector3 | null {
  const depth = eye.z - point.z;
  if (eye.z <= 0 || depth <= 0.01) return null;
  const t = eye.z / depth;
  return new Vector3(
    eye.x + (point.x - eye.x) * t,
    eye.y + (point.y - eye.y) * t,
    0,
  );
}

export function spatialGeometry(
  frame: ScreenFrame,
  worldCorners: Vector3[],
): SpatialGeometry {
  const inverse = frame.orientation.clone().invert();
  const object = worldCorners.map((point) =>
    point
      .clone()
      .sub(frame.origin)
      .applyQuaternion(inverse)
      .divideScalar(frame.unitsPerCm)
      .add(new Vector3(0, 0, frame.neutralDistanceCm)),
  );
  const center = object
    .reduce((sum, point) => sum.add(point), new Vector3())
    .divideScalar(object.length);
  const image = object.map((point) => {
    if (frame.perspective === "window")
      return screenIntersection(frame.eye, point);
    const depth = frame.eye.z - point.z;
    if (depth <= 0.01) return null;
    // Rendered camera coordinates mapped onto the monitor, not physical rays
    // intersecting it. The lens stays fixed as the head moves.
    return new Vector3(
      ((point.x - frame.eye.x) * frame.neutralDistanceCm) / depth,
      ((point.y - frame.eye.y) * frame.neutralDistanceCm) / depth,
      0,
    );
  });
  const currentDepth = frame.eye.z - center.z;
  const neutralDepth = frame.neutralDistanceCm - center.z;
  return {
    frame,
    object,
    image: image.every((point) => point !== null) ? image : null,
    center,
    eyeToObjectCm: frame.eye.distanceTo(center),
    // Size of the object's center plane relative to the neutral eye distance.
    // This isolates depth movement from changes due to gaze-driven rotation.
    depthScale:
      currentDepth > 0.01 && neutralDepth > 0.01
        ? ((frame.perspective === "window"
            ? frame.eye.z / frame.neutralDistanceCm
            : 1) *
            neutralDepth) /
          currentDepth
        : null,
  };
}

/** Consistent vertex order for both the physical proxy and its screen image. */
export const BOX_FACES = [
  [0, 2, 3, 1],
  [4, 5, 7, 6],
  [0, 1, 5, 4],
  [2, 6, 7, 3],
  [0, 4, 6, 2],
  [1, 3, 7, 5],
];

export function boxCorners(min: Vector3, max: Vector3): Vector3[] {
  return Array.from(
    { length: 8 },
    (_, i) =>
      new Vector3(
        i & 4 ? max.x : min.x,
        i & 2 ? max.y : min.y,
        i & 1 ? max.z : min.z,
      ),
  );
}

export interface ScenePoint {
  /** Where the eye-to-point ray crosses the screen, in cm from its centre. */
  screenX: number;
  screenY: number;
  /** Distance behind the screen plane, in cm. */
  depthCm: number;
  color: string;
}

export interface EnvironmentView {
  points: ScenePoint[];
  /** Samples deeper than this are left out. */
  depthCm: number;
  nearestCm: number | null;
}

export interface SceneSample {
  /** xyz triples in the splat mesh's local space. */
  positions: Float32Array;
  /** rgb triples, 0–255. */
  colors: Uint8Array;
  count: number;
}

/** Frame (cm) ← world: the inverse of how ScreenWindow places the camera. */
export function worldToFrame(frame: ScreenFrame): Matrix4 {
  return new Matrix4()
    .makeTranslation(0, 0, frame.neutralDistanceCm)
    .multiply(
      new Matrix4().makeScale(
        1 / frame.unitsPerCm,
        1 / frame.unitsPerCm,
        1 / frame.unitsPerCm,
      ),
    )
    .multiply(
      new Matrix4().makeRotationFromQuaternion(
        new Quaternion().copy(frame.orientation).invert(),
      ),
    )
    .multiply(
      new Matrix4().makeTranslation(
        -frame.origin.x,
        -frame.origin.y,
        -frame.origin.z,
      ),
    );
}

/**
 * Keeps the sampled splats that sit inside the viewing wedge behind the screen,
 * so the overview shows the slice of the environment you are looking into.
 */
export function environmentView(
  frame: ScreenFrame,
  meshToWorld: Matrix4,
  sample: SceneSample,
  depthCm = 4000,
  limit = 1600,
): EnvironmentView {
  const m = worldToFrame(frame).multiply(meshToWorld).elements;
  const eye =
    frame.perspective === "window"
      ? frame.eye
      : new Vector3(0, 0, frame.neutralDistanceCm);
  const halfW = frame.widthCm / 2,
    halfH = frame.heightCm / 2;
  const points: ScenePoint[] = [];
  let nearest = Infinity;
  const { positions, colors } = sample;
  for (let i = 0; i < sample.count; i++) {
    const x0 = positions[i * 3],
      y0 = positions[i * 3 + 1],
      z0 = positions[i * 3 + 2];
    const z = m[2] * x0 + m[6] * y0 + m[10] * z0 + m[14];
    if (z > 0 || z < -depthCm) continue;
    const x = m[0] * x0 + m[4] * y0 + m[8] * z0 + m[12];
    const y = m[1] * x0 + m[5] * y0 + m[9] * z0 + m[13];
    // Where the eye-to-point ray crosses the screen plane.
    const t = eye.z / (eye.z - z);
    const sx = eye.x + (x - eye.x) * t,
      sy = eye.y + (y - eye.y) * t;
    if (Math.abs(sx) > halfW || Math.abs(sy) > halfH) continue;
    const distance = Math.hypot(x - eye.x, y - eye.y, z - eye.z);
    if (distance < nearest) nearest = distance;
    if (points.length < limit)
      points.push({
        screenX: sx,
        screenY: sy,
        depthCm: -z,
        color: `rgb(${colors[i * 3]},${colors[i * 3 + 1]},${colors[i * 3 + 2]})`,
      });
  }
  return {
    points,
    depthCm,
    nearestCm: Number.isFinite(nearest) ? nearest : null,
  };
}

/**
 * Log depth for the overview: real scenes run tens of metres behind a 40 cm
 * screen. Returns a display depth (cm) from 0 at the screen to `displayCm`.
 */
export function compressDepth(depthCm: number, maxCm: number, displayCm: number) {
  const k = 50;
  return (displayCm * Math.log1p(Math.max(0, depthCm) / k)) / Math.log1p(maxCm / k);
}
