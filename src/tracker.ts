import { sampleFromFace, type Point, type Sample } from "./tracking-math";
import type { CardDetection } from "./card-calibration";

export class FaceTracker {
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private generation = 0;
  private frameId = 0;
  private lastFrame = 0;
  private lastVideoTime = -1;
  private busy = false;
  private ready = false;
  private cardScan = false;
  private cancelInitialization: (() => void) | null = null;
  onSample: (
    sample: Sample | null,
    points: Point[],
    inferenceMs: number,
    card: CardDetection | null,
  ) => void = () => {};
  onCardStatus: (ready: boolean, error?: string) => void = () => {};
  onStatus: (status: string, failed?: boolean) => void = () => {};

  constructor(readonly video: HTMLVideoElement) {}

  get active() {
    return this.stream !== null && this.ready;
  }
  startCardScan() {
    this.cardScan = true;
    this.worker?.postMessage({ type: "card-start" });
  }
  stopCardScan() {
    this.cardScan = false;
    this.worker?.postMessage({ type: "card-stop" });
  }

  async start() {
    this.stop();
    const generation = this.generation;
    try {
      if (!window.isSecureContext)
        throw new Error("Camera access needs localhost or HTTPS.");
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("This browser does not support camera access.");
      this.onStatus("Allow camera access to begin");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 960 },
          height: { ideal: 540 },
          facingMode: "user",
          frameRate: { ideal: 24, max: 30 },
        },
        audio: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation) return;
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        if (generation !== this.generation) return;
        this.stop();
        this.onStatus("Camera disconnected. Enable camera to retry.", true);
      });
      this.onStatus("Loading local face model…");
      const worker = new Worker("/vision-worker.js");
      this.worker = worker;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                "Tracking model timed out. Run npm run setup and retry.",
              ),
            ),
          30000,
        );
        this.cancelInitialization = () => {
          clearTimeout(timer);
          resolve();
        };
        const fail = (message: string) => {
          clearTimeout(timer);
          reject(new Error(message));
          if (this.ready) {
            this.stop();
            this.onStatus(`Tracking error: ${message}`, true);
          }
        };
        worker.onerror = (event) =>
          fail(event.message || "Tracking worker failed.");
        worker.onmessage = ({ data }) => {
          if (generation !== this.generation) return;
          if (data.type === "ready") {
            clearTimeout(timer);
            this.cancelInitialization = null;
            this.ready = true;
            resolve();
          }
          if (data.type === "error") {
            fail(data.message);
          }
          if (data.type === "card-ready" && this.cardScan)
            this.onCardStatus(true);
          if (data.type === "card-error" && this.cardScan)
            this.onCardStatus(false, data.message);
          if (data.type === "result") {
            this.busy = false;
            const sample = data.points.length
              ? sampleFromFace(
                  data.matrix,
                  data.points,
                  data.width,
                  data.height,
                  data.timestamp,
                  data.blink,
                )
              : null;
            this.onSample(
              sample,
              data.points,
              data.inferenceMs,
              data.card ?? null,
            );
          }
        };
        worker.postMessage({ type: "init" });
      });
      if (generation !== this.generation) return;
      this.onStatus("Find your face. Look straight ahead.");
      this.schedule(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      const message = error instanceof Error ? error.message : String(error);
      this.onStatus(
        message.includes("Permission") || message.includes("denied")
          ? "Camera permission denied. Allow it in your browser and retry."
          : message.includes("device")
            ? "No webcam found. Try simulated tracking below."
            : message,
        true,
      );
    }
  }

  private schedule(generation: number) {
    this.frameId = requestAnimationFrame(async (now) => {
      if (generation !== this.generation) return;
      this.schedule(generation);
      if (
        !this.ready ||
        this.busy ||
        document.hidden ||
        now - this.lastFrame < (this.cardScan ? 100 : 45) ||
        this.video.readyState < 2 ||
        this.video.currentTime === this.lastVideoTime
      )
        return;
      this.busy = true;
      this.lastFrame = now;
      this.lastVideoTime = this.video.currentTime;
      try {
        const bitmap = await createImageBitmap(this.video);
        if (generation !== this.generation) {
          bitmap.close();
          return;
        }
        this.worker?.postMessage({ type: "frame", bitmap, timestamp: now }, [
          bitmap,
        ]);
      } catch (error) {
        if (generation !== this.generation) return;
        this.stop();
        this.onStatus(
          `Could not read camera frames: ${error instanceof Error ? error.message : error}`,
          true,
        );
      }
    });
  }

  stop() {
    this.generation++;
    this.cancelInitialization?.();
    this.cancelInitialization = null;
    cancelAnimationFrame(this.frameId);
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.busy = false;
    this.ready = false;
    this.cardScan = false;
    this.lastFrame = 0;
    this.lastVideoTime = -1;
    this.onSample(null, [], 0, null);
  }
}
