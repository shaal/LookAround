import "./style.css";
import { Euler, Quaternion, Vector3 } from "three";
import { icon, renderIcons } from "./icons";
import { FaceTracker } from "./tracker";
import { Viewer } from "./viewer";
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

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
renderIcons();

const models: Record<
  string,
  { name: string; subtitle: string; credit: string }
> = {
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
};

let viewer: Viewer;
try {
  viewer = new Viewer($("canvas-container"));
} catch (error) {
  $("viewer-message").textContent =
    "3D rendering is unavailable. Enable hardware acceleration or try another browser.";
  $("viewer-message").classList.add("error");
  throw error;
}

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
let sensitivity = 1,
  smoothing = 0.45,
  deadZone = 0.12,
  invert = false;
let inferenceMs = 0,
  simulationStart = 0,
  nextHud = 0;
let loadGeneration = 0,
  toastTimer: ReturnType<typeof setTimeout>;
let inputGeneration = 0;
let referenceCompleteAt: number | null = null;

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

function setMode(mode: ViewMode) {
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
        : "Slide your head sideways or up/down. Your camera moves with you.";
}

function commands(now = performance.now()) {
  return {
    movement:
      viewer.rig.mode === "position"
        ? positionSignal(sample, neutral, now, sensitivity, deadZone, invert)
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
  viewer.rig.rebase(
    filtered,
    viewer.rig.mode === "position" && eyeRotation ? filteredEyes : null,
  );
}

function calibrate() {
  if (inputMode === "off") return;
  viewer.rig.freeze();
  viewer.rig.rebase();
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
  inputGeneration++;
  inputMode = "off";
  tracker.stop();
  sample = null;
  neutral = null;
  closeReference();
  paused = false;
  lostFace = false;
  viewer.rig.rebase();
  clearMotion();
  context.clearRect(0, 0, overlay.width, overlay.height);
  status("Enable your webcam to get started.");
  updateButtons();
}

tracker.onStatus = (message, failed) => {
  if (inputMode !== "camera") return;
  status(message);
  if (failed) {
    inputMode = "off";
    sample = null;
    neutral = null;
    closeReference();
    clearMotion();
    updateButtons();
  }
};
tracker.onSample = (next, points, elapsed) => {
  if (inputMode !== "camera") return;
  sample = next;
  inferenceMs = elapsed;
  drawFace(points);
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
  neutral = value;
  viewer.rig.freeze();
  viewer.rig.rebase();
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
$<HTMLInputElement>("eye-rotation").addEventListener("change", (event) => {
  eyeRotation = (event.target as HTMLInputElement).checked;
  rebase();
  if (eyeRotation)
    toast(
      "Experimental eye rotation enabled. Use C to reset the center dot if needed.",
    );
});

function resetView() {
  viewer.rig.reset();
  setMode("orbit");
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

async function loadModel(asset: string | File, key?: string) {
  const generation = ++loadGeneration;
  const message = $("viewer-message");
  message.hidden = false;
  message.classList.remove("error");
  message.innerHTML = '<span class="spinner"></span> Opening the object…';
  try {
    const info = await viewer.load(asset);
    if (!info || generation !== loadGeneration) return;
    message.hidden = true;
    const name = key
      ? models[key].name
      : asset instanceof File
        ? asset.name.replace(/\.glb$/i, "")
        : new URL(asset).pathname.split("/").pop() || "Custom model";
    $("model-name").textContent = name;
    $("model-subtitle").textContent = key
      ? models[key].subtitle
      : "Your object. A new perspective.";
    $("geometry-info").textContent =
      `${info.triangles.toLocaleString()} TRIANGLES · ${(info.bytes / 1024 / 1024).toFixed(1)} MB`;
    $("canvas-container").dataset.model = name;
    $("canvas-container").dataset.triangles = String(info.triangles);
    const credit = $<HTMLAnchorElement>("model-credit");
    credit.hidden = !key;
    if (key) {
      credit.textContent = `${models[key].credit} ↗`;
      credit.href = `/models/licenses/${key}.md`;
    }
    document
      .querySelectorAll<HTMLButtonElement>("[data-model]")
      .forEach((b) => {
        const selected = b.dataset.model === key;
        b.classList.toggle("selected", selected);
        b.setAttribute("aria-pressed", String(selected));
      });
    setMode("orbit");
    rebase();
  } catch (error) {
    if (generation !== loadGeneration) return;
    const reason = error instanceof Error ? error.message : String(error);
    message.classList.add("error");
    message.textContent = reason.includes("fetch")
      ? "Could not download the GLB. Check the URL and CORS permissions, or drop a local file."
      : `Could not open model: ${reason}`;
  }
}

document.querySelectorAll<HTMLButtonElement>("[data-model]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.model!;
    void loadModel(`/models/${key}.glb`, key);
  }),
);
$("upload-button").addEventListener("click", () =>
  $<HTMLInputElement>("file-input").click(),
);
async function loadFile(file: File) {
  if (!file.name.toLowerCase().endsWith(".glb")) {
    toast("Choose a binary .glb model.");
    return;
  }
  if (file.size > 150 * 1024 * 1024) {
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
document.addEventListener("visibilitychange", () => {
  viewer.rig.freeze();
  if (document.hidden) {
    sample = null;
    if (inputMode === "camera") lostFace = true;
  } else if (inputMode === "simulation") rebase();
});
window.addEventListener("pagehide", () => tracker.stop());

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
        -60,
      ),
      eyeX: -Math.sin(t * 0.8) * 0.07,
      eyeY: Math.sin(t * 0.6) * 0.025,
      eyesValid: true,
      timestamp: now,
    };
    if (reference.pending) reference.observe(sample, now);
  }
  const allowed =
    !paused &&
    !manual &&
    !document.hidden &&
    !reference.pending &&
    inputMode !== "off";
  const raw = allowed ? commands(now) : { movement: null, eyes: null };
  let signal = raw.movement;
  let eyeSignal = raw.eyes;
  if (signal) {
    filtered = smoothSignal(filtered, signal, dt, smoothing);
    signal = filtered;
  } else if (viewer.rig.mode === "orbit") filtered = { x: 0, y: 0 };
  if (eyeSignal) {
    filteredEyes = smoothSignal(filteredEyes, eyeSignal, dt, smoothing);
    eyeSignal = filteredEyes;
  }
  // The reference overlay covers the scene. Keep its pose (and GPU work)
  // frozen so sampling the neutral isn't competing with 3D rendering.
  if (!reference.pending) viewer.render(signal, dt, eyeSignal);
  if (now >= nextHud) {
    nextHud = now + 100;
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
    $("signal-dot").style.left = `${50 + x * 40}%`;
    $("signal-dot").style.top = `${50 + y * 40}%`;
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
              ? `${inferenceMs.toFixed(0)} ms inference · head position`
              : `${inferenceMs.toFixed(0)} ms inference · ${Math.round((relativeAngles(sample.rotation, neutral?.rotation ?? sample.rotation).x * 180) / Math.PI)}° yaw`
            : "Waiting for face";
    $("view-angle").textContent =
      viewer.rig.mode === "position"
        ? "HEAD CAMERA · XY"
        : `${String(Math.round(viewer.rig.azimuth)).padStart(3, "0")}° ${viewer.rig.mode === "orbit" ? "AZIMUTH" : "LOOK MODE"}`;
    $("stage").dataset.mode = viewer.rig.mode;
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
void loadModel("/models/DamagedHelmet.glb", "DamagedHelmet");
