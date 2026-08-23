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

import { pinOrtEnv, diagnoseWasm } from "../runtime/ort-env";
import * as ort from "onnxruntime-web/webgpu";

export type OcrBackend = "webgpu" | "wasm";

export interface OcrSession {
  session: ort.InferenceSession;
  inputName: string;
  outputName: string;
  backend: OcrBackend;
}

/** Env setup lives in core/runtime/ort-env so it can run before
 *  transformers.js claims wasmPaths. This just guarantees it has happened. */
function configureEnv(): void {
  pinOrtEnv();
}

// One session per model key for the offscreen lifetime (tier is fixed).
const cache = new Map<string, Promise<OcrSession>>();

async function build(bytes: ArrayBuffer, webgpu: boolean): Promise<OcrSession> {
  configureEnv();
  // The final entry is "default": create the session WITHOUT naming an
  // execution provider. We import `onnxruntime-web/webgpu`, but the bundler
  // collapses that with the plain `onnxruntime-web` that transformers.js
  // depends on — and in the plain build "webgpu" is not a registered
  // provider, so naming it yields "no available backend found". Letting ORT
  // choose works whichever build won the dedup.
  const attempts: Array<OcrBackend | "default"> =
    webgpu ? ["webgpu", "wasm", "default"] : ["wasm", "default"];

  // Keep EVERY attempt's error, in order. ORT's wasm loader caches its first
  // initWasm() rejection, so a later attempt only ever reports "previous call
  // to 'initWasm()' failed". Overwriting with the last error therefore throws
  // away the only message that says what actually went wrong — which is
  // always the FIRST one.
  const failures: Array<{ ep: OcrBackend | "default"; message: string }> = [];

  for (const ep of attempts) {
    try {
      const session = await ort.InferenceSession.create(
        bytes,
        ep === "default"
          ? { graphOptimizationLevel: "all" }
          : { executionProviders: [ep], graphOptimizationLevel: "all" }
      );
      if (failures.length > 0) {
        console.warn(
          `[VLESS] OCR fell back to ${ep}. Earlier attempts: ` +
            failures.map((f) => `${f.ep}: ${f.message}`).join(" | ")
        );
      }
      return {
        session,
        inputName: session.inputNames[0],
        outputName: session.outputNames[0],
        // "default" resolved to whatever ORT picked; report wasm, which is
        // what the default is on every build we ship.
        backend: ep === "default" ? "wasm" : ep,
      };
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      failures.push({ ep, message });
      // Log immediately: if a later attempt poisons the message, this is the
      // only place the original survives.
      console.error(`[VLESS] OCR ${ep} EP failed:`, e);
    }
  }

  // The root cause is the first failure; the rest are usually its echo.
  const root = failures[0];
  const echoes = failures
    .slice(1)
    .map((f) => `${f.ep}: ${f.message}`)
    .join("; ");

  let diagnosis = "";
  try {
    diagnosis = ` — ${await diagnoseWasm()}`;
  } catch {
    /* diagnosis is best-effort */
  }

  throw new Error(
    `OCR session create failed. Root cause [${root?.ep}]: ${root?.message ?? "unknown"}` +
      (echoes ? ` (then ${echoes})` : "") +
      diagnosis
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
