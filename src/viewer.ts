import {
  AmbientLight,
  AnimationMixer,
  Box3,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
  ACESFilmicToneMapping,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CameraRig } from "./camera-rig";
import { ObjectRotation, type GazeRotationMode } from "./object-rotation";
import type { Signal } from "./tracking-math";
import {
  boxCorners,
  environmentView,
  spatialGeometry,
  type SceneSample,
} from "./spatial-geometry";
import { NavigationControls } from "./navigation-controls";
import {
  SPLAT_UP_FIX,
  fetchSuperSplat,
  gatherSplats,
  importantSplats,
  splatFormat,
  superSplatBase,
  viewPlacement,
  type SplatPayload,
  type SplatView,
} from "./splat-source";

type Spark = typeof import("@sparkjsdev/spark");
type SplatMeshType = InstanceType<Spark["SplatMesh"]>;

export type LoadInfo = {
  kind: "glb" | "splat";
  triangles: number;
  meshes: number;
  splats: number;
  bytes: number;
};

type SplatState = {
  /** The mesh being drawn: the full scene, or a lighter subset of it. */
  mesh: SplatMeshType;
  full: SplatMeshType;
  placement: Group;
  localBounds: Box3;
  view: SplatView | null;
  rigPosition: Vector3;
  rigQuaternion: Quaternion;
  lifeSize: number;
  sample: SceneSample;
};

/** A random subset of splats, enough to sketch the scene in the overview. */
function sampleSplats(mesh: SplatMeshType, max = 40000): SceneSample {
  const packed = mesh.packedSplats;
  const total = packed?.numSplats ?? 0;
  const positions = new Float32Array(max * 3);
  const colors = new Uint8Array(max * 3);
  let count = 0;
  if (!packed || !total) return { positions, colors, count };
  const tries = Math.min(total, max * 2);
  for (let n = 0; n < tries && count < max; n++) {
    const index = total <= max * 2 ? n : Math.floor(Math.random() * total);
    const { center, opacity, color } = packed.getSplat(index);
    if (opacity < 0.35) continue;
    positions.set([center.x, center.y, center.z], count * 3);
    colors.set(
      [
        Math.min(255, color.r * 255),
        Math.min(255, color.g * 255),
        Math.min(255, color.b * 255),
      ],
      count * 3,
    );
    count++;
  }
  return { positions, colors, count };
}

/** The fewest splats a slow machine drops to; below this scenes fall apart. */
const MIN_SPLATS = 800_000;
const BUDGET_KEY = "lookaround.splatBudget";
function storedSplatBudget() {
  try {
    return Number(localStorage.getItem(BUDGET_KEY)) || 0;
  } catch {
    return 0;
  }
}
function storeSplatBudget(budget: number) {
  try {
    localStorage.setItem(BUDGET_KEY, String(budget));
  } catch {
    /* Private mode: adapt again next visit. */
  }
}

function disposeModel(root: Group) {
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      for (const value of Object.values(material))
        if (value instanceof Texture) textures.add(value);
      material.dispose();
    }
  });
  for (const texture of textures) {
    const data = texture.source.data;
    if (typeof ImageBitmap !== "undefined" && data instanceof ImageBitmap)
      data.close();
    texture.dispose();
  }
}

export class Viewer {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.01, 150);
  readonly rig = new CameraRig(this.camera);
  readonly renderer: WebGLRenderer;
  private model: Group | null = null;
  private modelBounds = new Box3();
  private mixer: AnimationMixer | null = null;
  private objectRotation: ObjectRotation | null = null;
  private gazeRotationMode: GazeRotationMode = "follow";
  private request = 0;
  private abort: AbortController | null = null;
  private wireframe = false;
  private grid: GridHelper;
  private loader: GLTFLoader;
  private floor: Mesh;
  private spark: Spark | null = null;
  private splat: SplatState | null = null;
  private sparkRenderer: InstanceType<Spark["SparkRenderer"]> | null = null;
  private sparkSync = {
    busy: false,
    time: 0,
    position: new Vector3(Infinity, 0, 0),
    quaternion: new Quaternion(),
    world: new Matrix4(),
  };
  private worldScale = 1;
  private moveInput = new Vector3();
  /** Render resolution, adapted for splat scenes; see adaptResolution(). */
  private resolution = {
    ratio: 1,
    max: 1,
    frameMs: 16,
    checked: 0,
    slowChecks: 0,
  };
  /** Splat sort counters for the ?perf overlay. */
  private sortStats = { count: 0, ms: 0 };
  onProgress: (text: string) => void = () => {};
  onManual: (active: boolean) => void = () => {};

  constructor(readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.resolution.ratio = this.resolution.max = Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.resolution.ratio);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D model. Left drag orbits; right drag or Shift + left drag pans; scroll or middle drag zooms. R resets the view. Same controls in every tracking mode.",
    );
    this.renderer.domElement.tabIndex = 0;
    this.container.appendChild(this.renderer.domElement);
    const pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.add(
      new HemisphereLight(0xe6edff, 0x222128, 2),
      new AmbientLight(0xffffff, 0.4),
    );
    const key = new DirectionalLight(0xffe9d0, 3.5);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const fill = new DirectionalLight(0xa2b8ff, 2);
    fill.position.set(-4, 1, -2);
    this.scene.add(fill);
    this.grid = new GridHelper(30, 60, 0x46444a, 0x27282d);
    this.grid.position.y = -1.55;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.36;
    this.scene.add(this.grid);
    const floor = new Mesh(
      new PlaneGeometry(200, 200),
      new MeshBasicMaterial({
        color: 0x17181b,
        transparent: true,
        opacity: 0.62,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.57;
    this.scene.add(floor);
    this.floor = floor;
    const draco = new DRACOLoader().setDecoderPath("/decoders/draco/");
    const ktx = new KTX2Loader()
      .setTranscoderPath("/decoders/basis/")
      .detectSupport(this.renderer);
    this.loader = new GLTFLoader()
      .setDRACOLoader(draco)
      .setKTX2Loader(ktx)
      .setMeshoptDecoder(MeshoptDecoder);
    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      this.renderer.setSize(width, height);
      this.rig.resize({
        width,
        height,
        screenWidth: window.screen.width || window.innerWidth,
        pixelRatio: devicePixelRatio,
      });
    };
    new ResizeObserver(resize).observe(container);
    window.addEventListener("resize", resize);
    resize();
    new NavigationControls(this.renderer.domElement, this.rig, (active) =>
      this.onManual(active),
    );
  }

  async load(source: string | File): Promise<LoadInfo | null> {
    const id = ++this.request;
    this.abort?.abort();
    this.abort = new AbortController();
    const name = source instanceof File ? source.name : source;
    const base = typeof source === "string" ? superSplatBase(source) : null;
    if (base || splatFormat(name)) return this.loadSplat(source, base, id);
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(60000),
    ]);
    let data: ArrayBuffer;
    if (source instanceof File) data = await source.arrayBuffer();
    else {
      const response = await fetch(source, { signal });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}. Check the model URL.`);
      data = await response.arrayBuffer();
    }
    if (id !== this.request) return null;
    if (data.byteLength > 150 * 1024 * 1024)
      throw new Error("Please use a model smaller than 150 MB.");
    if (
      data.byteLength < 12 ||
      new DataView(data).getUint32(0, true) !== 0x46546c67
    )
      throw new Error(
        "This is not a binary GLB file. Use a direct .glb download URL.",
      );
    const gltfBase =
      typeof source === "string"
        ? new URL(".", new URL(source, location.href)).href
        : "";
    const gltf = await this.loader.parseAsync(data, gltfBase);
    if (id !== this.request) {
      disposeModel(gltf.scene);
      return null;
    }
    const root = gltf.scene;
    const box = new Box3().setFromObject(root),
      center = box.getCenter(new Vector3()),
      size = box.getSize(new Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(extent) || extent < 1e-7) {
      disposeModel(root);
      throw new Error("The GLB has no visible geometry.");
    }
    const wrapper = new Group();
    wrapper.add(root);
    root.position.sub(center);
    wrapper.scale.setScalar(2.7 / extent);
    let meshes = 0,
      triangles = 0;
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      meshes++;
      triangles +=
        (object.geometry.index?.count ??
          object.geometry.attributes.position?.count ??
          0) / 3;
      for (const material of Array.isArray(object.material)
        ? object.material
        : [object.material])
        if ("wireframe" in material) material.wireframe = this.wireframe;
    });
    this.clearModel();
    this.setEnvironment(false);
    this.model = wrapper;
    this.modelBounds.copy(box).translate(center.clone().negate());
    this.objectRotation = new ObjectRotation(wrapper.quaternion);
    this.objectRotation.setMode(this.gazeRotationMode);
    this.scene.add(wrapper);
    this.mixer = gltf.animations.length ? new AnimationMixer(root) : null;
    for (const clip of gltf.animations) this.mixer?.clipAction(clip).play();
    this.rig.reset();
    return {
      kind: "glb",
      triangles: Math.round(triangles),
      meshes,
      splats: 0,
      bytes: data.byteLength,
    };
  }

  private clearModel() {
    if (!this.model) return;
    this.mixer?.stopAllAction();
    if (this.model.children[0]) this.mixer?.uncacheRoot(this.model.children[0]);
    this.mixer = null;
    this.scene.remove(this.model);
    if (this.splat) {
      if (this.splat.mesh !== this.splat.full) this.splat.mesh.dispose();
      this.splat.full.dispose();
      this.splat = null;
      // Spark keeps its last splat buffer until the next update.
      this.sparkRenderer?.clearSplats();
      this.sparkSync.position.set(Infinity, 0, 0);
    } else disposeModel(this.model);
    this.model = null;
  }

  /** Environments replace the studio floor and need a much deeper frustum. */
  private setEnvironment(on: boolean) {
    // Splats cost per pixel. A Retina screen at 2x draws four times the
    // pixels, which stalls laptop GPUs; start at 1x and adapt from there.
    const r = this.resolution;
    r.max = on ? Math.min(devicePixelRatio, 1) : Math.min(devicePixelRatio, 2);
    r.ratio = r.max;
    r.frameMs = 16;
    r.checked = performance.now();
    this.renderer.setPixelRatio(r.ratio);
    this.floor.visible = !on;
    this.grid.visible = !on && this.gridEnabled;
    this.camera.far = on ? 5000 : 150;
    this.camera.updateProjectionMatrix();
    this.rig.setDistanceLimits(on ? 0.3 : 1.8, on ? 200 : 18);
  }

  private async loadSplat(
    source: string | File,
    base: string | null,
    id: number,
  ): Promise<LoadInfo | null> {
    const signal = AbortSignal.any([
      this.abort!.signal,
      AbortSignal.timeout(240000),
    ]);
    const progress = (loaded: number, total: number) =>
      this.onProgress(
        total
          ? `Downloading splats… ${Math.round((loaded / total) * 100)}%`
          : `Downloading splats… ${(loaded / 1048576).toFixed(0)} MB`,
      );
    let payload: SplatPayload;
    if (base) payload = await fetchSuperSplat(base, signal, progress);
    else {
      const name = source instanceof File ? source.name : source;
      const format = splatFormat(name)!;
      let bytes: Uint8Array;
      if (source instanceof File)
        bytes = new Uint8Array(await source.arrayBuffer());
      else {
        const response = await fetch(source, { signal });
        if (!response.ok)
          throw new Error(`HTTP ${response.status}. Check the splat URL.`);
        const total = Number(response.headers.get("content-length")) || 0;
        const reader = response.body!.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          progress(loaded, total);
        }
        bytes = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
      }
      payload = { bytes, format, view: null };
    }
    if (id !== this.request) return null;
    if (payload.bytes.byteLength > 600 * 1024 * 1024)
      throw new Error("Please use a splat scene smaller than 600 MB.");
    this.onProgress("Decoding splats…");
    this.spark ??= await import("@sparkjsdev/spark");
    if (!this.sparkRenderer) {
      // Spark rebuilds and re-sorts every splat whenever the camera moves
      // 0.001 units, which head tracking does on every frame. Drive its
      // updates from render() instead, only after a noticeable move.
      this.sparkRenderer = new this.spark.SparkRenderer({
        renderer: this.renderer,
        autoUpdate: false,
      });
      this.scene.add(this.sparkRenderer);
    }
    const mesh = new this.spark.SplatMesh({
      fileBytes: payload.bytes,
      fileType: payload.format as never,
    });
    await mesh.initialized;
    if (id !== this.request) {
      mesh.dispose();
      return null;
    }
    mesh.quaternion.copy(SPLAT_UP_FIX);
    const rawBounds = mesh.getBoundingBox(true);
    if (rawBounds.isEmpty()) {
      mesh.dispose();
      throw new Error("The splat file has no points.");
    }
    this.clearModel();
    this.setEnvironment(true);
    this.rig.reset();
    const placement = new Group();
    placement.add(mesh);
    const rotator = new Group();
    rotator.add(placement);
    mesh.updateMatrix();
    this.splat = {
      mesh,
      placement,
      localBounds: rawBounds.clone().applyMatrix4(mesh.matrix),
      // SuperSplat stores the start camera in viewer space (data already flipped).
      view: payload.view,
      rigPosition: this.camera.position.clone(),
      rigQuaternion: this.camera.quaternion.clone(),
      lifeSize: this.rig.screenFrame.unitsPerCm * 100,
      sample: sampleSplats(mesh),
      full: mesh,
    };
    this.applySplatPlacement();
    this.model = rotator;
    this.objectRotation = new ObjectRotation(rotator.quaternion);
    this.objectRotation.setMode(this.gazeRotationMode);
    this.scene.add(rotator);
    // A machine that struggled before starts at the budget it settled on.
    const budget = storedSplatBudget();
    if (budget && budget < (mesh.packedSplats?.numSplats ?? 0))
      await this.setSplatBudget(budget);
    return {
      kind: "splat",
      triangles: 0,
      meshes: 0,
      splats: mesh.packedSplats?.numSplats ?? 0,
      bytes: payload.bytes.byteLength,
    };
  }

  /** Re-place the environment so the start camera stays put while scale changes. */
  private applySplatPlacement() {
    const splat = this.splat;
    if (!splat) return;
    const matrix = new Matrix4();
    if (splat.view) {
      // Scene units are usually metres; start at life size for head parallax.
      const view = splat.view;
      matrix.copy(
        viewPlacement(
          view,
          splat.rigPosition,
          splat.rigQuaternion,
          splat.lifeSize * this.worldScale,
        ),
      );
    } else {
      // No published camera: frame the capture like an object, but larger.
      const size = splat.localBounds.getSize(new Vector3());
      const center = splat.localBounds.getCenter(new Vector3());
      const scale = (9 / Math.max(size.x, size.y, size.z)) * this.worldScale;
      matrix
        .makeScale(scale, scale, scale)
        .multiply(new Matrix4().makeTranslation(center.negate()));
    }
    matrix.decompose(
      splat.placement.position,
      splat.placement.quaternion,
      splat.placement.scale,
    );
    this.modelBounds.copy(splat.localBounds).applyMatrix4(matrix);
  }

  /** Numbers for the ?perf overlay; resets the sort counters. */
  takePerf() {
    const { count, ms } = this.sortStats;
    this.sortStats = { count: 0, ms: 0 };
    const canvas = this.renderer.domElement;
    return {
      ratio: this.resolution.ratio,
      width: canvas.width,
      height: canvas.height,
      splats: this.splat?.mesh.packedSplats?.numSplats ?? 0,
      sorts: count,
      sortMs: count ? ms / count : 0,
      gpu: this.gpuName,
    };
  }
  private get gpuName() {
    const gl = this.renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown",
    );
  }

  get isEnvironment() {
    return this.splat !== null;
  }

  setWorldScale(value: number) {
    this.worldScale = value;
    this.applySplatPlacement();
  }

  /** Keyboard walking: x = strafe, y = rise, z = forward, each in -1…1. */
  setMoveInput(x: number, y: number, z: number) {
    this.moveInput.set(x, y, z);
  }

  setWireframe(value: boolean) {
    this.wireframe = value;
    this.model?.traverse((object) => {
      if (object instanceof Mesh)
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material])
          if ("wireframe" in material) material.wireframe = value;
    });
  }
  private gridEnabled = true;
  setGrid(value: boolean) {
    this.gridEnabled = value;
    this.grid.visible = value && !this.splat;
  }
  rebase(signal: Signal = { x: 0, y: 0 }, eyeSignal: Signal | null = null) {
    this.rig.rebase(signal);
    this.objectRotation?.rebase(eyeSignal);
  }
  setGazeRotationMode(mode: GazeRotationMode, eyeSignal: Signal | null = null) {
    this.gazeRotationMode = mode;
    this.objectRotation?.setMode(mode, eyeSignal);
  }
  resetView() {
    this.rig.reset();
    this.objectRotation?.reset();
  }
  get spatialGeometry() {
    if (!this.model) return null;
    if (this.splat) {
      // The bounding box of a whole environment says nothing; sketch the
      // slice of the scene behind the screen instead, around the focus point.
      const frame = this.rig.screenFrame;
      this.splat.mesh.updateWorldMatrix(true, false);
      const focus = this.rig.target;
      const geometry = spatialGeometry(frame, [focus.clone(), focus.clone()]);
      geometry.scene = environmentView(
        frame,
        this.splat.mesh.matrixWorld,
        this.splat.sample,
      );
      return geometry;
    }
    this.model.updateWorldMatrix(true, false);
    return spatialGeometry(
      this.rig.screenFrame,
      boxCorners(this.modelBounds.min, this.modelBounds.max).map((point) =>
        point.applyMatrix4(this.model!.matrixWorld),
      ),
    );
  }
  render(signal: Signal | null, dt: number, eyeSignal: Signal | null = null) {
    if (this.moveInput.lengthSq()) {
      // About 1.4 m/s in a life-size scene; GLB scenes move in rig units.
      const speed = this.splat
        ? this.splat.lifeSize * this.worldScale * 1.4
        : 2.5;
      this.rig.move(
        this.moveInput.clone().multiplyScalar(speed * Math.min(dt, 0.05)),
      );
    }
    this.rig.update(signal, dt);
    if (this.rig.mode === "position" && signal)
      this.objectRotation?.update(eyeSignal, dt);
    this.mixer?.update(Math.min(dt, 0.05));
    this.adaptResolution(dt);
    this.updateSplats();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Lowers the splat render resolution while frames run slow (down to 0.7x),
   * and raises it again once there is headroom. Checked once a second.
   */
  private adaptResolution(dt: number) {
    if (!this.splat) return;
    const r = this.resolution;
    r.frameMs += (Math.min(dt * 1000, 200) - r.frameMs) * 0.1;
    const now = performance.now();
    if (now - r.checked < 1000) return;
    r.checked = now;
    const next =
      r.frameMs > 30
        ? Math.max(0.7, r.ratio * 0.85)
        : r.frameMs < 19
          ? Math.min(r.max, r.ratio * 1.15)
          : r.ratio;
    // Still slow at the lowest resolution: the splat count is the limit.
    r.slowChecks = next === r.ratio && r.frameMs > 30 ? r.slowChecks + 1 : 0;
    const shown = this.splat.mesh.packedSplats?.numSplats ?? 0;
    if (r.slowChecks >= 2 && shown > MIN_SPLATS * 1.2) {
      r.slowChecks = 0;
      const budget = Math.max(MIN_SPLATS, Math.round(shown * 0.5));
      storeSplatBudget(budget);
      void this.setSplatBudget(budget);
      return;
    }
    if (Math.abs(next - r.ratio) < 0.01) return;
    r.ratio = next;
    this.renderer.setPixelRatio(next);
  }

  /**
   * Draws only the `budget` most visible splats (or the full scene). The full
   * mesh stays loaded but hidden, so budgets can change without re-downloading.
   */
  private async setSplatBudget(budget: number) {
    const splat = this.splat;
    const packed = splat?.full.packedSplats;
    if (!splat || !this.spark || !packed?.packedArray) return;
    const total = packed.numSplats;
    let next = splat.full;
    if (budget < total) {
      const encoding = packed.splatEncoding;
      const indices = importantSplats(
        packed.packedArray,
        total,
        budget,
        (encoding?.lnScaleMax ?? 9) - (encoding?.lnScaleMin ?? -12),
      );
      // Keep view-dependent colour (spherical harmonics) for the kept splats.
      const extra: Record<string, Uint32Array> = {};
      for (const [key, words] of [
        ["sh1", 2],
        ["sh2", 4],
        ["sh3", 4],
      ] as const) {
        const source = packed.extra[key];
        if (source instanceof Uint32Array)
          extra[key] = gatherSplats(source, words, indices);
      }
      next = new this.spark.SplatMesh({
        packedSplats: new this.spark.PackedSplats({
          packedArray: gatherSplats(packed.packedArray, 4, indices),
          numSplats: indices.length,
          splatEncoding: encoding,
          extra,
        }),
      });
      await next.initialized;
      if (this.splat !== splat) {
        next.dispose();
        return;
      }
      next.quaternion.copy(SPLAT_UP_FIX);
      splat.placement.add(next);
    }
    if (splat.mesh !== splat.full) {
      splat.placement.remove(splat.mesh);
      splat.mesh.dispose();
    }
    splat.full.visible = next === splat.full;
    splat.mesh = next;
    this.sparkSync.position.set(Infinity, 0, 0);
    this.resolution.frameMs = 30;
  }

  /**
   * Re-sorts the splats only after the head moves about 2 cm or turns about
   * 2°, at most five times a second, and catches up on smaller drifts.
   * Between updates Spark still draws every frame from the current camera.
   */
  private updateSplats() {
    const spark = this.sparkRenderer;
    const sync = this.sparkSync;
    if (!spark || !this.splat || sync.busy) return;
    this.splat.mesh.updateWorldMatrix(true, false);
    const world = this.splat.mesh.matrixWorld;
    const moved = this.camera.position.distanceTo(sync.position);
    const turned = this.camera.quaternion.angleTo(sync.quaternion);
    const reshaped = !world.equals(sync.world);
    const now = performance.now();
    const step = this.rig.screenFrame.unitsPerCm;
    const since = now - sync.time;
    // Each sort reads back and re-uploads every splat (tens of MB for big
    // scenes), so cap it at ~5 a second even while the head keeps moving.
    const due =
      reshaped ||
      (since > 200 && (moved > step * 2 || turned > 0.035)) ||
      (since > 500 && (moved > step * 0.05 || turned > 0.001));
    if (!due) return;
    sync.busy = true;
    sync.time = now;
    const started = now;
    sync.position.copy(this.camera.position);
    sync.quaternion.copy(this.camera.quaternion);
    sync.world.copy(world);
    spark
      .update({ scene: this.scene, camera: this.camera })
      .catch(() => {})
      .finally(() => {
        sync.busy = false;
        this.sortStats.count++;
        this.sortStats.ms += performance.now() - started;
      });
  }
}
