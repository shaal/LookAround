import {
  mkdir,
  copyFile,
  readdir,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = "8f492390ddc7a2ae221a1369ef560589cf8c70fb";
const base = `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${revision}`;
const modelHash =
  "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";

async function download(url, path, hash) {
  const destination = resolve(root, path);
  try {
    const data = await readFile(destination);
    if (
      data.length &&
      (!hash || createHash("sha256").update(data).digest("hex") === hash)
    )
      return;
  } catch {
    /* Not cached yet. */
  }
  console.log(`Fetching ${path}`);
  let data;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      data = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      if (attempt === 2)
        throw new Error(`${path}: download failed after 3 attempts`, {
          cause: error,
        });
    }
  }
  if (hash && createHash("sha256").update(data).digest("hex") !== hash)
    throw new Error(`${path}: checksum mismatch`);
  await mkdir(resolve(destination, ".."), { recursive: true });
  await writeFile(`${destination}.partial`, data);
  await rename(`${destination}.partial`, destination);
}

await mkdir(resolve(root, "public/vision/wasm"), { recursive: true });
const vision = resolve(root, "node_modules/@mediapipe/tasks-vision");
await copyFile(
  `${vision}/vision_bundle.mjs`,
  resolve(root, "public/vision/vision_bundle.mjs"),
);
for (const name of await readdir(`${vision}/wasm`)) {
  await copyFile(
    `${vision}/wasm/${name}`,
    resolve(root, "public/vision/wasm", name),
  );
}
for (const [source, target] of [
  ["draco/gltf", "draco"],
  ["basis", "basis"],
]) {
  const directory = resolve(
    root,
    "node_modules/three/examples/jsm/libs",
    source,
  );
  await mkdir(resolve(root, "public/decoders", target), { recursive: true });
  for (const name of await readdir(directory)) {
    if (!/\.(js|wasm)$/.test(name)) continue;
    await copyFile(
      resolve(directory, name),
      resolve(root, "public/decoders", target, name),
    );
  }
}
const results = await Promise.allSettled([
  download(
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    "public/vision/face_landmarker.task",
    modelHash,
  ),
  ...["DamagedHelmet", "Duck", "Avocado", "BoomBox"].flatMap((name) => [
    download(
      `${base}/Models/${name}/glTF-Binary/${name}.glb`,
      `public/models/${name}.glb`,
    ),
    download(
      `${base}/Models/${name}/screenshot/screenshot.${["Avocado", "BoomBox"].includes(name) ? "jpg" : "png"}`,
      `public/models/${name}.${["Avocado", "BoomBox"].includes(name) ? "jpg" : "png"}`,
    ),
    download(
      `${base}/Models/${name}/README.md`,
      `public/models/licenses/${name}.md`,
    ),
  ]),
  download(`${base}/LICENSES/SCEA.txt`, "public/models/licenses/SCEA.txt"),
]);
const failures = results.filter((result) => result.status === "rejected");
if (failures.length)
  throw new AggregateError(
    failures.map((result) => result.reason),
    "Some assets could not be downloaded. Run npm run setup to retry; completed downloads are cached.",
  );
console.log("Ready: four sample GLBs, credits, and local tracking assets.");
