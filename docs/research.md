# Research and decisions

Researched 2026-10-31. This is a standalone browser experiment; no source or
package dependency is imported from the eye-tracker repository.

## Tracking

[MediaPipe Face Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)
returns face landmarks and optional face transformation matrices and blendshapes.
The transformation matrix supplies head orientation. The application removes its
scale, obtains a quaternion, and compares it with a captured neutral quaternion.
Directions come from the neutral-relative forward vector, avoiding Euler-angle
subtraction around a nonidentity neutral. Roll is ignored for camera steering.

The input image is not mirrored. Only the small video and landmark preview are
mirrored for a familiar webcam presentation. Subject-right is mapped centrally
in `tracking-math.ts`, with a user-facing horizontal inversion option. Synthetic
rotation tests establish mathematical signs; a human trial must confirm physical
camera conventions on the target device.

Google explicitly states that [iris tracking is not itself an estimate of where
someone is looking](https://chuoling.github.io/mediapipe/solutions/iris.html).
Therefore Eyes is labelled experimental and implemented as a relative directional
controller, not a gaze ray, screen coordinate, or point-of-regard estimator.
Each eye's iris displacement is projected onto a corner-aligned basis in pixel
space and divided by eye width; pixel space matters on nonsquare video. Both
eyes are averaged, with blink/aperture rejection and neutral median offsets.
Large head rotations suppress eye control. In Both mode, eye assistance is capped
at 20% of command range, and head control survives rejected eye frames.

## Rendering and inference

[Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) loads binary
glTF and supports animation and material extensions. The viewer normalizes model
bounds, frames the object, provides a generated room lighting environment, and
configures Draco, Meshopt, and Basis/KTX2 decoding. Samples, model weights, WASM,
and decoders are copied/downloaded during setup, avoiding runtime CDN dependency
for tracking and the built-in models.

The [MediaPipe guide](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)
notes that inference is synchronous and blocks its calling thread. It recommends
workers. The [official worker example](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/face-landmarker.worker.ts)
uses ImageBitmap input. This demo uses a classic worker because the pinned WASM
loader uses `importScripts`; the JS API is dynamically imported inside that worker.
One bitmap is in flight, excess camera frames are skipped, and bitmaps are closed
in a `finally` block. CPU inference in the worker avoids competing with the
viewer's GPU context. It is not a guarantee of any particular frame rate.

The capture timestamp travels with the result. A result older than 250 ms is
rejected even if it just arrived. The camera loop is limited to approximately
22 submissions/second and never queues inference work. Real measured throughput
depends on the device. Worker startup and actual inference were verified in the
preview browser using a portrait fixture; the full test video stream then
verified calibration, face loss, reacquisition, and releasing tracks.

## Two camera behaviors

[OrbitControls](https://threejs.org/docs/pages/OrbitControls.html) documents orbiting
around a target; [PointerLockControls](https://threejs.org/docs/pages/PointerLockControls.html)
is intended for a first-person view. These describe different camera operations.
The following mapping is an interaction design choice inferred from that distinction,
rather than a claim that either library provides head tracking:

| Mode         | Camera position                           | Camera orientation               | Tracking mapping                                                                                                                                |
| ------------ | ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Orbit object | Moves around the object's center          | Faces the object                 | Head deflection controls angular velocity, up to about 55°/s horizontally. Neutral stops movement; modest sustained input permits a full orbit. |
| Look around  | Fixed until an explicit mouse-wheel dolly | Turns locally left/right/up/down | Relative head deflection controls a bounded offset, approximately ±45° yaw and ±28° pitch. Neutral returns to the current forward direction.    |

A small custom camera rig owns both modes and mouse behavior, avoiding two
controllers overwriting one camera. Orbit uses spherical coordinates and pole
limits. Look composes a local quaternion with a captured base orientation.
Returning from look to orbit must turn toward the fixed object pivot; it cannot
preserve both arbitrary orientation and pivot. The demo keeps position and
interpolates orientation over 240 ms, with tracking suppressed for that transition.

There is no automatic wink/blink mode switch: ordinary blinks should not change
the interaction. Buttons and keys `1` / `2` switch modes explicitly. Mouse input
acts as a clutch and resets neutral on release. A recenter preserves the current
visible camera pose. Lost/stale input bypasses smoothing and freezes movement;
reacquisition performs neutral capture again.

## Public models

The [Khronos collection](https://github.com/KhronosGroup/glTF-Sample-Assets) has
direct-download GLBs, screenshots, per-model READMEs, and licensing information.
It requires no account or API key. The four samples are pinned to a specific
repository commit by setup and cached locally. README links and the viewer's
credit line preserve creator/license information. Licenses differ by model;
particularly, the helmet's original version is CC BY-NC, not CC0.

Potential follow-ups after a real webcam trial: directional gain calibration,
separate vertical inversion, calibrated multi-point screen gaze, a continuous
mouse-like clutch for look mode, and a true head-position/parallax camera. Those
are separate experiments rather than claims made by the current demo.
