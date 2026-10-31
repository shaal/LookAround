# Parallax

A standalone, local 3D playground: open a GLB, then use your head to explore it.
Built from scratch with TypeScript, Three.js, and MediaPipe. It has its own Git
repository and no dependency on the eye-tracker project, Electron, or native code.

## Run

Requires Node 22.12 or newer and a modern browser with WebGL, Web Workers, and
camera support. Chrome or Edge on a desktop is the recommended starting point.

```sh
cd ~/code/experiments/3d-tracker
npm install
npm run dev
```

Open **http://localhost:5174** in your regular browser. Installation downloads
four sample models, their credits, the face model, matching WASM, and GLB decoders.
Downloads are cached under ignored `public/` directories. `npm run setup` retries
asset preparation when needed. Runtime camera processing uses local assets.
Google Fonts is optional; system fonts are used if unavailable.

1. Choose a sample, drop a local `.glb`, or enter a direct, CORS-enabled model URL.
2. Click **Enable camera**, allow access, and look at the large dot in the middle
   of the screen. **Click the dot to set neutral.** It becomes ready after a few
   clear, stable face samples. Nothing moves until you click. That click sets
   the starting head position, orientation, and eye direction together.
3. Start with **Head** and **Orbit object**. Turn a little to orbit continuously;
   face neutral to stop. A modest held turn can make a complete 360° orbit.
4. Switch to **Look around** to keep the camera position fixed and turn its view
   left/right/up/down instead. Mode switching is explicit, via buttons or keys.
5. **Eyes** uses rough iris direction; **Both** adds a small eye-direction assist
   to head steering. These are experimental, not calibrated screen-gaze tracking.
   For eyes, hold your head still and look at the viewport center during capture.
6. **Head camera** (`3`) uses head **position**, not head rotation. Slide sideways
   or up/down to move the camera. Holding a position holds the camera there;
   returning to the reference returns its position. Depth movement is excluded.
   **Eyes rotate the view** is independent and off by default. Eye loss/blinking
   holds the angle while valid head-position input continues to move the camera.

**Try simulated tracking** exercises the same input mapping and camera controls
without a camera, including the click-to-set dot. It is visibly labelled and is
not a live tracking result.

## Controls

| Control           | Effect                                                         |
| ----------------- | -------------------------------------------------------------- |
| `1` / `2` / `3`   | Orbit object / Look around / Head camera                       |
| `Space`           | Pause/resume tracking                                          |
| `C`               | Reopen the center dot to set neutral, preserving the view      |
| `R`               | Reset and frame the current model                              |
| Drag              | Rotate manually; tracking yields and rebases on release        |
| Scroll            | Zoom/dolly; tracking yields until scrolling stops              |
| Sensitivity       | How much a small head/eye movement changes the camera          |
| Smoothing         | Trade responsiveness for steadiness                            |
| Center dead zone  | Neutral region where tracking makes no movement                |
| Invert horizontal | Reverse horizontal steering for camera conventions/preferences |

Camera loss or a sample older than 250 ms freezes movement immediately. Returning
after face loss reopens the center dot and requires another click. Hidden tabs stop sending
inference frames. Stopping the camera releases media tracks and terminates the
worker. Mouse dragging, mode switching, and pause/resume anchor the view without
silently replacing the reference chosen at the dot. Frames and landmarks are not
recorded, persisted, or uploaded.

Custom files must be binary `.glb`, preferably self-contained. Draco, Meshopt and
KTX2/Basis decoders are configured. Remote URLs must return a GLB and permit CORS;
download pages are not model URLs. Files over 150 MB are rejected. Animation clips
play automatically. A failed load preserves the previously visible model.

## Sample models and credits

The online source is the [Khronos glTF Sample Assets collection](https://github.khronos.org/glTF-Assets/),
pinned to commit `8f492390ddc7a2ae221a1369ef560589cf8c70fb`.
The app links to each downloaded model's complete upstream README.

| Model                                                                                               | Upstream credit and license                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Damaged Helmet](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet) | ctxwing, CC BY 4.0 conversion; earlier model by theblueturtle\_, CC BY-NC 4.0. Preserve both upstream notices; the earlier asset has a noncommercial restriction. |
| [Boom Box](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/BoomBox)             | Microsoft, CC0 1.0                                                                                                                                                |
| [Avocado](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Avocado)              | Microsoft, CC0 1.0                                                                                                                                                |
| [Duck](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Duck)                    | Sony, SCEA Shared Source License 1.0; full license is downloaded alongside its credits.                                                                           |

This project's MIT license covers its own code, not those separately licensed assets.

## Validation

```sh
npm test          # tracking math, camera movement, invalid/stale data, handoffs
npm run build    # strict TypeScript check and production bundle
npm run preview  # serve the production build on port 5174 (stop dev first)
```

Browser validation covered the four models, remote URL import, local file import,
the camera modes, simulation, pause, missing-camera handling, and responsive
layout. A portrait image supplied as a test video stream exercised the real
MediaPipe worker, explicit dot acceptance, face loss/reacquisition with another
required click, and camera teardown. Synthetic tests check that rotation alone
doesn't drive translation, held positions don't drift, and eye rotation doesn't
change the translation axes.
That verifies the software path, not live tracking comfort or accuracy. Default
physical direction, lighting/glasses performance, and eye control need a human
webcam trial. The horizontal inversion switch is available for that trial.

See [docs/research.md](docs/research.md) for sources and design decisions.

## Structure

```text
src/viewer.ts          GLB loading, lighting, animation, disposal, mouse controls
src/camera-rig.ts      orbit / fixed-position look / head-position camera behavior
src/tracking-math.ts   pose, iris geometry, neutral, guards, signal filtering
src/reference-capture.ts  explicit dot acceptance and a stable sample window
src/tracker.ts         opt-in camera and worker lifecycle, one frame in flight
src/main.ts            UI and input state, calibration, simulation
public/vision-worker.js  classic worker running local MediaPipe inference
scripts/setup-assets.mjs  reproducible downloads and decoder preparation
```
