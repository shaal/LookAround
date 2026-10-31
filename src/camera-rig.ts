import {
  Euler,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Spherical,
  Vector3,
} from "three";
import { clamp, type Signal } from "./tracking-math";
import {
  DEFAULT_SCREEN_CALIBRATION,
  ScreenWindow,
  viewportWidthCm,
  type ScreenCalibration,
  type ScreenFrame,
  type ScreenViewport,
} from "./screen-window";

export type ViewMode = "orbit" | "look" | "position";

export class CameraRig {
  readonly target = new Vector3(0, 0.1, 0);
  mode: ViewMode = "orbit";
  private sphere = new Spherical(6.8, Math.PI / 2 - 0.08, 0.3);
  private base = new Quaternion();
  private screenWindow: ScreenWindow;
  private screenCalibration = { ...DEFAULT_SCREEN_CALIBRATION };
  private viewport: ScreenViewport = { width: 1, height: 1, screenWidth: 1 };
  private transition: {
    from: Quaternion;
    to: Quaternion;
    elapsed: number;
  } | null = null;

  constructor(readonly camera: PerspectiveCamera) {
    this.screenWindow = new ScreenWindow(camera);
    this.reset();
  }

  reset() {
    this.mode = "orbit";
    this.camera.updateProjectionMatrix();
    this.transition = null;
    // Narrow canvases need extra distance to fit the model horizontally.
    this.sphere.set(
      Math.min(16, Math.max(6.8, 4.4 / this.camera.aspect)),
      Math.PI / 2 - 0.08,
      0.3,
    );
    this.applyOrbit();
  }

  setMode(mode: ViewMode) {
    if (mode === this.mode) return;
    if (this.mode === "position") this.camera.updateProjectionMatrix();
    this.mode = mode;
    if (mode !== "orbit") {
      this.transition = null;
      this.base.copy(this.camera.quaternion);
      if (mode === "position")
        this.screenWindow.capture(
          this.screenCalibration,
          this.viewport,
          this.target,
        );
    } else {
      this.sphere.setFromVector3(this.camera.position.clone().sub(this.target));
      const to = new Quaternion().setFromRotationMatrix(
        new Matrix4().lookAt(this.camera.position, this.target, this.camera.up),
      );
      this.transition = {
        from: this.camera.quaternion.clone(),
        to,
        elapsed: 0,
      };
    }
  }

  rebase(signal: Signal = { x: 0, y: 0 }) {
    if (this.mode === "look")
      this.base
        .copy(this.camera.quaternion)
        .multiply(this.lookOffset(signal).invert());
    if (this.mode === "position") {
      this.screenWindow.rebase(signal);
    }
  }

  freeze() {
    this.transition = null;
  }

  private lookOffset(signal: Signal) {
    return new Quaternion().setFromEuler(
      new Euler(-signal.y * 0.48, -signal.x * 0.78, 0, "YXZ"),
    );
  }

  configureScreen(calibration: ScreenCalibration) {
    this.screenCalibration = { ...calibration };
    if (this.mode === "position")
      this.screenWindow.capture(calibration, this.viewport, this.target);
  }

  resize(viewport: ScreenViewport) {
    this.viewport = { ...viewport };
    this.camera.aspect = viewport.width / viewport.height;
    if (this.mode === "position") this.screenWindow.resize(viewport);
    else this.camera.updateProjectionMatrix();
  }

  get eyeDistanceCm() {
    return this.screenWindow.eyeDistanceCm;
  }

  get screenFrame(): ScreenFrame {
    if (this.mode === "position") return this.screenWindow.frame;
    // A clearly labelled preview of the setup before entering Head camera.
    const widthCm = viewportWidthCm(this.screenCalibration, this.viewport);
    return {
      origin: this.camera.position.clone(),
      orientation: this.camera.quaternion.clone(),
      unitsPerCm:
        Math.max(this.camera.position.distanceTo(this.target), 0.1) /
        this.screenCalibration.objectDistanceCm,
      widthCm,
      heightCm: (widthCm * this.viewport.height) / this.viewport.width,
      neutralDistanceCm: this.screenCalibration.eyeDistanceCm,
      eye: new Vector3(0, 0, this.screenCalibration.eyeDistanceCm),
    };
  }

  private applyOrbit() {
    this.camera.position.setFromSpherical(this.sphere).add(this.target);
    this.camera.lookAt(this.target);
  }

  update(signal: Signal | null, dt: number) {
    if (this.transition) {
      this.transition.elapsed += Math.min(dt, 0.05);
      const t = clamp(this.transition.elapsed / 0.24, 0, 1);
      const eased = t * t * (3 - 2 * t);
      this.camera.quaternion.slerpQuaternions(
        this.transition.from,
        this.transition.to,
        eased,
      );
      if (t === 1) this.transition = null;
      return;
    }
    if (!signal) return;
    if (this.mode === "orbit") {
      this.sphere.theta += signal.x * 0.96 * Math.min(dt, 0.05);
      this.sphere.phi = clamp(
        this.sphere.phi + signal.y * 0.65 * Math.min(dt, 0.05),
        0.12,
        Math.PI - 0.12,
      );
      this.applyOrbit();
    } else if (this.mode === "look") {
      this.camera.quaternion.copy(this.base).multiply(this.lookOffset(signal));
    } else {
      this.screenWindow.apply(signal);
    }
  }

  drag(dx: number, dy: number) {
    this.transition = null;
    if (this.mode === "orbit") {
      this.sphere.theta -= dx * 0.006;
      this.sphere.phi = clamp(
        this.sphere.phi - dy * 0.006,
        0.12,
        Math.PI - 0.12,
      );
      this.applyOrbit();
    } else {
      this.base
        .copy(this.camera.quaternion)
        .multiply(
          new Quaternion().setFromEuler(
            new Euler(-dy * 0.004, -dx * 0.004, 0, "YXZ"),
          ),
        );
      this.camera.quaternion.copy(this.base);
      if (this.mode === "position") this.screenWindow.anchorManualView();
    }
  }

  zoom(amount: number) {
    if (this.mode === "orbit") {
      this.sphere.radius = clamp(
        this.sphere.radius * Math.exp(amount * 0.001),
        1.8,
        18,
      );
      this.applyOrbit();
    } else {
      // Dolly along the current viewing direction, keeping look mode's fixed
      // position until the user explicitly scrolls again.
      this.camera.position.addScaledVector(
        this.camera.getWorldDirection(new Vector3()),
        -amount * 0.003,
      );
      if (this.camera.position.distanceTo(this.target) > 18)
        this.camera.position.sub(this.target).setLength(18).add(this.target);
      if (this.mode === "position") this.screenWindow.anchorManualView();
    }
  }

  get azimuth() {
    return ((((this.sphere.theta * 180) / Math.PI) % 360) + 360) % 360;
  }
}
