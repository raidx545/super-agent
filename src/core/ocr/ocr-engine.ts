// ============================================================
// VLESS — OCR engine (offscreen only)
//
// Orchestrates the full PP-OCR pipeline on a captured screenshot:
//   capture → detection (DB map → quads) → reading-order sort →
//   per-quad warp → recognition (CTC) → OcrWord[].
//
// Language routing:
//   "en" / "hi"  → that recognizer for every region.
//   "auto"       → recognize with English; for low-confidence regions, also
//                  try Devanagari and keep the higher-confidence read. Only
//                  ambiguous strips pay for the second pass, and a missing
//                  Hindi model degrades silently to English-only.
//
// Sessions, model bytes, and charsets are memoized for the offscreen lifetime.
// ============================================================

import type {
  BackendProfile,
  ModelId,
  OcrLang,
  OcrResult,
  OcrWord,
  Tier,
} from "../../types/runtime";
import { MODEL_REGISTRY } from "../runtime/model-registry";
import { resolveModelUrl, fetchArrayBufferWithProgress } from "../runtime/model-loader";
import { detectBackend } from "../runtime/backend";
import { loadCapture, buildDetInput, cropRecStrip, type Capture } from "./preprocess";
import { boxesFromBitmap, type DetBox } from "./db-postprocess";
import { boundingBox, type Point } from "./geometry";
import { buildCharset, ctcGreedyDecode, type Charset } from "./ctc-decode";
import { getOcrSession, runSession, type OcrSession } from "./ort-session";

/** Below this confidence in "auto" mode, a region gets a second (Hindi) pass. */
const AUTO_ARBITRATION_THRESHOLD = 0.55;
/** Drop recognized regions weaker than this (noise / non-text blobs). */
const MIN_WORD_SCORE = 0.3;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : 0;

// ── Detection input sizing per tier (long-side cap, snapped ×32 downstream) ──
function maxSideForTier(tier: Tier): number {
  if (tier === "A") return 1280; // GPU: favour small-text recall
  if (tier === "B") return 960; // PaddleOCR default
  return 736; // CPU: favour latency
}

// ── Memoized backend / sessions / charsets ───────────────────
let backendPromise: Promise<BackendProfile> | null = null;
function backend(): Promise<BackendProfile> {
  return (backendPromise ??= detectBackend());
}

const sessions = new Map<ModelId, Promise<OcrSession>>();
function ensureSession(id: ModelId): Promise<OcrSession> {
  let p = sessions.get(id);
  if (!p) {
    p = (async () => {
      const be = await backend();
      const url = resolveModelUrl(MODEL_REGISTRY[id], be);
      const bytes = await fetchArrayBufferWithProgress(url, () => {});
      return getOcrSession(id, bytes, { webgpu: be.webgpu });
    })();
    sessions.set(id, p);
    p.catch(() => sessions.delete(id));
  }
  return p;
}

const charsets = new Map<ModelId, Promise<Charset>>();
function ensureCharset(id: ModelId, numClasses: number): Promise<Charset> {
  let p = charsets.get(id);
  if (!p) {
    p = (async () => {
      const dictPath = MODEL_REGISTRY[id].ocr?.dictPath;
      if (!dictPath) throw new Error(`${id}: missing ocr.dictPath`);
      const text = await (await fetch(chrome.runtime.getURL(dictPath))).text();
      const cs = buildCharset(text, numClasses);
      if (cs.mismatch) {
        // eslint-disable-next-line no-console
        console.warn(`[VLESS] ${id}: dict/class-count mismatch (C=${numClasses})`);
      }
      return cs;
    })();
    charsets.set(id, p);
    p.catch(() => charsets.delete(id));
  }
  return p;
}

/** Ensure a detection map is in probability space; sigmoid it if the export
 *  emitted logits (defensive — standard PP-OCR exports include the sigmoid). */
function toProbMap(data: Float32Array): Float32Array {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (mn >= -0.01 && mx <= 1.01) return data;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = 1 / (1 + Math.exp(-data[i]));
  return out;
}

function bboxOf(quad: Point[]): { x: number; y: number; w: number; h: number } {
  const b = boundingBox(quad);
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

/**
 * Group detection boxes into reading order: cluster into text lines by
 * vertical-centre proximity, sort lines top→bottom, and each line left→right.
 */
function readingOrder(boxes: DetBox[]): DetBox[] {
  if (boxes.length <= 1) return boxes;
  const items = boxes.map((b) => {
    const bb = boundingBox(b.quad);
    return { b, cy: bb.y + bb.h / 2, x: bb.x, h: bb.h };
  });
  items.sort((a, z) => a.cy - z.cy);

  const medianH =
    [...items].map((i) => i.h).sort((a, z) => a - z)[Math.floor(items.length / 2)] || 1;
  const tol = Math.max(4, medianH * 0.6);

  const lines: (typeof items)[] = [];
  for (const it of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(it.cy - line[line.length - 1].cy) <= tol) line.push(it);
    else lines.push([it]);
  }
  const out: DetBox[] = [];
  for (const line of lines) {
    line.sort((a, z) => a.x - z.x);
    for (const it of line) out.push(it.b);
  }
  return out;
}

interface RecOutcome {
  text: string;
  score: number;
  lang: OcrLang;
  recMs: number;
  decMs: number;
}

async function recognize(
  cap: Capture,
  box: DetBox,
  lang: OcrLang,
): Promise<RecOutcome | null> {
  const id: ModelId = lang === "hi" ? "ocr-rec-hi" : "ocr-rec-en";
  const recHeight = MODEL_REGISTRY[id].ocr?.recHeight ?? 48;
  const strip = cropRecStrip(cap, box.quad, recHeight);
  if (!strip) return null;

  let session: OcrSession;
  try {
    session = await ensureSession(id);
  } catch {
    return null; // model unavailable (e.g. Hindi not bundled) — caller degrades
  }

  const t0 = now();
  const out = await runSession(session, strip.data, [1, 3, recHeight, strip.width]);
  const recMs = now() - t0;

  const T = out.dims[1] as number;
  const C = out.dims[2] as number;
  const charset = await ensureCharset(id, C);

  const d0 = now();
  const dec = ctcGreedyDecode(out.data, T, C, charset);
  const decMs = now() - d0;

  return { text: dec.text, score: dec.score, lang, recMs, decMs };
}

export interface RunOcrParams {
  imageDataUrl: string;
  lang?: OcrLang | "auto";
  maxSide?: number;
}

/** Run PP-OCR (detect → recognize) on a captured screenshot data URL. */
export async function runOcr(params: RunOcrParams): Promise<OcrResult> {
  const be = await backend();
  const total0 = now();

  const cap = await loadCapture(params.imageDataUrl);
  const maxSide = params.maxSide ?? maxSideForTier(be.tier);

  // ── Detection ──
  const detIn = buildDetInput(cap, maxSide);
  const det = await ensureSession("ocr-det");
  const det0 = now();
  const detOut = await runSession(det, detIn.data, [1, 3, detIn.mapH, detIn.mapW]);
  const detectMs = now() - det0;

  const outH = detOut.dims[detOut.dims.length - 2] as number;
  const outW = detOut.dims[detOut.dims.length - 1] as number;
  const prob = toProbMap(detOut.data);
  const boxes = boxesFromBitmap(
    prob,
    outW,
    outH,
    cap.width / outW,
    cap.height / outH,
    cap.width,
    cap.height,
  );
  const ordered = readingOrder(boxes);

  // ── Recognition ──
  const lang = params.lang ?? "auto";
  const words: OcrWord[] = [];
  let recognizeMs = 0;
  let decodeMs = 0;

  for (const box of ordered) {
    const primary: OcrLang = lang === "hi" ? "hi" : "en";
    let best = await recognize(cap, box, primary);
    if (best) {
      recognizeMs += best.recMs;
      decodeMs += best.decMs;
    }
    if (lang === "auto" && (!best || best.score < AUTO_ARBITRATION_THRESHOLD)) {
      const alt = await recognize(cap, box, "hi");
      if (alt) {
        recognizeMs += alt.recMs;
        decodeMs += alt.decMs;
        if (!best || alt.score > best.score) best = alt;
      }
    }
    if (!best) continue;
    const text = best.text.trim();
    if (!text || best.score < MIN_WORD_SCORE) continue;
    words.push({
      text,
      score: best.score,
      quad: box.quad,
      box: bboxOf(box.quad),
      lang: best.lang,
    });
  }

  return {
    words,
    width: cap.width,
    height: cap.height,
    timings: {
      total: now() - total0,
      detect: detectMs,
      recognize: recognizeMs,
      decode: decodeMs,
    },
    regionCount: boxes.length,
    tier: be.tier,
    backend: det.backend,
  };
}
