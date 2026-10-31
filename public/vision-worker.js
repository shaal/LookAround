/* Classic worker intentionally: the pinned MediaPipe WASM loader uses importScripts.
   Frame pixels never leave this worker and are closed after each inference. */
let landmarker;
self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      const { FaceLandmarker, FilesetResolver } = await import(
        "/vision/vision_bundle.mjs"
      );
      const files = await FilesetResolver.forVisionTasks(
        new URL("/vision/wasm", self.location.href).href,
      );
      landmarker = await FaceLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: "/vision/face_landmarker.task",
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (data.type === "frame") {
    try {
      const start = performance.now();
      const result = landmarker.detectForVideo(data.bitmap, data.timestamp);
      const blinks =
        result.faceBlendshapes[0]?.categories.filter(
          (s) =>
            s.categoryName === "eyeBlinkLeft" ||
            s.categoryName === "eyeBlinkRight",
        ) ?? [];
      self.postMessage({
        type: "result",
        timestamp: data.timestamp,
        points: result.faceLandmarks[0] ?? [],
        matrix: result.facialTransformationMatrixes[0]?.data ?? [],
        blink: Math.max(0, ...blinks.map((b) => b.score)),
        inferenceMs: performance.now() - start,
      });
    } catch (error) {
      self.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      data.bitmap.close();
    }
  }
};
