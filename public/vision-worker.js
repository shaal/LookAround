/* Classic worker intentionally: the pinned MediaPipe WASM loader uses importScripts.
   Frame pixels never leave this worker and are closed after each inference. */
let landmarker;
let cardCV = null,
  cardsEnabled = false,
  cardGeneration = 0,
  cardCanvas,
  cardLoading;
self.onmessage = async ({ data }) => {
  if (data.type === "card-stop") {
    cardsEnabled = false;
    cardGeneration++;
  }
  if (data.type === "card-start") {
    const generation = ++cardGeneration;
    try {
      cardLoading ??= (async () => {
        importScripts("/vision/opencv.js", "/card-detection.js");
        const runtime = self.cv;
        if (runtime instanceof Promise) cardCV = await runtime;
        else {
          // Older OpenCV modules are self-resolving thenables, not Promises.
          if (!runtime.Mat)
            await new Promise((resolve) => {
              runtime.onRuntimeInitialized = resolve;
            });
          cardCV = runtime;
        }
      })();
      await cardLoading;
      if (generation !== cardGeneration) return;
      cardsEnabled = true;
      self.postMessage({ type: "card-ready" });
    } catch (error) {
      cardLoading = null;
      self.postMessage({ type: "card-error", message: String(error) });
    }
  }
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
      let card = null;
      if (cardsEnabled && result.faceLandmarks[0]?.length) {
        try {
          const width = Math.min(640, data.bitmap.width);
          const height = Math.round(
            (data.bitmap.height * width) / data.bitmap.width,
          );
          cardCanvas ??= new OffscreenCanvas(width, height);
          cardCanvas.width = width;
          cardCanvas.height = height;
          const context = cardCanvas.getContext("2d", {
            willReadFrequently: true,
          });
          context.drawImage(data.bitmap, 0, 0, width, height);
          const corners = self.detectCardCorners(
            cardCV,
            context.getImageData(0, 0, width, height).data,
            width,
            height,
            result.faceLandmarks[0],
          );
          if (corners)
            card = {
              corners: corners.map((p) => ({
                x: (p.x * data.bitmap.width) / width,
                y: (p.y * data.bitmap.height) / height,
              })),
              width: data.bitmap.width,
              height: data.bitmap.height,
            };
        } catch (error) {
          cardsEnabled = false;
          self.postMessage({ type: "card-error", message: String(error) });
        }
      }
      self.postMessage({
        type: "result",
        timestamp: data.timestamp,
        points: result.faceLandmarks[0] ?? [],
        matrix: result.facialTransformationMatrixes[0]?.data ?? [],
        blink: Math.max(0, ...blinks.map((b) => b.score)),
        card,
        width: data.bitmap.width,
        height: data.bitmap.height,
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
