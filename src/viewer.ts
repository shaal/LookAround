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
  PerspectiveCamera,
  PlaneGeometry,
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
import { ObjectRotation } from "./object-rotation";
import type { Signal } from "./tracking-math";
import { boxCorners, spatialGeometry } from "./spatial-geometry";

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
  private request = 0;
  private abort: AbortController | null = null;
  private wireframe = false;
  private grid: GridHelper;
  private loader: GLTFLoader;
  onManual: (active: boolean) => void = () => {};

  constructor(readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D model. Drag to rotate; scroll to zoom.",
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
    let dragging = false,
      lastX = 0,
      lastY = 0;
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      this.onManual(true);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      this.rig.drag(event.clientX - lastX, event.clientY - lastY);
      lastX = event.clientX;
      lastY = event.clientY;
    });
    const release = () => {
      if (dragging) {
        dragging = false;
        this.rig.rebase();
        this.onManual(false);
      }
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("lostpointercapture", release);
    let wheelTimer: ReturnType<typeof setTimeout>;
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.onManual(true);
        this.rig.zoom(event.deltaY);
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => {
          this.rig.rebase();
          this.onManual(false);
        }, 200);
      },
      { passive: false },
    );
  }

  async load(
    source: string | File,
  ): Promise<{ triangles: number; meshes: number; bytes: number } | null> {
    const id = ++this.request;
    this.abort?.abort();
    this.abort = new AbortController();
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
    const base =
      typeof source === "string"
        ? new URL(".", new URL(source, location.href)).href
        : "";
    const gltf = await this.loader.parseAsync(data, base);
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
    if (this.model) {
      this.mixer?.stopAllAction();
      this.mixer?.uncacheRoot(this.model.children[0]);
      this.scene.remove(this.model);
      disposeModel(this.model);
    }
    this.model = wrapper;
    this.modelBounds.copy(box).translate(center.clone().negate());
    this.objectRotation = new ObjectRotation(wrapper.quaternion);
    this.scene.add(wrapper);
    this.mixer = gltf.animations.length ? new AnimationMixer(root) : null;
    for (const clip of gltf.animations) this.mixer?.clipAction(clip).play();
    this.rig.reset();
    return { triangles: Math.round(triangles), meshes, bytes: data.byteLength };
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
  setGrid(value: boolean) {
    this.grid.visible = value;
  }
  rebase(signal: Signal = { x: 0, y: 0 }, eyeSignal: Signal | null = null) {
    this.rig.rebase(signal);
    this.objectRotation?.rebase(eyeSignal);
  }
  resetView() {
    this.rig.reset();
    this.objectRotation?.reset();
  }
  get spatialGeometry() {
    if (!this.model) return null;
    this.model.updateWorldMatrix(true, false);
    return spatialGeometry(
      this.rig.screenFrame,
      boxCorners(this.modelBounds.min, this.modelBounds.max).map((point) =>
        point.applyMatrix4(this.model!.matrixWorld),
      ),
    );
  }
  render(signal: Signal | null, dt: number, eyeSignal: Signal | null = null) {
    this.rig.update(signal, dt);
    if (this.rig.mode === "position" && signal)
      this.objectRotation?.update(eyeSignal);
    this.mixer?.update(Math.min(dt, 0.05));
    this.renderer.render(this.scene, this.camera);
  }
}
