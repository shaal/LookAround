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
  type HeadPerspective,
  type ScreenCalibration,
  type ScreenFrame,
  type ScreenViewport,
} from "./screen-window";

export type ViewMode = "orbit" | "look" | "position";

export class CameraRig {
  readonly target = new Vector3(0, 0.1, 0);
  mode: ViewMode = "orbit";
  private minDistance = 1.8;
  private maxDistance = 18;
  private sphere = new Spherical(6.8, Math.PI / 2 - 0.08, 0.3);
  private base = new Quaternion();
  private orbitAim = new Quaternion();
  private screenWindow: ScreenWindow;
  private screenCalibration = { ...DEFAULT_SCREEN_CALIBRATION };
  private perspective: HeadPerspective = "camera";
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
    this.target.set(0, 0.1, 0);
    this.orbitAim.identity();
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
          this.perspective,
        );
    } else {
      this.orbitAim.identity();
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
      this.screenWindow.capture(
        calibration,
        this.viewport,
        this.target,
        this.perspective,
      );
  }

  get headPerspective() {
    return this.perspective;
  }

  setHeadPerspective(perspective: HeadPerspective) {
    this.perspective = perspective;
    if (this.mode === "position") this.screenWindow.setPerspective(perspective);
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
      perspective: this.perspective,
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
    this.camera.quaternion.multiply(this.orbitAim);
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
    if (!dx && !dy) return;
    this.transition = null;
    // Always orbit the shared focus, preserving any off-center tracking aim.
    this.syncOrbit();
    const height = this.viewport.height > 1 ? this.viewport.height : 600;
    this.sphere.theta -= (2 * Math.PI * dx) / height;
    this.sphere.phi = clamp(
      this.sphere.phi - (2 * Math.PI * dy) / height,
      0.12,
      Math.PI - 0.12,
    );
    this.applyOrbit();
    this.anchorNavigation();
  }

  pan(dx: number, dy: number) {
    if (!dx && !dy) return;
    this.transition = null;
    const distance = this.camera.position.distanceTo(this.target);
    const width = this.viewport.width > 1 ? this.viewport.width : 800;
    const height = this.viewport.height > 1 ? this.viewport.height : 600;
    // Read the actual lens, including Head camera's off-axis projection.
    const projection = this.camera.projectionMatrix.elements;
    const shift = new Vector3(1, 0, 0)
      .applyQuaternion(this.camera.quaternion)
      .multiplyScalar((-2 * dx * distance) / (projection[0] * width))
      .addScaledVector(
        new Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion),
        (2 * dy * distance) / (projection[5] * height),
      );
    this.camera.position.add(shift);
    this.target.add(shift);
    this.syncOrbit();
    this.anchorNavigation();
  }

  zoom(amount: number) {
    if (!amount) return;
    this.transition = null;
    const offset = this.camera.position.clone().sub(this.target);
    offset.setLength(
      clamp(
        offset.length() * Math.exp(amount * 0.001),
        this.minDistance,
        this.maxDistance,
      ),
    );
    this.camera.position.copy(this.target).add(offset);
    this.syncOrbit();
    this.anchorNavigation();
  }

  setDistanceLimits(min: number, max: number) {
    this.minDistance = min;
    this.maxDistance = max;
  }

  /**
   * Fly the camera and its focus together. W/S follow the exact view direction,
   * including up or down; A/D strafe along the view's right; Q/E stay vertical.
   */
  move(step: Vector3) {
    if (!step.lengthSq()) return;
    this.transition = null;
    const forward = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const shift = right
      .multiplyScalar(step.x)
      .addScaledVector(this.camera.up, step.y)
      .addScaledVector(forward, step.z);
    this.camera.position.add(shift);
    this.target.add(shift);
    this.syncOrbit();
    this.anchorNavigation();
  }

  private syncOrbit() {
    this.sphere.setFromVector3(this.camera.position.clone().sub(this.target));
    const facing = new Quaternion().setFromRotationMatrix(
      new Matrix4().lookAt(this.camera.position, this.target, this.camera.up),
    );
    this.orbitAim.copy(facing).invert().multiply(this.camera.quaternion);
  }

  private anchorNavigation() {
    this.base.copy(this.camera.quaternion);
    if (this.mode === "position") this.screenWindow.anchorManualView();
  }

  get azimuth() {
    return ((((this.sphere.theta * 180) / Math.PI) % 360) + 360) % 360;
  }
}
