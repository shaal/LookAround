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
   of the screen. **Hold still for one second.** The red dot turns green and a
   ring fills while your head and eyes stay steady. Movement resets it. Completing
   the ring automatically sets head position, orientation, and eye direction.
3. Start with **Head** and **Orbit object**. Turn a little to orbit continuously;
   face neutral to stop. A modest held turn can make a complete 360° orbit.
4. Switch to **Look around** to keep the camera position fixed and turn its view
   left/right/up/down instead. Mode switching is explicit, via buttons or keys.
5. **Eyes** uses rough iris direction; **Both** adds a small eye-direction assist
   to head steering. These are experimental, not calibrated screen-gaze tracking.
   For eyes, hold your head still and look at the viewport center during capture.
6. **Head camera** (`3`) uses physical head **position**, including sideways,
   up/down, and closer/farther movement. An off-axis projection keeps the virtual
   display plane fixed, giving the effect of looking through a window. Holding a
   head position holds the camera there.
   **Gaze rotates object** is enabled by default: eyes rotate the model around its
   center while head position moves the camera. Eye loss/blinking holds the model
   angle. You can switch gaze rotation off independently.

### Simple physical setup

Head camera starts with the requested **32-inch 16:9 screen preset** (70.8 cm wide)
and approximately **46 cm eyes-to-screen distance** (1.5 feet). The initial object
distance is 61 cm, roughly two feet. These are estimates, not detected hardware.

- **Match a bank card:** hold a standard bank card against the display and resize
  the outline with its corner handle or slider. Click **Fits my card**. This gives
  physical screen scale without typing measurements; no card photo is taken.
- **Estimate distance:** with the camera active, hold still at the reference dot
  for a one-second face-pose depth estimate. This is approximate camera-to-face
  distance, not calibrated eye-to-screen measurement. The known 46 cm starting
  estimate can be better than the camera estimate.
- **Fine-tune measurements** remains available. Measurements are saved locally.
  Card scale compensates for browser zoom changes; moving to a differently sized
  monitor requires another card match.

For a stationary-object test, disable **Gaze rotates object** and choose a model
without animation. Head movement bypasses steering sensitivity, inversion, and
normalized deadzones. In Head camera those controls affect gaze only. Camera
translation and the screen projection update together in physical units.

**Your setup in 3D**, pinned beneath **Pick a perspective**, shows the applied
head position, viewing area, and a bounding box for the model. Gold lines on the
screen show the projected image. The distances and approximate **Size** percentage
update in Head camera, including simulated input; paused or missing input holds
the last applied position. Other modes show a labelled setup preview.

With the defaults, the object's center is only **15 cm behind the screen**.
Moving 10 cm toward the screen changes its center-plane image scale to about
94%; moving 10 cm away gives about 105%. Distant background changes more strongly.
This is the fixed-screen window effect: the physical screen occupies more of
your vision as you approach it, while a behind-screen object's image can shrink
slightly in screen pixels. The diagram exposes this geometry. Its size readout
isolates head depth; gaze rotation can also change the model's visible outline.

**Try simulated tracking** exercises the same input mapping and camera controls
without a camera, including the animated reference dot. It is visibly labelled and is
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
after face loss reopens the center dot for another one-second hold. Hidden tabs stop sending
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
MediaPipe worker, reference capture, face loss/reacquisition, and camera teardown.
Timing tests check the one-second hold and resets for head/eye motion, blinks,
missing/stale frames, and slow drift. Other synthetic tests check that rotation alone
doesn't drive translation, held positions don't drift, and eye rotation doesn't
change the translation axes.
That verifies the software path, not live tracking comfort or accuracy. Default
physical direction, lighting/glasses performance, and eye control need a human
webcam trial. The horizontal inversion switch is available for that trial.

Projection tests verify fixed screen corners under XYZ motion, front/behind-plane
parallax, depth-dependent scaling, unchanged pose and projection on clutch rebases,
restoring the regular camera on mode exit, and resize without a fresh tracking frame.
Bank-card scale and zoom compensation are also checked. These numerical tests do
not establish real webcam depth accuracy or the user's actual card measurement.
Browser checks covered card resizing/confirmation, persistence across reload,
the distance-estimate flow, and a scaled portrait stream whose approach reduced
the reported viewing distance. Test calibration settings were cleared afterward.
Overview tests compare the diagram's screen image with the actual camera projection
under XYZ movement and a rotated screen frame, and check depth scale, held poses,
rebasing, and a preview that leaves the main camera unchanged. The diagram's SVG
was also rendered at closer, neutral, and farther positions for visual inspection.

See [docs/research.md](docs/research.md) for sources and design decisions.

## Structure

```text
src/viewer.ts          GLB loading, lighting, animation, disposal, mouse controls
src/object-rotation.ts gaze-driven rotation of the centered model
src/camera-rig.ts      orbit / fixed-position look / head-position camera behavior
src/screen-window.ts   physically scaled XYZ view and fixed-plane off-axis projection
src/spatial-geometry.ts  screen-space physical geometry and projected model bounds
src/spatial-overview.ts  compact live 3D diagram of head, screen, and object
src/tracking-math.ts   pose, iris geometry, neutral, guards, signal filtering
src/reference-capture.ts  continuous one-second stability and reference capture
src/tracker.ts         opt-in camera and worker lifecycle, one frame in flight
src/main.ts            UI and input state, calibration, simulation
public/vision-worker.js  classic worker running local MediaPipe inference
scripts/setup-assets.mjs  reproducible downloads and decoder preparation
```
