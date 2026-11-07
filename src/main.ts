import "./style.css";
import { Euler, Quaternion, Vector3 } from "three";
import { icon, renderIcons } from "./icons";
import { FaceTracker } from "./tracker";
import { Viewer } from "./viewer";
import { isSplatName, superSplatBase } from "./splat-source";
import {
  controlSignal,
  isFresh,
  positionSignal,
  relativeAngles,
  smoothSignal,
  type Neutral,
  type Point,
  type Sample,
  type Signal,
  type Source,
} from "./tracking-math";
import type { ViewMode } from "./camera-rig";
import { ReferenceCapture } from "./reference-capture";
import { SpatialOverview, type OverviewState } from "./spatial-overview";
import { smoothGazeSignal, type GazeRotationMode } from "./object-rotation";
import { CardScan } from "./card-scan";
import { TrackingMarkers } from "./tracking-markers";
import {
  BANK_CARD_WIDTH_CM,
  DEFAULT_SCREEN_CALIBRATION,
  type HeadPerspective,
  type ScreenCalibration,
} from "./screen-window";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
renderIcons();

type Entry = {
  name: string;
  subtitle: string;
  credit: string;
  /** Splat scenes load from SuperSplat; GLBs load from /models. */
  scene?: string;
};
const models: Record<string, Entry> = {
  DamagedHelmet: {
    name: "Damaged helmet",
    subtitle: "Turn your head. Find a new angle.",
    credit: "ctxwing / theblueturtle_ · CC BY 4.0 / CC BY-NC 4.0",
  },
  BoomBox: {
    name: "Boom box",
    subtitle: "A little retro-futurism, from every angle.",
    credit: "Microsoft · CC0 1.0",
  },
  Avocado: {
    name: "Avocado",
    subtitle: "A fresh perspective on an everyday object.",
    credit: "Microsoft · CC0 1.0",
  },
  Duck: {
    name: "The classic duck",
    subtitle: "The original test subject. Still looking good.",
    credit: "Sony · SCEA Shared Source License 1.0",
  },
  Bookstore: {
    name: "Bookstore",
    subtitle: "Lean in. The aisles open up.",
    credit: "ethan3111 on SuperSplat · CC BY",
    scene: "ceeadeba",
  },
  ReadingRoom: {
    name: "Reading room",
    subtitle: "Move your head. The shelves slide past each other.",
    credit: "ethan3111 on SuperSplat · CC BY",
    scene: "9d370db9",
  },
  CoffeeShop: {
    name: "Coffee shop",
    subtitle: "Step to the side. Look past the counter.",
    credit: "ethan3111 on SuperSplat · CC BY",
    scene: "6a0c3ccf",
  },
  Pantheon: {
    name: "Pantheon interior",
    subtitle: "A big room. Look up into the dome.",
    credit: "artfletch on SuperSplat · CC BY",
    scene: "dac6e508",
  },
  Ludlow: {
    name: "Ludlow, Quality Square",
    subtitle: "A real street. Lean in to look down the lane.",
    credit: "ijenko on SuperSplat · CC BY",
    scene: "ca36efcc",
  },
  Cochem: {
    name: "Cochem Imperial Castle",
    subtitle: "A castle on a hill. Deep parallax across the valley.",
    credit: "dok11 on SuperSplat · CC BY",
    scene: "9b18007e",
  },
};
const modelSource = (key: string) =>
  models[key].scene
    ? `https://superspl.at/view?id=${models[key].scene}`
    : `/models/${key}.glb`;

let viewer: Viewer;
try {
  viewer = new Viewer($("canvas-container"));
  if (import.meta.env.DEV) Object.assign(window, { lookaround: viewer });
} catch (error) {
  $("viewer-message").textContent =
    "3D rendering is unavailable. Enable hardware acceleration or try another browser.";
  $("viewer-message").classList.add("error");
  throw error;
}
const spatialOverview = new SpatialOverview($("spatial-overview"));
const trackingOverlay =
  document.querySelector<SVGSVGElement>("#tracking-overlay")!;
const trackingMarkers = new TrackingMarkers(trackingOverlay);
// A fullscreen element is painted above the rest of the document.
document.addEventListener("fullscreenchange", () => {
  (document.fullscreenElement ?? document.body).append(trackingOverlay);
});
$("overview-mode").addEventListener("click", () => setMode("position"));

const tracker = new FaceTracker($<HTMLVideoElement>("camera-video"));
const overlay = $<HTMLCanvasElement>("face-overlay");
const context = overlay.getContext("2d")!;
let source: Source = "head";
let sample: Sample | null = null,
  neutral: Neutral | null = null;
let inputMode: "off" | "camera" | "simulation" = "off";
let paused = false,
  manual = false,
  lostFace = false;
const reference = new ReferenceCapture();
let filtered: Signal = { x: 0, y: 0 };
let filteredEyes: Signal = { x: 0, y: 0 };
let eyeRotation = false;
let gazeRotationMode: GazeRotationMode = "follow";
let screenCalibration = restoreScreenCalibration();
let trackingCmPerPoseUnit: number | null = null;
let neutralEyeDistanceCm = screenCalibration.eyeDistanceCm;
let sensitivity = 1,
  smoothing = 0.45,
  deadZone = 0.12,
  invert = false;
let inferenceMs = 0,
  simulationStart = 0,
  nextHud = 0,
  nextOverview = 0;
let loadGeneration = 0,
  toastTimer: ReturnType<typeof setTimeout>;
let inputGeneration = 0;
let referenceCompleteAt: number | null = null;
let cardScreenDistancePending = false;
const cardScan = new CardScan(
  $<HTMLDialogElement>("card-scan-dialog"),
  tracker,
  (measurement, useForScreen) => {
    if (inputMode !== "camera" || !tracker.active) return;
    cardScreenDistancePending = useForScreen;
    trackingCmPerPoseUnit = measurement.cmPerPoseUnit;
    calibrate();
  },
  () => rebase(),
);
viewer.rig.configureScreen(screenCalibration);
syncScreenCalibrationFields();

function restoreScreenCalibration(): ScreenCalibration {
  try {
    const saved = JSON.parse(
      localStorage.getItem("parallax-screen-calibration") ?? "null",
    );
    if (
      !saved ||
      ![
        saved.calibration?.screenWidthCm,
        saved.calibration?.eyeDistanceCm,
        saved.calibration?.objectDistanceCm,
      ].every((v) => Number.isFinite(v) && v > 0)
    )
      return { ...DEFAULT_SCREEN_CALIBRATION };
    const calibration: ScreenCalibration = { ...saved.calibration };
    if (
      saved.displayWidth !== window.screen.width ||
      saved.displayHeight !== window.screen.height ||
      !Number.isFinite(calibration.pixelsPerCm) ||
      !Number.isFinite(calibration.calibrationPixelRatio) ||
      (calibration.pixelsPerCm ?? 0) <= 0 ||
      (calibration.calibrationPixelRatio ?? 0) <= 0
    ) {
      delete calibration.pixelsPerCm;
      delete calibration.calibrationPixelRatio;
    }
    return calibration;
  } catch {
    return { ...DEFAULT_SCREEN_CALIBRATION };
  }
}

function syncScreenCalibrationFields() {
  $<HTMLInputElement>("screen-width").value =
    screenCalibration.screenWidthCm.toFixed(1);
  $<HTMLInputElement>("eye-distance").value =
    screenCalibration.eyeDistanceCm.toFixed(0);
  $<HTMLInputElement>("object-distance").value =
    screenCalibration.objectDistanceCm.toFixed(0);
  $("calibration-summary").textContent =
    `${screenCalibration.pixelsPerCm ? "Card-matched screen" : "Screen size estimate"} · ~${screenCalibration.eyeDistanceCm.toFixed(0)} cm to screen`;
}

function applyScreenCalibration() {
  cardScreenDistancePending = false;
  trackingCmPerPoseUnit = null;
  neutralEyeDistanceCm = screenCalibration.eyeDistanceCm;
  viewer.rig.configureScreen(screenCalibration);
  syncScreenCalibrationFields();
  saveScreenCalibration();
  rebase();
  if (inputMode !== "off") calibrate();
}

function saveScreenCalibration() {
  try {
    localStorage.setItem(
      "parallax-screen-calibration",
      JSON.stringify({
        calibration: screenCalibration,
        displayWidth: window.screen.width,
        displayHeight: window.screen.height,
      }),
    );
  } catch {
    /* Calibration still works without storage. */
  }
}

function toast(message: string) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 4000);
}

function status(message: string) {
  $("tracking-status").textContent = message;
}
function clearMotion() {
  filtered = { x: 0, y: 0 };
  filteredEyes = { x: 0, y: 0 };
}

// Orbiting a point inside an environment makes no sense; splats start in Head camera.
const defaultMode = (): ViewMode =>
  viewer.isEnvironment ? "position" : "orbit";
function setMode(mode: ViewMode) {
  if (mode === "orbit" && viewer.isEnvironment) return;
  viewer.rig.setMode(mode);
  rebase();
  for (const value of ["orbit", "look", "position"]) {
    $(`mode-${value}`).classList.toggle("active", mode === value);
    $(`mode-${value}`).setAttribute("aria-pressed", String(mode === value));
  }
  for (const id of ["source-label", "source-controls", "signal-note"])
    $(id).hidden = mode === "position";
  $("position-options").hidden = mode !== "position";
  $("mode-hint").textContent =
    mode === "orbit"
      ? "Turn a little. Keep orbiting. Return to center to stop."
      : mode === "look"
        ? "Stay in one spot. Turn your head to look left, right, up, or down."
        : "Move sideways, up/down, closer or farther. The screen stays fixed.";
  $("sensitivity-label").textContent =
    mode === "position" ? "Gaze sensitivity" : "Sensitivity";
  $("deadzone-label").textContent =
    mode === "position" ? "Gaze dead zone" : "Center dead zone";
  $("invert-label").textContent =
    mode === "position" ? "Invert gaze horizontal" : "Invert horizontal";
  syncHeadCameraControls();
}

function syncHeadCameraControls() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-head-perspective]")
    .forEach((button) => {
      const selected =
        button.dataset.headPerspective === viewer.rig.headPerspective;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  $("head-perspective-note").textContent =
    viewer.rig.headPerspective === "camera"
      ? "Closer makes it larger. Move sideways to see different sides; the image can shift off-center."
      : "The monitor is a fixed window into the scene.";
  document
    .querySelectorAll<HTMLButtonElement>("[data-head-view]")
    .forEach((button) => {
      const selected = (button.dataset.headView === "gaze") === eyeRotation;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  $("head-camera-note").textContent = eyeRotation
    ? "Head position moves the view. Eyes rotate the object. Blinks hold its angle."
    : "Shift your head to change perspective. The object stays fixed; head turns are ignored.";
  $("gaze-rotation-options").hidden = !eyeRotation;
  document
    .querySelectorAll<HTMLButtonElement>("[data-gaze-rotation]")
    .forEach((button) => {
      const selected = button.dataset.gazeRotation === gazeRotationMode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  $("gaze-rotation-note").textContent =
    gazeRotationMode === "continuous"
      ? "Look away to keep turning. Center your eyes to stop at the current angle."
      : "Gaze sets the angle. Center your eyes to return to the starting angle.";
  const positionOnly = viewer.rig.mode === "position" && !eyeRotation;
  if (viewer.rig.mode === "position")
    $("mode-hint").textContent = eyeRotation
      ? gazeRotationMode === "continuous"
        ? "Look away to turn the object. Center your eyes to stop. Head position moves the view."
        : "Move your head to change perspective. Look around to rotate the object."
      : "Move left/right, up/down, closer or farther. The object stays fixed.";
  for (const id of ["sensitivity", "deadzone", "invert"])
    $<HTMLInputElement>(id).disabled = positionOnly;
}

function commands(now = performance.now()) {
  return {
    movement:
      viewer.rig.mode === "position"
        ? positionSignal(sample, neutral, now, neutralEyeDistanceCm)
        : controlSignal(
            sample,
            neutral,
            source,
            now,
            sensitivity,
            deadZone,
            invert,
          ),
    eyes:
      viewer.rig.mode === "position" && eyeRotation
        ? controlSignal(
            sample,
            neutral,
            "eyes",
            now,
            sensitivity,
            deadZone,
            invert,
          )
        : null,
  };
}

function rebase() {
  // Clutch anchors preserve the visible pose; the dot-defined neutral is
  // deliberately NOT changed here. Seed filters with the same offsets.
  const input = commands();
  filtered = input.movement ?? filtered;
  filteredEyes = input.eyes ?? filteredEyes;
  viewer.rebase(
    filtered,
    viewer.rig.mode === "position" && eyeRotation ? filteredEyes : null,
  );
}

function calibrate() {
  if (inputMode === "off") return;
  // A new camera session starts at the configured neutral viewing distance.
  // Later reference holds preserve the fixed screen frame and tracking scale.
  if (trackingCmPerPoseUnit === null && viewer.rig.mode === "position")
    viewer.rig.configureScreen(screenCalibration);
  viewer.rig.freeze();
  viewer.rebase();
  clearMotion();
  neutral = null;
  reference.begin();
  referenceCompleteAt = null;
  const dialog = $<HTMLDialogElement>("reference-dialog");
  if (!dialog.open) dialog.showModal();
  $("reference-label").textContent =
    inputMode === "simulation" ? "SIMULATED INPUT · NO CAMERA" : "";
  $("reference-cancel").textContent =
    inputMode === "simulation" ? "Stop simulation" : "Stop camera";
  $("reference-dot").dataset.state = "moving";
  $("reference-dot").setAttribute("aria-valuenow", "0");
  $("reference-progress").style.strokeDashoffset = "1";
  $("reference-status").textContent = "Hold still";
  status("Look at the dot and hold still for one second.");
}

function closeReference() {
  reference.cancel();
  referenceCompleteAt = null;
  $<HTMLDialogElement>("reference-dialog").close();
}

function updateReference(now: number) {
  if (!reference.pending) return;
  const state = reference.readiness(now);
  const progress = reference.progress(now);
  $("reference-dot").dataset.state =
    state === "ready" ? "complete" : state === "holding" ? "holding" : "moving";
  $("reference-dot").setAttribute(
    "aria-valuenow",
    String(Math.round(progress * 100)),
  );
  $("reference-progress").style.strokeDashoffset = String(1 - progress);
  $("reference-status").textContent =
    state === "missing"
      ? "Find your face"
      : state === "moving"
        ? "Hold still"
        : state === "holding"
          ? "Keep looking"
          : "Ready";
  if (state !== "ready") {
    referenceCompleteAt = null;
    return;
  }
  // Let the completed ring remain visible before returning to the model.
  referenceCompleteAt ??= now;
  if (now - referenceCompleteAt >= 250) finishReference(now);
}

function updateButtons() {
  const on = inputMode !== "off";
  $("center-button").toggleAttribute("disabled", !on);
  $("pause-button").toggleAttribute("disabled", !on);
  $("camera-button").innerHTML =
    `${icon("camera")} ${inputMode === "camera" ? "Stop camera" : "Enable camera"} <span class="button-arrow">${inputMode === "camera" ? "×" : "↗"}</span>`;
  $("simulation-button").innerHTML =
    `${icon("play")} ${inputMode === "simulation" ? "Stop simulated tracking" : "Try simulated tracking"} <span>↗</span>`;
  $("simulation-button").setAttribute(
    "aria-pressed",
    String(inputMode === "simulation"),
  );
  $("simulation-tag").hidden = inputMode !== "simulation";
  $("camera-placeholder").hidden = inputMode === "camera";
  $("preview-label").textContent =
    inputMode === "camera"
      ? "LOCAL CAMERA"
      : inputMode === "simulation"
        ? "SIMULATED SIGNAL"
        : "CAMERA OFF";
  $("pause-tag").hidden = !paused || !on;
  $("pause-button").setAttribute("aria-pressed", String(paused));
  $("pause-button").setAttribute(
    "aria-label",
    paused ? "Resume tracking" : "Pause tracking",
  );
  $("pause-button").innerHTML = icon(paused ? "play" : "pause");
}

function stopInput() {
  cardScreenDistancePending = false;
  inputGeneration++;
  inputMode = "off";
  cardScan.close(false);
  trackingCmPerPoseUnit = null;
  tracker.stop();
  sample = null;
  neutral = null;
  closeReference();
  paused = false;
  lostFace = false;
  viewer.rebase();
  clearMotion();
  context.clearRect(0, 0, overlay.width, overlay.height);
  status("Enable your webcam to get started.");
  updateButtons();
}

tracker.onStatus = (message, failed) => {
  if (inputMode !== "camera") return;
  status(message);
  if (failed) {
    cardScreenDistancePending = false;
    inputMode = "off";
    cardScan.close(false);
    sample = null;
    neutral = null;
    closeReference();
    clearMotion();
    updateButtons();
  }
};
tracker.onSample = (next, points, elapsed, card, cardIssue) => {
  if (inputMode !== "camera") return;
  perf.results++;
  perf.inferenceMs += elapsed;
  sample = next;
  inferenceMs = elapsed;
  drawFace(points);
  if (cardScan.active) {
    if (!next && neutral) lostFace = true;
    cardScan.observe(next, points, card, performance.now(), cardIssue);
    return;
  }
  if (!next) {
    if (reference.pending) reference.observe(null, performance.now());
    if (neutral) {
      lostFace = true;
      viewer.rig.freeze();
      status(
        "Face lost. Movement frozen — return to the camera to set neutral again.",
      );
    }
    return;
  }
  if (lostFace) {
    lostFace = false;
    calibrate();
  }
  if (reference.pending) {
    reference.observe(next, performance.now());
    updateReference(performance.now());
  } else if (!paused && !manual && neutral) {
    status(
      viewer.rig.mode !== "position" && source === "eyes" && !next.eyesValid
        ? "Eyes closed or obscured. Movement frozen."
        : "Tracking ready. Small movements work best.",
    );
  }
};

function drawFace(points: Point[]) {
  const w = (overlay.width = tracker.video.videoWidth || 480);
  const h = (overlay.height = tracker.video.videoHeight || 300);
  context.clearRect(0, 0, w, h);
  if (!points.length) return;
  context.strokeStyle = "#edc794a0";
  context.fillStyle = "#edc794";
  context.lineWidth = Math.max(1, w / 700);
  const loops = [
    [33, 160, 158, 133, 153, 144, 33],
    [362, 385, 387, 263, 373, 380, 362],
    [
      10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
      378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
      162, 21, 54, 103, 67, 109, 10,
    ],
  ];
  for (const loop of loops) {
    context.beginPath();
    loop.forEach((index, i) => {
      const p = points[index];
      if (p) {
        if (i) context.lineTo(p.x * w, p.y * h);
        else context.moveTo(p.x * w, p.y * h);
      }
    });
    context.stroke();
  }
  for (const index of [1, 468, 473]) {
    const p = points[index];
    if (!p) continue;
    context.beginPath();
    context.arc(p.x * w, p.y * h, Math.max(2, w / 200), 0, Math.PI * 2);
    context.fill();
  }
}

$("camera-button").addEventListener("click", async () => {
  if (inputMode === "camera") {
    stopInput();
    return;
  }
  stopInput();
  inputMode = "camera";
  const generation = inputGeneration;
  updateButtons();
  calibrate();
  await tracker.start();
  if (generation !== inputGeneration) return;
  if (inputMode === "camera" && !tracker.active) {
    inputMode = "off";
    sample = null;
    closeReference();
    neutral = null;
    updateButtons();
  }
});
$("simulation-button").addEventListener("click", () => {
  if (inputMode === "simulation") {
    stopInput();
    return;
  }
  stopInput();
  inputMode = "simulation";
  simulationStart = performance.now();
  updateButtons();
  calibrate();
});

function finishReference(now: number) {
  const value = reference.accept(now);
  if (!value) return;
  if (cardScreenDistancePending && trackingCmPerPoseUnit !== null) {
    // The head may move while putting the card away. Transfer the measured
    // scale to this face-only reference instead of reusing the earlier depth.
    const distance = Math.abs(value.position.z) * trackingCmPerPoseUnit;
    if (Number.isFinite(distance) && distance >= 15 && distance <= 200) {
      screenCalibration = {
        ...screenCalibration,
        eyeDistanceCm: Math.round(distance),
      };
      viewer.rig.configureScreen(screenCalibration);
      syncScreenCalibrationFields();
      saveScreenCalibration();
    }
    cardScreenDistancePending = false;
  }
  neutral = value;
  trackingCmPerPoseUnit ??=
    screenCalibration.eyeDistanceCm /
    Math.max(Math.abs(value.position.z), 1e-3);
  neutralEyeDistanceCm = Math.abs(value.position.z) * trackingCmPerPoseUnit;
  viewer.rig.freeze();
  viewer.rebase();
  clearMotion();
  $<HTMLDialogElement>("reference-dialog").close();
  if (inputMode === "simulation") simulationStart = performance.now();
  lostFace = false;
  status(
    paused
      ? "Neutral set. Tracking is paused."
      : inputMode === "simulation"
        ? "Simulated movement. No webcam in use."
        : "Neutral set. Move comfortably to explore.",
  );
  referenceCompleteAt = null;
}
$("reference-cancel").addEventListener("click", stopInput);
$<HTMLDialogElement>("reference-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  stopInput();
});

$("center-button").addEventListener("click", calibrate);
function togglePause() {
  if (inputMode === "off" || reference.pending) return;
  paused = !paused;
  viewer.rig.freeze();
  rebase();
  updateButtons();
  status(
    paused
      ? "Paused. Explore freely with your mouse."
      : inputMode === "simulation"
        ? "Simulated tracking resumed."
        : "Tracking resumed from the current view.",
  );
}
$("pause-button").addEventListener("click", togglePause);

viewer.onManual = (active) => {
  manual = active;
  viewer.rig.freeze();
  if (!active) {
    rebase();
    if (inputMode === "camera" && !paused)
      status("Tracking resumed from the current view.");
  } else if (inputMode !== "off")
    status("Manual control. Tracking yields to your mouse.");
};

document
  .querySelectorAll<HTMLButtonElement>("[data-source]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      source = button.dataset.source as Source;
      document
        .querySelectorAll<HTMLButtonElement>("[data-source]")
        .forEach((b) => {
          b.classList.toggle("active", b === button);
          b.setAttribute("aria-pressed", String(b === button));
        });
      $("source-kind").textContent =
        source === "head" ? "HEAD POSE" : "EXPERIMENTAL";
      $("signal-note").textContent =
        source === "head"
          ? "Head rotation steers the camera."
          : source === "eyes"
            ? "Rough iris direction, not screen gaze. Keep your head still; look at center to set neutral."
            : "Head steering + a subtle eye direction assist. Eye input is experimental.";
      rebase();
    }),
  );

$("mode-orbit").addEventListener("click", () => setMode("orbit"));
$("mode-look").addEventListener("click", () => setMode("look"));
$("mode-position").addEventListener("click", () => setMode("position"));
$("screen-calibration-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const previousWidth = screenCalibration.screenWidthCm;
  screenCalibration = {
    ...screenCalibration,
    screenWidthCm: Number($<HTMLInputElement>("screen-width").value),
    eyeDistanceCm: Number($<HTMLInputElement>("eye-distance").value),
    objectDistanceCm: Number($<HTMLInputElement>("object-distance").value),
  };
  if (Math.abs(screenCalibration.screenWidthCm - previousWidth) > 0.05) {
    delete screenCalibration.pixelsPerCm;
    delete screenCalibration.calibrationPixelRatio;
  }
  applyScreenCalibration();
  toast("Screen calibration applied");
});
$("estimate-distance").addEventListener("click", () => {
  if (inputMode !== "camera" || !tracker.active) return;
  viewer.rig.freeze();
  cardScan.start();
});

function resizeCardOutline(width: number) {
  const range = $<HTMLInputElement>("card-size");
  range.value = String(
    Math.max(Number(range.min), Math.min(Number(range.max), width)),
  );
  $("card-outline").style.width = `${range.value}px`;
}
$("match-card").addEventListener("click", () => {
  const range = $<HTMLInputElement>("card-size");
  range.max = String(
    Math.max(
      100,
      Math.min(
        500,
        innerWidth - 112,
        ((innerHeight * 0.42 - 20) * 8.56) / 5.398,
      ),
    ),
  );
  const pxPerCm = screenCalibration.pixelsPerCm
    ? (screenCalibration.pixelsPerCm *
        (screenCalibration.calibrationPixelRatio ?? devicePixelRatio)) /
      devicePixelRatio
    : window.screen.width / screenCalibration.screenWidthCm;
  resizeCardOutline(BANK_CARD_WIDTH_CM * pxPerCm);
  viewer.rig.freeze();
  $<HTMLDialogElement>("card-dialog").showModal();
});
$<HTMLInputElement>("card-size").addEventListener("input", (event) =>
  resizeCardOutline(Number((event.target as HTMLInputElement).value)),
);
$("close-card").addEventListener("click", () => {
  $<HTMLDialogElement>("card-dialog").close();
  rebase();
});
$<HTMLDialogElement>("card-dialog").addEventListener("cancel", () => rebase());
$("confirm-card").addEventListener("click", () => {
  screenCalibration = {
    ...screenCalibration,
    pixelsPerCm:
      $("card-outline").getBoundingClientRect().width / BANK_CARD_WIDTH_CM,
    calibrationPixelRatio: devicePixelRatio,
  };
  $<HTMLDialogElement>("card-dialog").close();
  applyScreenCalibration();
  toast("Screen size calibrated");
});
let cardDrag: { x: number; width: number } | null = null;
$("card-resize-handle").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  cardDrag = {
    x: event.clientX,
    width: $("card-outline").getBoundingClientRect().width,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
});
$("card-resize-handle").addEventListener("pointermove", (event) => {
  if (cardDrag) resizeCardOutline(cardDrag.width + event.clientX - cardDrag.x);
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
  $("card-resize-handle").addEventListener(event, () => {
    cardDrag = null;
  });
document
  .querySelectorAll<HTMLButtonElement>("[data-head-perspective]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      viewer.rig.setHeadPerspective(
        button.dataset.headPerspective as HeadPerspective,
      );
      syncHeadCameraControls();
    }),
  );
document
  .querySelectorAll<HTMLButtonElement>("[data-head-view]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      eyeRotation = button.dataset.headView === "gaze";
      rebase();
      syncHeadCameraControls();
    }),
  );
document
  .querySelectorAll<HTMLButtonElement>("[data-gaze-rotation]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      gazeRotationMode = button.dataset.gazeRotation as GazeRotationMode;
      viewer.setGazeRotationMode(gazeRotationMode, commands().eyes);
      rebase();
      syncHeadCameraControls();
    }),
  );

function resetView() {
  viewer.resetView();
  setMode(defaultMode());
  rebase();
  toast("View reset");
}
$("reset-button").addEventListener("click", resetView);
$("grid-button").addEventListener("click", () => {
  const button = $("grid-button"),
    visible = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(visible));
  viewer.setGrid(visible);
});
$("wire-button").addEventListener("click", () => {
  const button = $("wire-button"),
    enabled = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(enabled));
  viewer.setWireframe(enabled);
});
$("fullscreen-button").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("stage").requestFullscreen();
  } catch {
    toast("Fullscreen is unavailable in this browser.");
  }
});

for (const name of ["sensitivity", "smoothing", "deadzone"]) {
  $<HTMLInputElement>(name).addEventListener("input", (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    if (name === "sensitivity") {
      sensitivity = value;
      $("sensitivity-value").textContent = `${value.toFixed(1)}×`;
    }
    if (name === "smoothing") {
      smoothing = value;
      $("smoothing-value").textContent =
        value < 0.25 ? "Responsive" : value > 0.7 ? "Steady" : "Balanced";
    }
    if (name === "deadzone") {
      deadZone = value;
      $("deadzone-value").textContent = `${Math.round(value * 100)}%`;
    }
  });
}
$<HTMLInputElement>("invert").addEventListener("change", (event) => {
  invert = (event.target as HTMLInputElement).checked;
  rebase();
});
$<HTMLInputElement>("tracking-markers").addEventListener("change", (event) => {
  trackingMarkers.setEnabled((event.target as HTMLInputElement).checked);
});

async function loadModel(asset: string | File, key?: string) {
  const generation = ++loadGeneration;
  const message = $("viewer-message");
  message.hidden = false;
  message.classList.remove("error");
  const status = (text: string) => {
    if (generation !== loadGeneration) return;
    message.innerHTML = '<span class="spinner"></span> ';
    message.append(text);
  };
  const splat =
    asset instanceof File
      ? isSplatName(asset.name)
      : superSplatBase(asset) !== null || isSplatName(asset);
  status(splat ? "Opening the scene…" : "Opening the object…");
  viewer.onProgress = status;
  try {
    const info = await viewer.load(asset);
    if (!info || generation !== loadGeneration) return;
    message.hidden = true;
    const name = key
      ? models[key].name
      : asset instanceof File
        ? asset.name.replace(/\.(glb|ply|spz|splat|ksplat|sog)$/i, "")
        : superSplatBase(asset)
          ? "SuperSplat scene"
          : new URL(asset).pathname.split("/").pop() || "Custom model";
    $("model-name").textContent = name;
    $("model-subtitle").textContent = key
      ? models[key].subtitle
      : "Your object. A new perspective.";
    $("model-format").textContent =
      info.kind === "splat" ? "GAUSSIAN SPLAT" : "GLB 2.0";
    $("geometry-info").textContent =
      info.kind === "splat"
        ? `${info.splats.toLocaleString()} SPLATS · ${(info.bytes / 1024 / 1024).toFixed(1)} MB`
        : `${info.triangles.toLocaleString()} TRIANGLES · ${(info.bytes / 1024 / 1024).toFixed(1)} MB`;
    $("world-scale-row").hidden = info.kind !== "splat";
    $("canvas-container").dataset.model = name;
    $("canvas-container").dataset.triangles = String(info.triangles);
    const credit = $<HTMLAnchorElement>("model-credit");
    credit.hidden = !key;
    if (key) {
      credit.textContent = `${models[key].credit} ↗`;
      credit.href = models[key].scene
        ? `https://superspl.at/view?id=${models[key].scene}`
        : `/models/licenses/${key}.md`;
    }
    document
      .querySelectorAll<HTMLButtonElement>("[data-model]")
      .forEach((b) => {
        const selected = b.dataset.model === key;
        b.classList.toggle("selected", selected);
        b.setAttribute("aria-pressed", String(selected));
      });
    $("mode-orbit").hidden = viewer.isEnvironment;
    if (key && $("more-models").querySelector(`[data-model="${key}"]`))
      $<HTMLDetailsElement>("more-models").open = true;
    if (!key) shareKey(null);
    setMode(defaultMode());
    rebase();
  } catch (error) {
    if (generation !== loadGeneration) return;
    const reason = error instanceof Error ? error.message : String(error);
    message.classList.add("error");
    message.textContent = reason.includes("fetch")
      ? "Could not download the file. Check the URL and CORS permissions, or drop a local file."
      : `Could not open model: ${reason}`;
  }
}

document.querySelectorAll<HTMLButtonElement>("[data-model]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.model!;
    void loadModel(modelSource(key), key);
    shareKey(key);
  }),
);
// Keep the current demo in the address bar so the link can be shared.
function shareKey(key: string | null) {
  const url = new URL(location.href);
  if (key && key !== "DamagedHelmet") url.searchParams.set("scene", key);
  else url.searchParams.delete("scene");
  if (url.href === location.href) return;
  // Custom files and URLs cannot be shared, so they replace rather than add history.
  if (key) history.pushState({ key }, "", url);
  else history.replaceState(null, "", url);
}
function keyFromUrl() {
  const key = new URLSearchParams(location.search).get("scene");
  return key && key in models ? key : "DamagedHelmet";
}
window.addEventListener("popstate", () => {
  const key = keyFromUrl();
  void loadModel(modelSource(key), key);
});
$("upload-button").addEventListener("click", () =>
  $<HTMLInputElement>("file-input").click(),
);
async function loadFile(file: File) {
  const splat = isSplatName(file.name);
  if (!splat && !file.name.toLowerCase().endsWith(".glb")) {
    toast(
      "Choose a .glb model or a .ply, .spz, .splat, .ksplat or .sog splat.",
    );
    return;
  }
  if (!splat && file.size > 150 * 1024 * 1024) {
    toast("Please choose a model smaller than 150 MB.");
    return;
  }
  await loadModel(file);
}
$<HTMLInputElement>("file-input").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.files?.[0]) void loadFile(input.files[0]);
  input.value = "";
});
$("url-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = new URL($<HTMLInputElement>("model-url").value);
  if (!["https:", "http:"].includes(url.protocol)) {
    toast("Use an HTTP or HTTPS model URL.");
    return;
  }
  void loadModel(url.href);
});
let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if (event.dataTransfer?.types.includes("Files")) {
    event.preventDefault();
    dragDepth++;
    $("drag-overlay").hidden = false;
  }
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drag-overlay").hidden = true;
});
document.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  $("drag-overlay").hidden = true;
  const file = event.dataTransfer?.files[0];
  if (file) void loadFile(file);
});

$("help-button").addEventListener("click", () =>
  $<HTMLDialogElement>("help-dialog").showModal(),
);
$("close-help").addEventListener("click", () =>
  $<HTMLDialogElement>("help-dialog").close(),
);
$<HTMLDialogElement>("help-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      $<HTMLDialogElement>("help-dialog").close();
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement ||
    $<HTMLDialogElement>("help-dialog").open ||
    $<HTMLDialogElement>("reference-dialog").open ||
    $<HTMLDialogElement>("card-dialog").open ||
    cardScan.active ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.repeat
  )
    return;
  if (event.code === "Space" && inputMode !== "off") {
    event.preventDefault();
    togglePause();
  }
  if (event.key.toLowerCase() === "c") calibrate();
  if (event.key.toLowerCase() === "r") resetView();
  if (event.key === "1") setMode("orbit");
  if (event.key === "2") setMode("look");
  if (event.key === "3") setMode("position");
});
// WASD walks through the scene; Q/E sink and rise. Works in every view mode.
const held = new Set<string>();
const updateMove = () =>
  viewer.setMoveInput(
    Number(held.has("KeyD")) - Number(held.has("KeyA")),
    Number(held.has("KeyE")) - Number(held.has("KeyQ")),
    Number(held.has("KeyW")) - Number(held.has("KeyS")),
  );
document.addEventListener("keydown", (event) => {
  if (
    !["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"].includes(event.code) ||
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  held.add(event.code);
  updateMove();
});
document.addEventListener("keyup", (event) => {
  if (held.delete(event.code)) updateMove();
});
window.addEventListener("blur", () => {
  held.clear();
  updateMove();
});
$<HTMLInputElement>("world-scale").addEventListener("input", (event) => {
  const value = 2 ** Number((event.target as HTMLInputElement).value);
  $("world-scale-value").textContent =
    value >= 0.995 && value <= 1.005 ? "Life size" : `${value.toFixed(2)}×`;
  viewer.setWorldScale(value);
});
document.addEventListener("visibilitychange", () => {
  viewer.rig.freeze();
  if (document.hidden) {
    sample = null;
    if (inputMode === "camera") lostFace = true;
  } else if (inputMode === "simulation") rebase();
});
window.addEventListener("pagehide", () => {
  cardScan.close(false);
  tracker.stop();
});

let last = performance.now();
function animate(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (inputMode === "simulation") {
    const t = reference.pending ? 0 : (now - simulationStart) / 1000;
    const yaw = Math.sin(t * 0.6) * 0.24,
      pitch = Math.sin(t * 0.37) * 0.09;
    sample = {
      rotation: new Quaternion().setFromEuler(new Euler(pitch, -yaw, 0, "YXZ")),
      position: new Vector3(
        -Math.sin(t * 0.5) * 7.2,
        Math.sin(t * 0.4) * 3,
        -60 + Math.sin(t * 0.32) * 10,
      ),
      eyeX: -Math.sin(t * 0.8) * 0.07,
      eyeY: Math.sin(t * 0.6) * 0.025,
      eyesValid: true,
      timestamp: now,
    };
    if (reference.pending) reference.observe(sample, now);
  }
  // These show live input even while scene motion is paused or mouse-controlled.
  trackingMarkers.update(
    inputMode !== "off" &&
      !document.hidden &&
      !reference.pending &&
      !$<HTMLDialogElement>("card-dialog").open &&
      !cardScan.active
      ? sample
      : null,
    neutral,
    now,
    dt,
    screenCalibration,
    neutralEyeDistanceCm,
  );
  const allowed =
    !paused &&
    !manual &&
    !document.hidden &&
    !reference.pending &&
    !$<HTMLDialogElement>("card-dialog").open &&
    !cardScan.active &&
    inputMode !== "off";
  const raw = allowed ? commands(now) : { movement: null, eyes: null };
  let signal = raw.movement;
  let eyeSignal = raw.eyes;
  if (signal) {
    filtered = smoothSignal(
      filtered,
      signal,
      dt,
      viewer.rig.mode === "position" ? Math.min(smoothing, 0.15) : smoothing,
    );
    signal = filtered;
  } else if (viewer.rig.mode === "orbit") filtered = { x: 0, y: 0 };
  if (eyeSignal) {
    filteredEyes = smoothGazeSignal(
      filteredEyes,
      eyeSignal,
      dt,
      smoothing,
      gazeRotationMode,
    );
    eyeSignal = filteredEyes;
  }
  // The reference overlay covers the scene. Keep its pose (and GPU work)
  // frozen so sampling the neutral isn't competing with 3D rendering.
  if (
    !reference.pending &&
    !$<HTMLDialogElement>("card-dialog").open &&
    !cardScan.active
  )
    viewer.render(signal, dt, eyeSignal);
  if (now >= nextHud) {
    nextHud = now + 100;
    const overviewState: OverviewState =
      viewer.rig.mode !== "position"
        ? "Preview"
        : reference.pending
          ? "Centering"
          : paused
            ? "Paused"
            : manual
              ? "Mouse"
              : inputMode === "off"
                ? "Ready"
                : !signal
                  ? "Held"
                  : inputMode === "simulation"
                    ? "Simulated"
                    : "Live";
    // The environment sketch scans thousands of splat samples and rebuilds
    // its SVG; a few updates a second is plenty and keeps head tracking smooth.
    if (now >= nextOverview) {
      nextOverview = now + (viewer.isEnvironment ? 300 : 0);
      spatialOverview.update(viewer.spatialGeometry, overviewState);
    }
    $("estimate-distance").toggleAttribute(
      "disabled",
      inputMode !== "camera" || !tracker.active,
    );
    updateReference(now);
    if (
      inputMode === "camera" &&
      neutral &&
      sample &&
      now - sample.timestamp > 250 &&
      !paused &&
      !manual
    )
      status("Tracking delayed. Movement is held until a fresh frame arrives.");
    const x = signal?.x ?? 0,
      y = signal?.y ?? 0;
    const monitorScale = viewer.rig.mode === "position" ? 10 : 1;
    $("signal-dot").style.left =
      `${50 + Math.max(-1, Math.min(1, x / monitorScale)) * 40}%`;
    $("signal-dot").style.top =
      `${50 + Math.max(-1, Math.min(1, y / monitorScale)) * 40}%`;
    const direction =
      Math.abs(x) < 0.03 && Math.abs(y) < 0.03
        ? "Centered"
        : `${Math.abs(x) > 0.03 ? (x > 0 ? "Right" : "Left") : ""}${Math.abs(x) > 0.03 && Math.abs(y) > 0.08 ? " + " : ""}${Math.abs(y) > 0.08 ? (y > 0 ? "down" : "up") : ""}`;
    $("signal-direction").textContent = paused
      ? "Paused"
      : manual
        ? "Mouse control"
        : direction;
    $("inference-info").textContent =
      inputMode === "simulation"
        ? "Synthetic input · demo only"
        : inputMode === "off"
          ? "Waiting for input"
          : isFresh(sample, now)
            ? viewer.rig.mode === "position"
              ? `${viewer.rig.eyeDistanceCm.toFixed(0)} cm to screen · estimated`
              : `${inferenceMs.toFixed(0)} ms inference · ${Math.round((relativeAngles(sample.rotation, neutral?.rotation ?? sample.rotation).x * 180) / Math.PI)}° yaw`
            : "Waiting for face";
    $("view-angle").textContent =
      viewer.rig.mode === "position"
        ? "HEAD CAMERA · XYZ"
        : `${String(Math.round(viewer.rig.azimuth)).padStart(3, "0")}° ${viewer.rig.mode === "orbit" ? "AZIMUTH" : "LOOK MODE"}`;
    $("stage").dataset.mode = viewer.rig.mode;
    $("stage").dataset.perspective = viewer.rig.headPerspective;
    $("stage").dataset.input = inputMode;
    $("stage").dataset.paused = String(paused);
    $("stage").dataset.reference = reference.pending
      ? "pending"
      : neutral
        ? "set"
        : "unset";
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ?perf shows live timing numbers, for diagnosing slow machines.
const perf = { frames: 0, worst: 0, last: 0, results: 0, inferenceMs: 0 };
if (new URLSearchParams(location.search).has("perf")) {
  const box = document.createElement("pre");
  box.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:99;margin:0;padding:8px 10px;background:#000c;color:#9f9;font:11px/1.45 ui-monospace,monospace;border-radius:6px;pointer-events:none";
  document.body.append(box);
  const tick = (now: number) => {
    if (perf.last) perf.worst = Math.max(perf.worst, now - perf.last);
    perf.last = now;
    perf.frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(() => {
    const v = viewer.takePerf();
    box.textContent = [
      `fps ${perf.frames}  worst frame ${perf.worst.toFixed(0)} ms`,
      `render ${v.width}×${v.height} @ ${v.ratio.toFixed(2)}x  dpr ${devicePixelRatio}`,
      `splats ${(v.splats / 1e6).toFixed(2)}M  sorts ${v.sorts}/s  ${v.sortMs.toFixed(0)} ms each`,
      `face ${perf.results}/s  ${(perf.results ? perf.inferenceMs / perf.results : 0).toFixed(0)} ms inference`,
      v.gpu.slice(0, 60),
    ].join("\n");
    Object.assign(perf, { frames: 0, worst: 0, results: 0, inferenceMs: 0 });
  }, 1000);
}
{
  const key = keyFromUrl();
  void loadModel(modelSource(key), key);
}
