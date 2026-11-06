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
  mesh: SplatMeshType;
  placement: Group;
  localBounds: Box3;
  view: SplatView | null;
  rigPosition: Vector3;
  rigQuaternion: Quaternion;
  lifeSize: number;
  sample: SceneSample;
};

/** A random subset of splats, enough to sketch the scene in the overview. */
function sampleSplats(mesh: SplatMeshType, max = 150000): SceneSample {
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
  private worldScale = 1;
  private moveInput = new Vector3();
  onProgress: (text: string) => void = () => {};
  onManual: (active: boolean) => void = () => {};

  constructor(readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
      this.splat.mesh.dispose();
      this.splat = null;
    } else disposeModel(this.model);
    this.model = null;
  }

  /** Environments replace the studio floor and need a much deeper frustum. */
  private setEnvironment(on: boolean) {
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
      if (source instanceof File) bytes = new Uint8Array(await source.arrayBuffer());
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
    if (!this.scene.children.some((c) => c instanceof this.spark!.SparkRenderer))
      this.scene.add(new this.spark.SparkRenderer({ renderer: this.renderer }));
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
    };
    this.applySplatPlacement();
    this.model = rotator;
    this.objectRotation = new ObjectRotation(rotator.quaternion);
    this.objectRotation.setMode(this.gazeRotationMode);
    this.scene.add(rotator);
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
    this.renderer.render(this.scene, this.camera);
  }
}
