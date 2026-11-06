import { Matrix4, Quaternion, Vector3 } from "three";
import { zipSync } from "fflate";

export type SplatFormat = "ply" | "spz" | "splat" | "ksplat" | "pcsogszip";

export type SplatView = { position: Vector3; target: Vector3 };

export type SplatPayload = {
  bytes: Uint8Array;
  format: SplatFormat;
  view: SplatView | null;
};

const CDN = "https://d28zzqy0iyovbz.cloudfront.net";
const EXTENSIONS: Record<string, SplatFormat> = {
  ply: "ply",
  spz: "spz",
  splat: "splat",
  ksplat: "ksplat",
  sog: "pcsogszip",
};

export function splatFormat(name: string): SplatFormat | null {
  const clean = name.toLowerCase().split(/[?#]/)[0];
  const ext = clean.split(".").pop() ?? "";
  return EXTENSIONS[ext] ?? null;
}

export function isSplatName(name: string) {
  return splatFormat(name) !== null;
}

/** Accepts `superspl.at/view?id=abc123`, `…/s?id=abc123`, or a CDN folder URL. */
export function superSplatBase(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (/(^|\.)superspl\.at$/.test(url.hostname)) {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f]{6,16}$/i.test(id)) return null;
    const version = url.searchParams.get("v") ?? "1";
    return `${CDN}/${id}/v${version}/`;
  }
  if (url.hostname === new URL(CDN).hostname) {
    const match = url.pathname.match(/^\/([0-9a-f]+)\/(v\d+)\//i);
    return match ? `${CDN}/${match[1]}/${match[2]}/` : null;
  }
  return null;
}

type Progress = (loaded: number, total: number) => void;

async function fetchBytes(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** SuperSplat publishes SOG as loose webp files; zip them into one `.sog`. */
export async function fetchSuperSplat(
  base: string,
  signal: AbortSignal,
  progress: Progress = () => {},
): Promise<SplatPayload> {
  const metaBytes = await fetchBytes(`${base}meta.json`, signal).catch(
    (error: unknown) => {
      if (error instanceof Error && /HTTP 40[34]/.test(error.message))
        throw new Error(
          "This SuperSplat scene has no public SOG files. Try another scene.",
        );
      throw error;
    },
  );
  const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as Record<
    string,
    { files?: string[] } | unknown
  >;

  const names = new Set<string>();
  for (const value of Object.values(meta))
    if (value && typeof value === "object" && "files" in value)
      for (const file of (value as { files: string[] }).files ?? [])
        names.add(file);
  if (!names.size) throw new Error("The SuperSplat scene lists no files.");
  const files: Record<string, Uint8Array> = { "meta.json": metaBytes };
  let done = 0;
  progress(0, names.size);
  await Promise.all(
    [...names].map(async (name) => {
      files[name] = await fetchBytes(base + name, signal);
      progress(++done, names.size);
    }),
  );
  const view = await fetch(`${base}settings.json`, { signal })
    .then((r) => (r.ok ? r.json() : null))
    .then(parseSettingsView)
    .catch(() => null);
  return { bytes: zipSync(files, { level: 0 }), format: "pcsogszip", view };
}

/** Reads the publisher's start camera from SuperSplat `settings.json` (v1 or v2). */
export function parseSettingsView(settings: unknown): SplatView | null {
  if (!settings || typeof settings !== "object") return null;
  const s = settings as {
    camera?: { position?: number[]; target?: number[] };
    cameras?: { initial?: { position?: number[]; target?: number[] } }[];
  };
  const camera = s.cameras?.[0]?.initial ?? s.camera;
  const p = camera?.position,
    t = camera?.target;
  if (!p || !t || p.length !== 3 || t.length !== 3) return null;
  if (![...p, ...t].every(Number.isFinite)) return null;
  const position = new Vector3(...p),
    target = new Vector3(...t);
  // Some scenes store a target almost on top of the camera; keep the direction.
  if (position.distanceTo(target) < 1e-6) return null;
  return { position, target };
}

/** SuperSplat shows raw 3DGS data rotated 180° about Z (the data is Y-down). */
export const SPLAT_UP_FIX = new Quaternion(0, 0, 1, 0);

/**
 * Builds the transform that maps the scene's start camera onto the rig camera.
 * `scale` is rig units per scene unit; the scene camera lands exactly on the
 * rig camera, so head parallax starts from the publisher's chosen view.
 */
export function viewPlacement(
  view: SplatView,
  rigPosition: Vector3,
  rigQuaternion: Quaternion,
  scale: number,
): Matrix4 {
  const look = new Matrix4().lookAt(view.position, view.target, new Vector3(0, 1, 0));
  const sceneCamera = new Matrix4()
    .makeRotationFromQuaternion(new Quaternion().setFromRotationMatrix(look))
    .setPosition(view.position);
  const rigCamera = new Matrix4().compose(
    rigPosition,
    rigQuaternion,
    new Vector3(1, 1, 1),
  );
  return rigCamera
    .multiply(new Matrix4().makeScale(scale, scale, scale))
    .multiply(sceneCamera.invert());
}
