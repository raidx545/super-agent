// ============================================================
// VLESS — Face detection (offscreen only)
//
// Real face detection, via MediaPipe BlazeFace short-range running
// on-device. Both the WASM runtime and the .tflite weights are packaged
// with the extension — MediaPipe's FilesetResolver defaults to a jsdelivr
// CDN and the model's canonical URL is storage.googleapis.com, either of
// which would mean a third-party request on every cold start.
//
// WHY THE HEURISTIC IS GONE
// The previous fallback segmented HSV skin tone (hue 0-50 — orange through
// red). On a Punjab National Bank login page that is the brand palette, so
// it boxed the bank logo, a PCI DSS badge, a Norton seal and a play button
// as five "critical faces". A detector with that false-positive rate is
// worse than none: it discredits every genuine detection beside it.
//
// So there is no guessing here. Either a model detected a face, or this
// reports that it could not look. Silence is more honest than noise.
// ============================================================

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export type FaceMethod = "blazeface" | "facedetector" | "unavailable";

export interface FaceDetectionResult {
  faces: FaceBox[];
  method: FaceMethod;
  /** Present when no detector could run, so the caller can say why. */
  reason?: string;
}

/** Below this, a BlazeFace hit is not worth acting on. */
const MIN_CONFIDENCE = 0.5;

let detectorPromise: Promise<any> | null = null;

/** Local, packaged runtime — never a CDN. */
function wasmRoot(): string {
  return chrome.runtime.getURL("mediapipe");
}
function modelUrl(): string {
  return chrome.runtime.getURL("models/blaze_face_short_range.tflite");
}

/**
 * Load BlazeFace once per offscreen lifetime. Returns null when the model
 * is not installed, rather than throwing — a missing optional model is a
 * degraded state, not an error.
 */
async function loadDetector(): Promise<any | null> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { FilesetResolver, FaceDetector } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks(wasmRoot());
      return FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl(), delegate: "GPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: MIN_CONFIDENCE,
      });
    })().catch((err) => {
      console.warn("[VLESS] BlazeFace unavailable:", err);
      // Let a later call retry — the model may simply not be downloaded yet.
      detectorPromise = null;
      return null;
    });
  }
  return detectorPromise;
}

/**
 * Detect faces in an already-decoded frame.
 *
 * Tries BlazeFace, then the browser's FaceDetector API where present. If
 * neither is available it reports `unavailable` with a reason — it does NOT
 * fall back to shape guessing.
 */
export async function detectFaces(
  source: HTMLCanvasElement | ImageBitmap
): Promise<FaceDetectionResult> {
  // 1. BlazeFace — a real model, running locally.
  try {
    const detector = await loadDetector();
    if (detector) {
      const result = detector.detect(source);
      const faces: FaceBox[] = (result?.detections ?? [])
        .map((d: any) => {
          const b = d.boundingBox;
          return {
            x: b.originX,
            y: b.originY,
            width: b.width,
            height: b.height,
            confidence: d.categories?.[0]?.score ?? MIN_CONFIDENCE,
          };
        })
        .filter((f: FaceBox) => f.confidence >= MIN_CONFIDENCE && f.width > 0 && f.height > 0);
      return { faces, method: "blazeface" };
    }
  } catch (err) {
    console.warn("[VLESS] BlazeFace detection failed:", err);
  }

  // 2. The browser's own Shape Detection API, if this build ships it.
  const FD =
    (typeof window !== "undefined" && (window as any).FaceDetector) ||
    (typeof globalThis !== "undefined" && (globalThis as any).FaceDetector) ||
    null;
  if (FD) {
    try {
      const detector = new FD({ fastMode: true, maxDetectedFaces: 10 });
      const found = await detector.detect(source);
      return {
        faces: found.map((f: any) => ({
          x: f.boundingBox.x,
          y: f.boundingBox.y,
          width: f.boundingBox.width,
          height: f.boundingBox.height,
          confidence: 0.9,
        })),
        method: "facedetector",
      };
    } catch {
      /* fall through to unavailable */
    }
  }

  // 3. No guessing. Say so.
  return {
    faces: [],
    method: "unavailable",
    reason:
      "No face model available. Run `pnpm models` to install BlazeFace (230 KB), then reload the extension.",
  };
}
