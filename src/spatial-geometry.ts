import { Vector3 } from "three";
import type { ScreenFrame } from "./screen-window";

export interface SpatialGeometry {
  frame: ScreenFrame;
  object: Vector3[];
  image: Vector3[] | null;
  center: Vector3;
  eyeToObjectCm: number;
  depthScale: number | null;
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
