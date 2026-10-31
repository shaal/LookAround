import { Euler, Quaternion, Vector3 } from "three";
import { smoothSignal, type Signal } from "./tracking-math";

export type GazeRotationMode = "follow" | "continuous";

export function smoothGazeSignal(
  previous: Signal,
  signal: Signal,
  dt: number,
  smoothing: number,
  mode: GazeRotationMode,
): Signal {
  const filtered = smoothSignal(previous, signal, dt, smoothing);
  // A centered axis must stop immediately, without residual filtered velocity.
  if (mode === "continuous") {
    if (signal.x === 0) filtered.x = 0;
    if (signal.y === 0) filtered.y = 0;
  }
  return filtered;
}

/** Gaze rotates the centered model, independently of the camera transform. */
export class ObjectRotation {
  private base = new Quaternion();
  private mode: GazeRotationMode = "follow";

  constructor(readonly rotation: Quaternion) {
    this.base.copy(rotation);
  }

  private offset(signal: Signal) {
    return new Quaternion().setFromEuler(
      new Euler(signal.y * 0.48, signal.x * 0.78, 0, "YXZ"),
    );
  }

  setMode(mode: GazeRotationMode, signal: Signal | null = null) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.rebase(signal);
  }

  update(signal: Signal | null, dt = 1 / 60) {
    if (!signal || ![signal.x, signal.y].every(Number.isFinite)) return;
    if (this.mode === "follow") {
      this.rotation.copy(this.base).multiply(this.offset(signal));
      return;
    }
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Gaze deflection controls angular velocity. Integrate a quaternion so a
    // held gaze can turn through any number of revolutions at any frame rate.
    const velocity = new Vector3(signal.y * 0.65, signal.x * 1.1, 0);
    const speed = velocity.length();
    if (speed === 0) return;
    this.rotation
      .premultiply(
        new Quaternion().setFromAxisAngle(
          velocity.divideScalar(speed),
          speed * Math.min(dt, 0.05),
        ),
      )
      .normalize();
  }

  rebase(signal: Signal | null = null) {
    this.base.copy(this.rotation);
    if (signal && this.mode === "follow")
      this.base.multiply(this.offset(signal).invert());
  }

  reset() {
    this.rotation.identity();
    this.base.identity();
  }
}
