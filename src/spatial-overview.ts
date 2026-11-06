import { OrthographicCamera, Vector3 } from "three";
import {
  BOX_FACES,
  boxCorners,
  compressDepth,
  type SpatialGeometry,
} from "./spatial-geometry";

export type OverviewState =
  | "Preview"
  | "Ready"
  | "Live"
  | "Simulated"
  | "Paused"
  | "Held"
  | "Centering"
  | "Mouse";

const WIDTH = 240;
const HEIGHT = 174;
const p = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** A small, orthographic 3D diagram, drawn as SVG without a second WebGL context. */
export class SpatialOverview {
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
  private plot: SVGSVGElement;
  private state: HTMLElement;
  private toScreen: HTMLElement;
  private toObject: HTMLElement;
  private depth: HTMLElement;
  private scale: HTMLElement;
  private modeButton: HTMLButtonElement;
  private legend: HTMLElement;
  private objectDistanceLabel: HTMLElement;

  constructor(private container: HTMLElement) {
    this.plot = container.querySelector("svg")!;
    this.state = container.querySelector("[data-overview-state]")!;
    this.toScreen = container.querySelector("[data-to-screen]")!;
    this.toObject = container.querySelector("[data-to-object]")!;
    this.depth = container.querySelector("[data-object-depth]")!;
    this.scale = container.querySelector("[data-depth-scale]")!;
    this.modeButton = container.querySelector("button")!;
    this.legend = container.querySelector(".overview-legend")!;
    this.objectDistanceLabel = container.querySelector(
      "[data-object-distance-label]",
    )!;
  }

  update(geometry: SpatialGeometry | null, state: OverviewState) {
    this.state.textContent = geometry ? state : "Loading";
    this.container.dataset.state = state.toLowerCase();
    this.modeButton.hidden = state !== "Preview";
    if (!geometry) return;
    if (geometry.scene) {
      this.updateEnvironment(geometry);
      return;
    }
    this.scale.parentElement!.hidden = false;
    const { frame, center, eyeToObjectCm, depthScale } = geometry;
    this.toScreen.textContent = `${frame.eye.z.toFixed(0)} cm`;
    this.toObject.textContent = `${eyeToObjectCm.toFixed(0)} cm`;
    this.legend.textContent =
      frame.perspective === "camera"
        ? "Gold = rendered camera image"
        : "Box = object · gold = image on screen";
    this.objectDistanceLabel.textContent =
      frame.perspective === "camera" ? "Camera → object" : "You → object";
    this.depth.textContent =
      frame.perspective === "camera"
        ? "Virtual camera view"
        : Math.abs(center.z) < 0.5
          ? "Object at the screen"
          : `${Math.abs(center.z).toFixed(0)} cm ${center.z < 0 ? "behind" : "in front of"} screen`;
    this.scale.textContent =
      depthScale === null ? "—" : `~${Math.round(depthScale * 100)}%`;
    this.draw(geometry);
  }

  private draw({ frame, object, image, center }: SpatialGeometry) {
    const { widthCm: width, heightCm: height, eye } = frame;
    const screen = [
      p(-width / 2, -height / 2, 0),
      p(width / 2, -height / 2, 0),
      p(width / 2, height / 2, 0),
      p(-width / 2, height / 2, 0),
    ];
    const bottom = -height / 2;
    const stand = [p(0, bottom, 0), p(0, bottom - 6, 0)];
    const foot = [
      p(-width * 0.22, bottom - 6, 0),
      p(width * 0.22, bottom - 6, 0),
    ];
    const head = eye.clone().add(p(0, 0, 3));
    const shoulders = head.clone().add(p(0, -11, 0));

    this.camera.position.set(150, 95, 155);
    this.camera.lookAt(p(0, 0, 0));
    this.camera.updateMatrixWorld();
    // Leave room around neutral for head motion. Keep the diagram's scale fixed
    // during normal movement, so an approaching head visibly approaches the screen.
    const radius = Math.max(...object.map((v) => v.distanceTo(center)));
    const bounds = [
      ...screen,
      ...foot,
      ...boxCorners(
        center.clone().addScalar(-radius),
        center.clone().addScalar(radius),
      ),
      ...boxCorners(
        p(-18, -20, Math.max(5, frame.neutralDistanceCm - 20)),
        p(18, 10, Math.max(frame.neutralDistanceCm + 20, eye.z + 7)),
      ),
      eye.clone().add(p(-8, -17, 5)),
      eye.clone().add(p(8, 7, 5)),
    ].map((v) => v.clone().applyMatrix4(this.camera.matrixWorldInverse));
    const minX = Math.min(...bounds.map((v) => v.x));
    const maxX = Math.max(...bounds.map((v) => v.x));
    const minY = Math.min(...bounds.map((v) => v.y));
    const maxY = Math.max(...bounds.map((v) => v.y));
    const unitsPerPixel = Math.max(
      (maxX - minX) / (WIDTH - 32),
      (maxY - minY) / (HEIGHT - 36),
    );
    const halfWidth = (unitsPerPixel * WIDTH) / 2;
    const halfHeight = (unitsPerPixel * HEIGHT) / 2;
    this.camera.left = (minX + maxX) / 2 - halfWidth;
    this.camera.right = (minX + maxX) / 2 + halfWidth;
    this.camera.bottom = (minY + maxY) / 2 - halfHeight;
    this.camera.top = (minY + maxY) / 2 + halfHeight;
    this.camera.updateProjectionMatrix();

    const project = (v: Vector3) => {
      const ndc = v.clone().project(this.camera);
      return { x: ((ndc.x + 1) * WIDTH) / 2, y: ((1 - ndc.y) * HEIGHT) / 2 };
    };
    const points = (vertices: Vector3[]) =>
      vertices
        .map((v) => {
          const q = project(v);
          return `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
        })
        .join(" ");
    const line = (
      vertices: Vector3[],
      color: string,
      extra = "",
      lineWidth = 1,
    ) =>
      `<polyline points="${points(vertices)}" fill="none" stroke="${color}" stroke-width="${lineWidth}" ${extra}/>`;
    const cube = () => {
      const faces = BOX_FACES.map((indices) => ({
        vertices: indices.map((i) => object[i]),
        depth:
          indices.reduce(
            (sum, i) =>
              sum +
              object[i].clone().applyMatrix4(this.camera.matrixWorldInverse).z,
            0,
          ) / 4,
      })).sort((a, b) => a.depth - b.depth);
      return faces
        .map(
          ({ vertices }, i) =>
            `<polygon points="${points(vertices)}" fill="#e9bb82" fill-opacity="${0.04 + i * 0.015}" stroke="#e9bb82" stroke-opacity=".55" stroke-width=".8"/>`,
        )
        .join("");
    };
    const label = (
      text: string,
      position: Vector3,
      dx: number,
      dy: number,
      color: string,
    ) => {
      const q = project(position);
      const x = Math.max(22, Math.min(WIDTH - 24, q.x + dx));
      const y = Math.max(12, Math.min(HEIGHT - 7, q.y + dy));
      return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" fill="${color}" class="overview-label">${text}</text>`;
    };
    const eyePoint = project(eye);
    const headPoint = project(head);
    const bodyPoint = project(shoulders);
    const headRadius = 4.5 / unitsPerPixel;
    const rays =
      frame.perspective === "window"
        ? [object[0], object[3], object[5], object[6]]
            .map((corner) =>
              line(
                [eye, corner],
                "#a5b5c0",
                'stroke-opacity=".25" stroke-dasharray="2.5 3"',
              ),
            )
            .join("")
        : "";
    const screenImage = image
      ? `<g clip-path="url(#overview-screen-clip)">${BOX_FACES.map(
          (face) =>
            `<polygon points="${points(face.map((i) => image[i]))}" fill="#edc18b" fill-opacity=".12" stroke="#f3c78f" stroke-width=".8"/>`,
        ).join("")}</g>`
      : "";
    this.plot.innerHTML = `
      <title>Your head, the viewing area, and the model in 3D</title>
      <desc>The wireframe box is the virtual model. Gold on the cyan screen shows the rendered image. ${frame.perspective === "window" ? "Dashed lines show physical viewing rays." : "Camera perspective: head motion moves the virtual camera with a fixed lens."} Distances are estimates.</desc>
      <defs><clipPath id="overview-screen-clip"><polygon points="${points(screen)}"/></clipPath></defs>
      ${rays}
      ${center.z <= 0 ? cube() : ""}
      ${line(stand, "#527c82", "", 3)}
      ${line(foot, "#527c82", 'stroke-linecap="round"', 3)}
      <polygon points="${points(screen)}" fill="#4eafb6" fill-opacity=".08" stroke="#72bfc5" stroke-width="1.5"/>
      ${screenImage}
      ${center.z > 0 ? cube() : ""}
      <ellipse cx="${bodyPoint.x}" cy="${bodyPoint.y}" rx="${headRadius * 1.9}" ry="${headRadius * 0.85}" fill="#525966" stroke="#a3aab5" stroke-width=".8"/>
      <circle cx="${headPoint.x}" cy="${headPoint.y}" r="${headRadius}" fill="#d3d7df" stroke="#f3f5f8" stroke-width=".8"/>
      <circle cx="${eyePoint.x}" cy="${eyePoint.y}" r="1.6" fill="#202329"/>
      ${label("You", head, 0, -headRadius - 6, "#e3e6ec")}
      ${label("Screen", screen[1], 8, 15, "#80c6cc")}
      ${label("Object", center, -20, -radius / unitsPerPixel - 3, "#e9bb82")}
    `;
  }

  private updateEnvironment(geometry: SpatialGeometry) {
    const { frame } = geometry;
    const scene = geometry.scene!;
    this.toScreen.textContent = `${frame.eye.z.toFixed(0)} cm`;
    this.objectDistanceLabel.textContent = "You → nearest surface";
    this.toObject.textContent =
      scene.nearestCm === null ? "—" : `${scene.nearestCm.toFixed(0)} cm`;
    this.legend.textContent = "Dots = the scene you see through the screen";
    this.depth.textContent = "Rings: metres behind the screen (log scale)";
    this.scale.parentElement!.hidden = true;
    this.drawEnvironment(geometry);
  }

  /**
   * The viewing wedge behind the screen, filled with real splat samples. Depth
   * is drawn on a log scale with labelled rings; each dot keeps the place where
   * you see it through the screen.
   */
  private drawEnvironment({ frame, scene }: SpatialGeometry) {
    const { widthCm: width, heightCm: height, eye } = frame;
    const maxDepth = scene!.depthCm;
    const shown = frame.neutralDistanceCm * 2.6;
    const neutral = p(0, 0, frame.neutralDistanceCm);
    const at = (sx: number, sy: number, depthCm: number) => {
      const d = compressDepth(depthCm, maxDepth, shown);
      // Same rule as a real frustum: lateral spread grows with display depth.
      const k = (neutral.z + d) / neutral.z;
      return p(sx * k, sy * k, -d);
    };
    const rect = (depthCm: number) => [
      at(-width / 2, -height / 2, depthCm),
      at(width / 2, -height / 2, depthCm),
      at(width / 2, height / 2, depthCm),
      at(-width / 2, height / 2, depthCm),
    ];
    const screen = rect(0);
    const far = rect(maxDepth);
    const head = eye.clone().add(p(0, 0, 3));
    const shoulders = head.clone().add(p(0, -11, 0));

    this.camera.position.set(170, 80, 120);
    this.camera.lookAt(p(0, 0, -shown / 2));
    this.camera.updateMatrixWorld();
    const bounds = [
      ...screen,
      ...far,
      neutral.clone().add(p(-10, -18, 12)),
      neutral.clone().add(p(10, 10, 12)),
    ].map((v) => v.clone().applyMatrix4(this.camera.matrixWorldInverse));
    const minX = Math.min(...bounds.map((v) => v.x));
    const maxX = Math.max(...bounds.map((v) => v.x));
    const minY = Math.min(...bounds.map((v) => v.y));
    const maxY = Math.max(...bounds.map((v) => v.y));
    const unitsPerPixel = Math.max(
      (maxX - minX) / (WIDTH - 16),
      (maxY - minY) / (HEIGHT - 20),
    );
    this.camera.left = (minX + maxX) / 2 - (unitsPerPixel * WIDTH) / 2;
    this.camera.right = (minX + maxX) / 2 + (unitsPerPixel * WIDTH) / 2;
    this.camera.bottom = (minY + maxY) / 2 - (unitsPerPixel * HEIGHT) / 2;
    this.camera.top = (minY + maxY) / 2 + (unitsPerPixel * HEIGHT) / 2;
    this.camera.updateProjectionMatrix();

    const project = (v: Vector3) => {
      const ndc = v.clone().project(this.camera);
      return { x: ((ndc.x + 1) * WIDTH) / 2, y: ((1 - ndc.y) * HEIGHT) / 2 };
    };
    const points = (vertices: Vector3[]) =>
      vertices
        .map((v) => {
          const q = project(v);
          return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
        })
        .join(" ");
    const view = this.camera.matrixWorldInverse;
    const dots = scene!.points
      .map((point) => {
        const position = at(point.screenX, point.screenY, point.depthCm);
        return { position, color: point.color, z: position.clone().applyMatrix4(view).z };
      })
      .sort((a, b) => a.z - b.z)
      .map(({ position, color }) => {
        const q = project(position);
        return `<rect x="${(q.x - 0.75).toFixed(1)}" y="${(q.y - 0.75).toFixed(1)}" width="1.6" height="1.6" fill="${color}"/>`;
      })
      .join("");
    const rings = [100, 300, 1000, 3000]
      .filter((d) => d < maxDepth)
      .map((d) => {
        const ring = rect(d);
        const q = project(ring[1]);
        return `<polygon points="${points(ring)}" fill="none" stroke="#a5b5c0" stroke-opacity=".16" stroke-width=".7"/><text x="${(q.x + 3).toFixed(1)}" y="${(q.y + 8).toFixed(1)}" class="overview-label overview-tick">${d / 100} m</text>`;
      })
      .join("");
    const edges = screen
      .map(
        (corner, i) =>
          `<polyline points="${points([neutral, corner, far[i]])}" fill="none" stroke="#a5b5c0" stroke-opacity=".26" stroke-dasharray="2.5 3" stroke-width=".8"/>`,
      )
      .join("");
    const headPoint = project(head);
    const bodyPoint = project(shoulders);
    const eyePoint = project(eye);
    const headRadius = 4.5 / unitsPerPixel;
    const text = (t: string, v: Vector3, dx: number, dy: number, c: string) => {
      const q = project(v);
      const x = Math.max(22, Math.min(WIDTH - 24, q.x + dx));
      const y = Math.max(12, Math.min(HEIGHT - 7, q.y + dy));
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${c}" class="overview-label">${t}</text>`;
    };
    this.plot.innerHTML = `
      <title>Your head, the screen, and the scene behind it</title>
      <desc>Coloured dots are samples of the Gaussian splat scene that you see through the screen. Depth uses a log scale; rings mark 1, 3, 10 and 30 metres behind the screen. Distances are estimates.</desc>
      ${edges}
      ${rings}
      <polygon points="${points(far)}" fill="none" stroke="#a5b5c0" stroke-opacity=".2" stroke-width=".8"/>
      <g opacity=".92">${dots}</g>
      <polygon points="${points(screen)}" fill="#4eafb6" fill-opacity=".1" stroke="#72bfc5" stroke-width="1.5"/>
      <ellipse cx="${bodyPoint.x}" cy="${bodyPoint.y}" rx="${headRadius * 1.9}" ry="${headRadius * 0.85}" fill="#525966" stroke="#a3aab5" stroke-width=".8"/>
      <circle cx="${headPoint.x}" cy="${headPoint.y}" r="${headRadius}" fill="#d3d7df" stroke="#f3f5f8" stroke-width=".8"/>
      <circle cx="${eyePoint.x}" cy="${eyePoint.y}" r="1.4" fill="#202329"/>
      ${text("You", head, 0, -headRadius - 6, "#e3e6ec")}
      ${text("Screen", screen[1], 4, 14, "#80c6cc")}
    `;
  }
}
