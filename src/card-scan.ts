import {
  CardCalibration,
  CARD_MAX_FRAME_AGE_MS,
  type CardDetection,
  type CardMeasurement,
  type CardIssue,
} from "./card-calibration";
import type { FaceTracker } from "./tracker";
import type { Point, Sample } from "./tracking-math";

export class CardScan {
  private calibration = new CardCalibration();
  private ready = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private status: HTMLElement;
  private heading: HTMLElement;
  private apply: HTMLButtonElement;
  private result: HTMLElement;
  private meter: HTMLElement;
  private steps: HTMLElement[];
  private readiness: HTMLElement;

  constructor(
    private dialog: HTMLDialogElement,
    private tracker: FaceTracker,
    private accept: (value: CardMeasurement, useForScreen: boolean) => void,
    private cancel: () => void,
  ) {
    this.video = dialog.querySelector("video")!;
    this.canvas = dialog.querySelector("canvas")!;
    this.status = dialog.querySelector("[data-scan-status]")!;
    this.heading = dialog.querySelector("h2")!;
    this.apply = dialog.querySelector("[data-scan-apply]")!;
    this.result = dialog.querySelector("[data-scan-result]")!;
    this.meter = dialog.querySelector("[role=progressbar]")!;
    this.steps = Array.from(dialog.querySelectorAll("[data-scan-step]"));
    this.readiness = dialog.querySelector("[data-scan-readiness]")!;
    dialog
      .querySelector("[data-scan-close]")!
      .addEventListener("click", () => this.close());
    dialog
      .querySelector("[data-scan-retry]")!
      .addEventListener("click", () => this.start());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.apply.addEventListener("click", () => {
      const result = this.calibration.result;
      if (!result) return;
      const useScreen =
        dialog.querySelector<HTMLInputElement>("[data-scan-screen]")!.checked;
      this.close(false);
      this.accept(result, useScreen);
    });
    tracker.onCardStatus = (ready, error) => {
      if (!this.active) return;
      this.ready = ready;
      if (error)
        this.fail(
          "Card detection could not load. Retry, or cancel to keep your current setup.",
        );
      else
        this.setStatus(
          "Show a standard bank-sized card beside your face. Turn one edge toward the camera.",
        );
    };
  }

  get active() {
    return this.dialog.open;
  }

  start() {
    if (!this.tracker.active) return;
    this.calibration = new CardCalibration();
    const generation = ++this.generation;
    this.ready = false;
    this.dialog.dataset.stage = "0";
    this.dialog.dataset.holding = "false";
    this.dialog.dataset.error = "false";
    this.dialog.dataset.complete = "false";
    this.readiness.textContent = "Face: waiting · Card: waiting";
    this.result.hidden = true;
    this.apply.hidden = true;
    this.heading.textContent = "Measure with your card.";
    this.setStatus("Loading local card detection…");
    this.canvas
      .getContext("2d")!
      .clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.steps.forEach((step, i) => {
      step.classList.remove("complete");
      step.classList.toggle("current", i === 0);
    });
    this.meter.style.setProperty("--hold", "0%");
    this.meter.setAttribute("aria-valuenow", "0");
    this.video.srcObject = this.tracker.video.srcObject;
    void this.video.play().catch(() => {
      if (generation === this.generation)
        this.fail(
          "The camera preview stopped. Cancel and enable the camera again.",
        );
    });
    if (!this.dialog.open) this.dialog.showModal();
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.fail(
          "The scan needs clearer views. Try brighter light and bring the card a little closer for the tilts.",
        ),
      120000,
    );
    this.tracker.startCardScan();
  }

  close(notify = true) {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.generation++;
    this.ready = false;
    this.tracker.stopCardScan();
    this.video.pause();
    this.video.srcObject = null;
    this.dialog.close();
    if (notify) this.cancel();
  }

  private setStatus(text: string) {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  private fail(text: string) {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.ready = false;
    this.tracker.stopCardScan();
    this.dialog.dataset.error = "true";
    this.dialog.dataset.holding = "false";
    this.meter.style.setProperty("--hold", "0%");
    this.meter.setAttribute("aria-valuenow", "0");
    this.canvas
      .getContext("2d")!
      .clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.setStatus(text);
  }

  observe(
    sample: Sample | null,
    points: Point[],
    card: CardDetection | null,
    now: number,
    cardIssue: CardIssue = null,
  ) {
    if (!this.active || !this.ready) return;
    const detectedCard = card;
    this.readiness.textContent = `Face ${sample ? "found" : "not found"} · Card ${detectedCard ? "found" : "not found"}`;
    this.dialog.dataset.faceFound = String(!!sample);
    this.dialog.dataset.cardFound = String(!!detectedCard);
    this.dialog.dataset.frameAge = sample
      ? String(Math.round(now - sample.timestamp))
      : "";
    this.dialog.dataset.cardIssue = cardIssue ?? "";
    let faceTurned = false;
    if (
      this.calibration.stage === 3 &&
      points[33] &&
      points[263] &&
      points[1]
    ) {
      const eyeCenter = (points[33].x + points[263].x) / 2;
      if (
        Math.abs(points[1].x - eyeCenter) >
        Math.abs(points[33].x - points[263].x) * 0.28
      ) {
        card = null;
        faceTurned = true;
      }
    }
    this.calibration.observe(
      sample && card ? { ...card, sample, timestamp: sample.timestamp } : null,
      now,
    );
    this.dialog.dataset.stage = String(this.calibration.stage);
    this.dialog.dataset.holding = String(this.calibration.progress > 0);
    this.steps.forEach((step, i) => {
      step.classList.toggle("complete", i < this.calibration.stage);
      step.classList.toggle("current", i === this.calibration.stage);
    });
    this.meter.style.setProperty(
      "--hold",
      `${this.calibration.progress * 100}%`,
    );
    this.meter.setAttribute(
      "aria-valuenow",
      String(Math.round(this.calibration.progress * 100)),
    );
    const width = detectedCard?.width ?? this.video.videoWidth;
    const height = detectedCard?.height ?? this.video.videoHeight;
    if (width && height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas.parentElement!.style.aspectRatio = `${width}/${height}`;
      const context = this.canvas.getContext("2d")!;
      if (detectedCard) {
        context.strokeStyle =
          this.calibration.progress > 0 ? "#8fd2ae" : "#eea6a0";
        context.lineWidth = width / 200;
        context.beginPath();
        detectedCard.corners.forEach((p, i) =>
          i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
        );
        context.closePath();
        context.stroke();
      } else if (points[1] && points[234] && points[454]) {
        const faceWidth = Math.abs(points[234].x - points[454].x) * width;
        const targetWidth = Math.min(
          width * 0.25,
          faceWidth * (this.calibration.stage < 3 ? 1.4 : 0.75),
        );
        const targetHeight = targetWidth / 1.586;
        const centerX = points[1].x * width;
        const eyeY =
          points[33] && points[263]
            ? ((points[33].y + points[263].y) / 2) * height
            : points[1].y * height;
        context.strokeStyle = "#efc38f";
        context.lineWidth = Math.max(1, width / 400);
        context.setLineDash([width / 90, width / 140]);
        for (const side of [-1, 1]) {
          const x = Math.max(
            8,
            Math.min(
              width - targetWidth - 8,
              centerX +
                side * (faceWidth * 0.8 + targetWidth / 2) -
                targetWidth / 2,
            ),
          );
          const y = Math.max(
            20,
            Math.min(height - targetHeight - 8, eyeY - targetHeight / 2),
          );
          context.strokeRect(x, y, targetWidth, targetHeight);
        }
      }
    }
    if (this.calibration.error) {
      this.fail(this.calibration.error);
      return;
    }
    const hints: Record<Exclude<CardIssue, null>, string> = {
      "not-found":
        "Card not found. Move it into either dashed area, against a contrasting background.",
      "beside-face": "Move the card into a dashed area beside your face.",
      small: "No clear card outline yet. Try bringing it closer to the camera.",
      clipped: "Move the whole card inside the preview, away from its edges.",
      landscape:
        "Try holding the card horizontally, with clear space around it.",
      edges:
        "Keep fingers off the front edges and avoid reflections on the card.",
      ambiguous:
        "Several rectangles are in view. Use a plainer background around the card.",
    };
    this.setStatus(
      !sample
        ? "Face not found. Look toward the camera and keep the card beside your face."
        : now - sample.timestamp > CARD_MAX_FRAME_AGE_MS
          ? "Camera processing is delayed. Hold still; try brighter light if this continues."
          : faceTurned
            ? "Face the camera straight on for this final hold."
            : !detectedCard
              ? hints[cardIssue ?? "not-found"]
              : this.calibration.instruction,
    );
    if (this.calibration.result) {
      this.ready = false;
      this.dialog.dataset.complete = "true";
      clearTimeout(this.timer);
      this.tracker.stopCardScan();
      this.heading.textContent = "Distance estimated.";
      this.steps.forEach((step) => step.classList.add("complete"));
      this.result.hidden = false;
      this.apply.hidden = false;
      this.result.querySelector("output")!.textContent =
        `~${Math.round(this.calibration.result.distanceCm)} cm`;
      this.setStatus(
        "Put the card away. Next, look at the dot to set neutral.",
      );
    }
  }
}
