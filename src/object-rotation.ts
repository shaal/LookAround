import { Euler, Quaternion } from "three";
import type { Signal } from "./tracking-math";

/** Gaze rotates the centered model, independently of the camera transform. */
export class ObjectRotation {
  private base = new Quaternion();

  constructor(readonly rotation: Quaternion) {
    this.base.copy(rotation);
  }

  private offset(signal: Signal) {
    return new Quaternion().setFromEuler(
      new Euler(signal.y * 0.48, signal.x * 0.78, 0, "YXZ"),
    );
  }

  update(signal: Signal | null) {
    if (signal) this.rotation.copy(this.base).multiply(this.offset(signal));
  }

  rebase(signal: Signal | null = null) {
    this.base.copy(this.rotation);
    if (signal) this.base.multiply(this.offset(signal).invert());
  }

  reset() {
    this.rotation.identity();
    this.base.identity();
  }
}
