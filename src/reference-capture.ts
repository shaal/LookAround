import {
  isFresh,
  neutralFromSamples,
  type Neutral,
  type Sample,
} from "./tracking-math";

/** One continuous second of fresh, still head and eye samples sets neutral. */
export class ReferenceCapture {
  pending = false;
  private samples: Sample[] = [];

  begin() {
    this.pending = true;
    this.samples = [];
  }
  cancel() {
    this.pending = false;
    this.samples = [];
  }

  observe(sample: Sample | null, now: number) {
    if (!this.pending) return;
    if (!isFresh(sample, now) || !sample.eyesValid) {
      this.samples = [];
      return;
    }
    const last = this.samples.at(-1);
    if (last && sample.timestamp - last.timestamp > 250) this.samples = [];
    if (last && last.timestamp >= sample.timestamp) return;
    const anchor = this.samples[0];
    const depth = Math.abs(sample.position.z);
    if (depth < 1e-3) {
      this.samples = [];
      return;
    }
    if (
      anchor &&
      (sample.rotation.angleTo(anchor.rotation) > 0.055 ||
        sample.position.distanceTo(anchor.position) / depth > 0.015 ||
        Math.abs(sample.eyeX - anchor.eyeX) > 0.035 ||
        Math.abs(sample.eyeY - anchor.eyeY) > 0.025)
    )
      this.samples = [];
    this.samples.push(sample);
  }

  readiness(now: number): "missing" | "moving" | "holding" | "ready" {
    const latest = this.samples.at(-1);
    if (!this.pending || !isFresh(latest ?? null, now)) return "missing";
    if (this.samples.length < 2) return "moving";
    return latest!.timestamp - this.samples[0].timestamp >= 1000
      ? "ready"
      : "holding";
  }

  progress(now: number): number {
    const state = this.readiness(now);
    if (state === "missing" || state === "moving") return 0;
    return Math.min(
      1,
      (this.samples.at(-1)!.timestamp - this.samples[0].timestamp) / 1000,
    );
  }

  accept(now: number): Neutral | null {
    if (this.readiness(now) !== "ready") return null;
    const neutral = neutralFromSamples(this.samples);
    this.cancel();
    return neutral;
  }
}
