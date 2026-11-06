import { test } from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import {
  isSplatName,
  parseSettingsView,
  splatFormat,
  superSplatBase,
  viewPlacement,
} from "./splat-source";

test("splat formats come from the file extension", () => {
  assert.equal(splatFormat("garden.splat"), "splat");
  assert.equal(splatFormat("https://x.dev/a/scene.SPZ?dl=1"), "spz");
  assert.equal(splatFormat("room.sog"), "pcsogszip");
  assert.equal(isSplatName("helmet.glb"), false);
});

test("SuperSplat links resolve to the public CDN folder", () => {
  assert.equal(
    superSplatBase("https://superspl.at/view?id=ca36efcc"),
    "https://d28zzqy0iyovbz.cloudfront.net/ca36efcc/v1/",
  );
  assert.equal(
    superSplatBase(
      "https://d28zzqy0iyovbz.cloudfront.net/9b18007e/v1/meta.json",
    ),
    "https://d28zzqy0iyovbz.cloudfront.net/9b18007e/v1/",
  );
  assert.equal(superSplatBase("https://superspl.at/view?id=../x"), null);
  assert.equal(superSplatBase("https://example.com/a.splat"), null);
});

test("settings.json start cameras parse in both schema versions", () => {
  const v2 = parseSettingsView({
    cameras: [{ initial: { position: [1, 2, 3], target: [1, 2, 0] } }],
  });
  assert.deepEqual(v2?.position.toArray(), [1, 2, 3]);
  const v1 = parseSettingsView({ camera: { position: [0, 0, 5], target: [0, 0, 0] } });
  assert.deepEqual(v1?.target.toArray(), [0, 0, 0]);
  assert.equal(parseSettingsView({ camera: { position: [0, 0, 0], target: [0, 0, 0] } }), null);
  assert.equal(parseSettingsView(null), null);
});

test("placement puts the scene camera on the rig camera, looking the same way", () => {
  const view = { position: new Vector3(4, 1, -2), target: new Vector3(4, 1, -12) };
  const rigPosition = new Vector3(0, 0.1, 6.8);
  const rigQuaternion = new Quaternion(); // looking down -Z
  const matrix = viewPlacement(view, rigPosition, rigQuaternion, 10);
  const eye = view.position.clone().applyMatrix4(matrix);
  assert.ok(eye.distanceTo(rigPosition) < 1e-9);
  const ahead = new Vector3(4, 1, -3).applyMatrix4(matrix);
  // One scene unit forward becomes ten rig units down -Z.
  assert.ok(ahead.distanceTo(new Vector3(0, 0.1, -3.2)) < 1e-9);
});
