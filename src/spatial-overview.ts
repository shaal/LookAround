import { OrthographicCamera, Vector3 } from "three";
import {
  BOX_FACES,
  boxCorners,
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

  constructor(private container: HTMLElement) {
    this.plot = container.querySelector("svg")!;
    this.state = container.querySelector("[data-overview-state]")!;
    this.toScreen = container.querySelector("[data-to-screen]")!;
    this.toObject = container.querySelector("[data-to-object]")!;
    this.depth = container.querySelector("[data-object-depth]")!;
    this.scale = container.querySelector("[data-depth-scale]")!;
    this.modeButton = container.querySelector("button")!;
  }

  update(geometry: SpatialGeometry | null, state: OverviewState) {
    this.state.textContent = geometry ? state : "Loading";
    this.container.dataset.state = state.toLowerCase();
    this.modeButton.hidden = state !== "Preview";
    if (!geometry) return;
    const { frame, center, eyeToObjectCm, depthScale } = geometry;
    this.toScreen.textContent = `${frame.eye.z.toFixed(0)} cm`;
    this.toObject.textContent = `${eyeToObjectCm.toFixed(0)} cm`;
    this.depth.textContent =
      Math.abs(center.z) < 0.5
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
    const rays = [object[0], object[3], object[5], object[6]]
      .map((corner) =>
        line(
          [eye, corner],
          "#a5b5c0",
          'stroke-opacity=".25" stroke-dasharray="2.5 3"',
        ),
      )
      .join("");
    const screenImage = image
      ? `<g clip-path="url(#overview-screen-clip)">${BOX_FACES.map(
          (face) =>
            `<polygon points="${points(face.map((i) => image[i]))}" fill="#edc18b" fill-opacity=".12" stroke="#f3c78f" stroke-width=".8"/>`,
        ).join("")}</g>`
      : "";
    this.plot.innerHTML = `
      <title>Your head, the viewing area, and the model in 3D</title>
      <desc>The wireframe box is the model. Its gold image is projected onto the cyan screen. Distances are estimates.</desc>
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
}
