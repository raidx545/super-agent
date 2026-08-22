// ============================================================
// VLESS — ONNX Runtime session factory for OCR (offscreen only)
//
// The ONLY module that imports onnxruntime-web. We use the WebGPU *bundle*
// build (`onnxruntime-web/webgpu`), whose JS loader glue is inlined and which
// ships the single jsep WASM binary — one file that runs the WebGPU EP when a
// GPU is present and the SIMD/threaded CPU kernels otherwise. This keeps ORT
// out of the service-worker bundle entirely (it is imported only by the OCR
// engine, which is imported only by the offscreen document).
//
// Backend selection is explicit-with-fallback: try WebGPU when the tier allows
// it, then fall back to WASM, so the reported backend never lies.
// ============================================================

import * as ort from "onnxruntime-web/webgpu";

export type OcrBackend = "webgpu" | "wasm";

export interface OcrSession {
  session: ort.InferenceSession;
  inputName: string;
  outputName: string;
  backend: OcrBackend;
}

let envConfigured = false;

/** Configure ort.env once. WASM binaries are served from the vendored
 *  `public/ort/` copy (see scripts/copy-ort-wasm.mjs). Threading requires
 *  cross-origin isolation, which extension offscreen docs lack — so we run
 *  single-threaded there and let SIMD carry the CPU path. */
function configureEnv(): void {
  if (envConfigured) return;
  envConfigured = true;

  ort.env.wasm.wasmPaths = chrome.runtime.getURL("ort/");

  const coi = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
  const cores =
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
  ort.env.wasm.numThreads = coi ? Math.max(1, Math.min(cores, 4)) : 1;
  ort.env.wasm.simd = true;
  ort.env.logLevel = "error";
}

// One session per model key for the offscreen lifetime (tier is fixed).
const cache = new Map<string, Promise<OcrSession>>();

async function build(bytes: ArrayBuffer, webgpu: boolean): Promise<OcrSession> {
  configureEnv();
  const attempts: OcrBackend[] = webgpu ? ["webgpu", "wasm"] : ["wasm"];
  let lastErr: unknown;

  for (const ep of attempts) {
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [ep],
        graphOptimizationLevel: "all",
      });
      return {
        session,
        inputName: session.inputNames[0],
        outputName: session.outputNames[0],
        backend: ep,
      };
    } catch (e) {
      lastErr = e;
      // Fall through to the next execution provider.
    }
  }
  throw new Error(
    `OCR session create failed: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}

/**
 * Get (or create + cache) an OCR inference session.
 * @param key    Stable identity for caching (e.g. the model id).
 * @param bytes  The ONNX model weights.
 * @param opts.webgpu  Whether to attempt the WebGPU EP first.
 */
export function getOcrSession(
  key: string,
  bytes: ArrayBuffer,
  opts: { webgpu: boolean },
): Promise<OcrSession> {
  let p = cache.get(key);
  if (!p) {
    p = build(bytes, opts.webgpu);
    cache.set(key, p);
    // Don't cache a rejected promise — let the next call retry.
    p.catch(() => cache.delete(key));
  }
  return p;
}

export interface RunOutput {
  data: Float32Array;
  dims: readonly number[];
}

/** Run a single float32 input tensor through a session and return the first
 *  output as raw data + dims. Keeps all ort.Tensor usage inside this module. */
export async function runSession(
  s: OcrSession,
  data: Float32Array,
  dims: number[],
): Promise<RunOutput> {
  const input = new ort.Tensor("float32", data, dims);
  const feeds: Record<string, ort.Tensor> = { [s.inputName]: input };
  const out = await s.session.run(feeds);
  const t = out[s.outputName];
  return { data: t.data as Float32Array, dims: t.dims };
}

/** Release all cached sessions (e.g. on offscreen teardown). */
export async function disposeOcrSessions(): Promise<void> {
  const entries = [...cache.values()];
  cache.clear();
  await Promise.all(
    entries.map(async (p) => {
      try {
        const s = await p;
        await s.session.release();
      } catch {
        /* already failed/released */
      }
    }),
  );
}
