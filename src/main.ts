import "./style.css";
import { Euler, Quaternion } from "three";
import { icon, renderIcons } from "./icons";
import { FaceTracker } from "./tracker";
import { Viewer } from "./viewer";
import {
  clamp,
  controlSignal,
  neutralFromSamples,
  relativeAngles,
  smoothSignal,
  type Neutral,
  type Point,
  type Sample,
  type Signal,
  type Source,
} from "./tracking-math";
import type { ViewMode } from "./camera-rig";

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
let calibration: Sample[] | null = null;
let filtered: Signal = { x: 0, y: 0 };
let sensitivity = 1,
  smoothing = 0.45,
  deadZone = 0.12,
  invert = false;
let inferenceMs = 0,
  simulationStart = 0,
  nextHud = 0;
let loadGeneration = 0,
  toastTimer: ReturnType<typeof setTimeout>;

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
}

function setMode(mode: ViewMode) {
  viewer.rig.setMode(mode);
  // Both camera behaviors start from the currently visible pose and neutral.
  rebase();
  $("mode-orbit").classList.toggle("active", mode === "orbit");
  $("mode-look").classList.toggle("active", mode === "look");
  $("mode-orbit").setAttribute("aria-pressed", String(mode === "orbit"));
  $("mode-look").setAttribute("aria-pressed", String(mode === "look"));
  $("mode-hint").textContent =
    mode === "orbit"
      ? "Turn a little. Keep orbiting. Return to center to stop."
      : "Stay in one spot. Turn your head to look left, right, up, or down.";
}

function rebase() {
  viewer.rig.rebase();
  clearMotion();
  if (sample) neutral = neutralFromSamples([sample]);
}

function calibrate() {
  if (inputMode === "off") return;
  viewer.rig.rebase();
  clearMotion();
  if (inputMode === "simulation") {
    rebase();
    toast("Simulated neutral updated");
    return;
  }
  calibration = [];
  neutral = null;
  status(
    source === "head"
      ? "Face forward and hold still for one second."
      : "Face forward, eyes open, and look at the center.",
  );
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
  inputMode = "off";
  tracker.stop();
  sample = null;
  neutral = null;
  calibration = null;
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
    calibration = null;
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
    clearMotion();
    if (neutral || calibration?.length) {
      lostFace = true;
      status("Face lost. Movement frozen — face the camera to resume.");
    }
    return;
  }
  if (lostFace) {
    lostFace = false;
    calibrate();
  }
  if (calibration) {
    if (source !== "head" && !next.eyesValid) {
      calibration = [];
      status("Open both eyes and look at the center to set neutral.");
      return;
    }
    if (
      calibration.length &&
      next.rotation.angleTo(calibration[0].rotation) > 0.09
    ) {
      calibration = [];
    }
    calibration.push(next);
    const elapsed = next.timestamp - calibration[0].timestamp;
    status(
      `Setting neutral · hold still ${Math.round(Math.min(clamp(elapsed / 900, 0, 1), calibration.length / 12) * 100)}%`,
    );
    if (elapsed >= 900 && calibration.length >= 12) {
      neutral = neutralFromSamples(calibration);
      calibration = null;
      clearMotion();
      status("Tracking ready. Small movements work best.");
    }
  } else if (!paused && !manual && neutral) {
    status(
      source === "eyes" && !next.eyesValid
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
  updateButtons();
  calibrate();
  await tracker.start();
  if (inputMode === "camera" && !tracker.active) {
    inputMode = "off";
    sample = null;
    calibration = null;
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
  neutral = { rotation: new Quaternion(), eyeX: 0, eyeY: 0 };
  viewer.rig.rebase();
  status("Simulated head + eye input. No webcam in use.");
  updateButtons();
});

$("center-button").addEventListener("click", calibrate);
function togglePause() {
  if (inputMode === "off") return;
  paused = !paused;
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
  clearMotion();
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
      if (inputMode !== "off") calibrate();
    }),
  );

$("mode-orbit").addEventListener("click", () => setMode("orbit"));
$("mode-look").addEventListener("click", () => setMode("look"));

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
  clearMotion();
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
});
document.addEventListener("visibilitychange", () => {
  clearMotion();
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
    const t = (now - simulationStart) / 1000;
    const yaw = Math.sin(t * 0.6) * 0.24,
      pitch = Math.sin(t * 0.37) * 0.09;
    sample = {
      rotation: new Quaternion().setFromEuler(new Euler(pitch, -yaw, 0, "YXZ")),
      eyeX: -Math.sin(t * 0.8) * 0.07,
      eyeY: Math.sin(t * 0.6) * 0.025,
      eyesValid: true,
      timestamp: now,
    };
  }
  let signal =
    !paused &&
    !manual &&
    !document.hidden &&
    !calibration &&
    inputMode !== "off"
      ? controlSignal(
          sample,
          neutral,
          source,
          now,
          sensitivity,
          deadZone,
          invert,
        )
      : null;
  if (signal) {
    filtered = smoothSignal(filtered, signal, dt, smoothing);
    signal = filtered;
  } else clearMotion();
  viewer.render(signal, dt);
  if (now >= nextHud) {
    nextHud = now + 100;
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
          : sample && now - sample.timestamp <= 250
            ? `${inferenceMs.toFixed(0)} ms inference · ${Math.round((relativeAngles(sample.rotation, neutral?.rotation ?? sample.rotation).x * 180) / Math.PI)}° yaw`
            : "Waiting for face";
    $("view-angle").textContent =
      `${String(Math.round(viewer.rig.azimuth)).padStart(3, "0")}° ${viewer.rig.mode === "orbit" ? "AZIMUTH" : "LOOK MODE"}`;
    $("stage").dataset.mode = viewer.rig.mode;
    $("stage").dataset.input = inputMode;
    $("stage").dataset.paused = String(paused);
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
void loadModel("/models/DamagedHelmet.glb", "DamagedHelmet");
