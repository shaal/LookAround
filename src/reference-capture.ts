import {
  isFresh,
  neutralFromSamples,
  type Neutral,
  type Sample,
} from "./tracking-math";

/** Observing frames never sets neutral. Only a deliberate accept() may do so. */
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
    this.samples = this.samples.filter((s) => s.timestamp >= now - 550);
    const last = this.samples.at(-1);
    if (last && sample.timestamp - last.timestamp > 250) this.samples = [];
    if (!last || last.timestamp < sample.timestamp) this.samples.push(sample);
  }

  readiness(now: number): "missing" | "settling" | "moving" | "ready" {
    const latest = this.samples.at(-1);
    if (!this.pending || !isFresh(latest ?? null, now)) return "missing";
    if (
      this.samples.length < 3 ||
      latest!.timestamp - this.samples[0].timestamp < 100
    )
      return "settling";
    const depth = Math.abs(latest!.position.z);
    if (
      depth < 1e-3 ||
      this.samples.some(
        (s) =>
          s.rotation.angleTo(latest!.rotation) > 0.075 ||
          s.position.distanceTo(latest!.position) / depth > 0.025,
      )
    )
      return "moving";
    return "ready";
  }

  accept(now: number): Neutral | null {
    if (this.readiness(now) !== "ready") return null;
    const neutral = neutralFromSamples(this.samples);
    this.cancel();
    return neutral;
  }
}
