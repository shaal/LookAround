import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import type { Signal } from "./tracking-math";

export interface ScreenCalibration {
  screenWidthCm: number;
  eyeDistanceCm: number;
  objectDistanceCm: number;
  pixelsPerCm?: number;
  calibrationPixelRatio?: number;
}

export interface ScreenViewport {
  width: number;
  height: number;
  screenWidth: number;
  pixelRatio?: number;
}

/** Physical screen coordinates: right +X, up +Y, toward the viewer +Z. */
export interface ScreenFrame {
  origin: Vector3;
  orientation: Quaternion;
  unitsPerCm: number;
  widthCm: number;
  heightCm: number;
  neutralDistanceCm: number;
  eye: Vector3;
}

export const DEFAULT_SCREEN_CALIBRATION: ScreenCalibration = {
  screenWidthCm: 70.8,
  eyeDistanceCm: 46,
  objectDistanceCm: 61,
};

export const BANK_CARD_WIDTH_CM = 8.56;

export function viewportWidthCm(
  calibration: ScreenCalibration,
  viewport: ScreenViewport,
): number {
  if (
    (calibration.pixelsPerCm ?? 0) > 0 &&
    (calibration.calibrationPixelRatio ?? 0) > 0
  ) {
    return (
      (viewport.width * (viewport.pixelRatio ?? 1)) /
      (calibration.pixelsPerCm! * calibration.calibrationPixelRatio!)
    );
  }
  return (calibration.screenWidthCm * viewport.width) / viewport.screenWidth;
}

/** A fixed display plane viewed from a moving eye, all tracking offsets in cm. */
export class ScreenWindow {
  private origin = new Vector3();
  private orientation = new Quaternion();
  private bias = new Vector3();
  private eye = new Vector3();
  private unitsPerCm = 1;
  private calibration = { ...DEFAULT_SCREEN_CALIBRATION };
  private viewport: ScreenViewport = { width: 1, height: 1, screenWidth: 1 };

  constructor(private camera: PerspectiveCamera) {}

  capture(
    calibration: ScreenCalibration,
    viewport: ScreenViewport,
    target: Vector3,
  ) {
    if (
      ![
        calibration.screenWidthCm,
        calibration.eyeDistanceCm,
        calibration.objectDistanceCm,
      ].every((v) => Number.isFinite(v) && v > 0)
    )
      throw new Error("Screen measurements must be positive.");
    this.calibration = { ...calibration };
    this.viewport = { ...viewport };
    this.origin.copy(this.camera.position);
    this.orientation.copy(this.camera.quaternion);
    this.unitsPerCm =
      Math.max(this.camera.position.distanceTo(target), 0.1) /
      calibration.objectDistanceCm;
    this.bias.set(0, 0, 0);
    this.eye.set(0, 0, 0);
    this.project();
  }

  resize(viewport: ScreenViewport) {
    this.viewport = { ...viewport };
    this.project();
  }

  apply(input: Signal): boolean {
    const next = new Vector3(input.x, -input.y, input.z ?? 0).add(this.bias);
    const distance = this.calibration.eyeDistanceCm + next.z;
    if (![...next].every(Number.isFinite) || distance < 5 || distance > 300)
      return false;
    this.eye.copy(next);
    this.project();
    return true;
  }

  rebase(input: Signal) {
    this.bias.copy(this.eye).sub(new Vector3(input.x, -input.y, input.z ?? 0));
  }

  // Manual navigation deliberately moves the virtual view; head input does not
  // move this frame. Preserve the applied eye offset and the projection.
  anchorManualView() {
    this.orientation.copy(this.camera.quaternion);
    this.origin
      .copy(this.camera.position)
      .sub(
        this.eye
          .clone()
          .multiplyScalar(this.unitsPerCm)
          .applyQuaternion(this.orientation),
      );
    this.project();
  }

  private project() {
    const { width, height, screenWidth } = this.viewport;
    if (![width, height, screenWidth].every((v) => Number.isFinite(v) && v > 0))
      return;
    const widthCm = viewportWidthCm(this.calibration, this.viewport);
    const heightCm = (widthCm * height) / width;
    const distance = this.calibration.eyeDistanceCm + this.eye.z;
    const near = this.camera.near;
    // Frustum edges are rays from the eye through the fixed screen rectangle.
    const left = ((-widthCm / 2 - this.eye.x) * near) / distance;
    const right = ((widthCm / 2 - this.eye.x) * near) / distance;
    const bottom = ((-heightCm / 2 - this.eye.y) * near) / distance;
    const top = ((heightCm / 2 - this.eye.y) * near) / distance;
    this.camera.position
      .copy(this.origin)
      .add(
        this.eye
          .clone()
          .multiplyScalar(this.unitsPerCm)
          .applyQuaternion(this.orientation),
      );
    this.camera.quaternion.copy(this.orientation);
    this.camera.projectionMatrix.makePerspective(
      left,
      right,
      top,
      bottom,
      near,
      this.camera.far,
    );
    this.camera.projectionMatrixInverse
      .copy(this.camera.projectionMatrix)
      .invert();
  }

  get eyeDistanceCm() {
    return this.calibration.eyeDistanceCm + this.eye.z;
  }

  get frame(): ScreenFrame {
    const widthCm = viewportWidthCm(this.calibration, this.viewport);
    return {
      origin: this.origin.clone(),
      orientation: this.orientation.clone(),
      unitsPerCm: this.unitsPerCm,
      widthCm,
      heightCm: (widthCm * this.viewport.height) / this.viewport.width,
      neutralDistanceCm: this.calibration.eyeDistanceCm,
      eye: this.eye
        .clone()
        .add(new Vector3(0, 0, this.calibration.eyeDistanceCm)),
    };
  }
}
