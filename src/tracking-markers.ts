import { Quaternion, Vector3 } from "three";
import {
  isFresh,
  positionSignal,
  relativeAngles,
  type Neutral,
  type Sample,
} from "./tracking-math";
import { viewportWidthCm, type ScreenCalibration } from "./screen-window";

export interface MarkerViewport {
  width: number;
  height: number;
  widthCm: number;
  screenDistanceCm: number;
  trackingDistanceCm: number;
}
export interface MarkerPoint {
  x: number;
  y: number;
  offscreen: boolean;
}
export interface TrackingMarkerGeometry {
  head: MarkerPoint;
  gaze: MarkerPoint | null;
  orientation: Quaternion;
  scale: number;
}
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
const basis = new Quaternion(0, 1, 0, 0);

/** Neutral-relative head aim and a heuristic eye direction, independent of steering settings. */
export function trackingMarkerGeometry(
  sample: Sample | null,
  neutral: Neutral | null,
  now: number,
  viewport: MarkerViewport,
): TrackingMarkerGeometry | null {
  if (
    !isFresh(sample, now) ||
    !neutral ||
    !Object.values(viewport).every((v) => Number.isFinite(v) && v > 0)
  )
    return null;
  if (
    ![...sample.rotation, ...neutral.rotation].every(Number.isFinite) ||
    sample.rotation.lengthSq() < 1e-8 ||
    neutral.rotation.lengthSq() < 1e-8
  )
    return null;
  const movement = positionSignal(
    sample,
    neutral,
    now,
    viewport.trackingDistanceCm,
  );
  if (!movement) return null;
  const distance = viewport.screenDistanceCm + (movement.z ?? 0);
  if (distance < 5 || distance > 300) return null;
  const relative = neutral.rotation
    .clone()
    .normalize()
    .invert()
    .multiply(sample.rotation.clone().normalize());
  // Face coordinates -> screen coordinates: right +X, up +Y, forward -Z.
  const orientation = basis
    .clone()
    .multiply(relative)
    .multiply(basis.clone().invert())
    .normalize();
  const eye = new Vector3(movement.x, -movement.y, distance);
  const scale = clamp(viewport.screenDistanceCm / distance, 0.45, 2.2);
  const intersect = (
    direction: Vector3,
    padding: number,
  ): MarkerPoint | null => {
    if (direction.z >= -0.05) return null;
    const point = eye.clone().addScaledVector(direction, -eye.z / direction.z);
    const pixelsPerCm = viewport.width / viewport.widthCm;
    const x = viewport.width / 2 + point.x * pixelsPerCm;
    const y = viewport.height / 2 - point.y * pixelsPerCm;
    const px = Math.min(padding, viewport.width / 3),
      py = Math.min(padding, viewport.height / 3);
    return {
      x: clamp(x, px, viewport.width - px),
      y: clamp(y, py, viewport.height - py),
      offscreen:
        x < px || x > viewport.width - px || y < py || y > viewport.height - py,
    };
  };
  const head = intersect(
    new Vector3(0, 0, -1).applyQuaternion(orientation),
    24 * scale,
  );
  if (!head) return null;
  let gaze: MarkerPoint | null = null;
  const angles = relativeAngles(relative, new Quaternion());
  if (
    sample.eyesValid &&
    Math.abs(angles.x) < 0.55 &&
    Math.abs(angles.y) < 0.4 &&
    [sample.eyeX, sample.eyeY, neutral.eyeX, neutral.eyeY].every(
      Number.isFinite,
    )
  ) {
    // These visual gains estimate look direction from iris displacement; they
    // are not a calibrated screen-gaze model. Head aim contributes as well.
    const eyeYaw = clamp(
      (-(sample.eyeX - neutral.eyeX) / 0.12) * 0.35,
      -0.6,
      0.6,
    );
    const eyePitch = clamp(
      ((sample.eyeY - neutral.eyeY) / 0.085) * 0.25,
      -0.45,
      0.45,
    );
    gaze = intersect(
      new Vector3(Math.tan(eyeYaw), -Math.tan(eyePitch), -1)
        .normalize()
        .applyQuaternion(orientation),
      16,
    );
  }
  return { head, gaze, orientation, scale };
}

/** An oblique three-axis cross makes yaw, pitch and roll legible in 2D. */
export function headCrossPaths(orientation: Quaternion, scale: number) {
  const size = 14 * scale;
  const segment = (axis: Vector3) => {
    const p = axis.applyQuaternion(orientation);
    const x = (p.x + p.z * 0.5) * size;
    const y = (-p.y - p.z * 0.5) * size;
    return `M${(-x).toFixed(2)},${(-y).toFixed(2)}L${x.toFixed(2)},${y.toFixed(2)}`;
  };
  return {
    planar: segment(new Vector3(1, 0, 0)) + segment(new Vector3(0, 1, 0)),
    depth: segment(new Vector3(0, 0, 0.9)),
  };
}

export class TrackingMarkers {
  private enabled = false;
  private head: MarkerPoint | null = null;
  private gaze: MarkerPoint | null = null;
  private orientation = new Quaternion();
  private scale = 1;
  private reference: Neutral | null = null;
  private width = 0;
  private height = 0;
  private headGroup: SVGGElement;
  private gazeGroup: SVGGElement;
  private planar: SVGPathElement;
  private depth: SVGPathElement;
  private shadow: SVGPathElement;
  private center: SVGCircleElement;

  constructor(private svg: SVGSVGElement) {
    this.headGroup = svg.querySelector("[data-head-marker]")!;
    this.gazeGroup = svg.querySelector("[data-gaze-marker]")!;
    this.planar = svg.querySelector("[data-head-planar]")!;
    this.depth = svg.querySelector("[data-head-depth]")!;
    this.shadow = svg.querySelector("[data-head-shadow]")!;
    this.center = svg.querySelector("[data-head-center]")!;
    this.hide();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.hide();
  }
  private hide() {
    this.svg.toggleAttribute("hidden", true);
    this.head = this.gaze = null;
    this.reference = null;
  }

  update(
    sample: Sample | null,
    neutral: Neutral | null,
    now: number,
    dt: number,
    calibration: ScreenCalibration,
    trackingDistanceCm: number,
  ) {
    if (!this.enabled) return;
    const width = window.innerWidth,
      height = window.innerHeight;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      this.head = this.gaze = null;
    }
    const geometry = trackingMarkerGeometry(sample, neutral, now, {
      width,
      height,
      widthCm: viewportWidthCm(calibration, {
        width,
        height,
        screenWidth: window.screen.width || width,
        pixelRatio: devicePixelRatio,
      }),
      screenDistanceCm: calibration.eyeDistanceCm,
      trackingDistanceCm,
    });
    if (!geometry) {
      this.hide();
      return;
    }
    const alpha = 1 - Math.exp(-Math.max(0, dt) / 0.065);
    const first = !this.head || this.reference !== neutral;
    const blend = (previous: MarkerPoint | null, next: MarkerPoint) =>
      first || !previous
        ? { ...next }
        : {
            x: previous.x + (next.x - previous.x) * alpha,
            y: previous.y + (next.y - previous.y) * alpha,
            offscreen: next.offscreen,
          };
    this.head = blend(this.head, geometry.head);
    this.gaze = geometry.gaze ? blend(this.gaze, geometry.gaze) : null;
    if (first) {
      this.orientation.copy(geometry.orientation);
      this.scale = geometry.scale;
    } else {
      this.orientation.slerp(geometry.orientation, alpha);
      this.scale += (geometry.scale - this.scale) * alpha;
    }
    this.reference = neutral;
    this.svg.toggleAttribute("hidden", false);
    this.headGroup.setAttribute(
      "transform",
      `translate(${this.head.x.toFixed(2)} ${this.head.y.toFixed(2)})`,
    );
    this.headGroup.dataset.offscreen = String(this.head.offscreen);
    const paths = headCrossPaths(this.orientation, this.scale);
    this.planar.setAttribute("d", paths.planar);
    this.depth.setAttribute("d", paths.depth);
    this.shadow.setAttribute("d", paths.planar + paths.depth);
    this.center.setAttribute("r", String(Math.max(1.5, 2 * this.scale)));
    this.gazeGroup.toggleAttribute("hidden", !this.gaze);
    if (this.gaze) {
      this.gazeGroup.setAttribute(
        "transform",
        `translate(${this.gaze.x.toFixed(2)} ${this.gaze.y.toFixed(2)})`,
      );
      this.gazeGroup.dataset.offscreen = String(this.gaze.offscreen);
    }
  }
}
