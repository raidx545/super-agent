// ============================================================
// VLESS — Model Registry
// The single source of truth for every on-device model: where it
// comes from, how big it is, and at which hardware tier it runs.
//
// RULE (learned from the audit): no fabricated URLs. Every entry
// points at a real, resolvable source or a bundled file.
// ============================================================

import type { ModelEntry, ModelId, Tier } from "../../types/runtime";

export const MODEL_REGISTRY: Record<ModelId, ModelEntry> = {
  // ── OCR: PP-OCR detection (DB text-region map) ──────────────
  // PP-OCRv3_mobile_det (2.43 MB). Script-agnostic — one detector
  // serves every recognition language. (The v5 detector upstream is
  // the 88 MB *server* model; rejected as not light-weight.)
  "ocr-det": {
    id: "ocr-det",
    name: "PP-OCRv3 Detection (DB, mobile)",
    kind: "onnx-local",
    purpose: "Locate text regions on screen (differentiable-binarization map).",
    path: "models/ppocr-det-v3.onnx",
    sizeBytes: 2_429_873,
    minTier: "C",
    required: true,
  },

  // ── OCR: recognition (CTC), English ─────────────────────────
  // en_PP-OCRv5_mobile_rec. Verified from the graph: input [N,3,48,W],
  // output [N,T,438]. Height is 48 (the repo config.json's "32" is wrong).
  "ocr-rec-en": {
    id: "ocr-rec-en",
    name: "PP-OCRv5 Recognition (EN)",
    kind: "onnx-local",
    purpose: "Read Latin text from detected regions (CTC decode).",
    path: "models/ppocr-rec-en.onnx",
    sizeBytes: 7_830_888,
    minTier: "C",
    required: true,
    ocr: { dictPath: "models/ppocr-rec-en.dict.txt", numClasses: 438, recHeight: 48 },
  },

  // ── OCR: recognition (CTC), Hindi / Devanagari ──────────────
  // devanagari_PP-OCRv3_mobile_rec: input [N,3,48,W], output [N,T,169].
  "ocr-rec-hi": {
    id: "ocr-rec-hi",
    name: "PP-OCRv3 Recognition (HI / Devanagari)",
    kind: "onnx-local",
    purpose: "Read Devanagari text (Hindi/Marathi/Nepali/Sanskrit forms).",
    path: "models/ppocr-rec-hi.onnx",
    sizeBytes: 8_980_224,
    minTier: "C",
    required: false,
    ocr: { dictPath: "models/ppocr-rec-hi.dict.txt", numClasses: 169, recHeight: 48 },
  },

  // ── ViT: Florence-2 (the screen-understanding brain) ────────
  // One unified model: open-vocab detection, region caption,
  // caption-to-phrase grounding, OCR-with-region. Loaded by
  // @huggingface/transformers by repo id (it manages its own ORT).
  florence2: {
    id: "florence2",
    name: "Florence-2 base (ft)",
    kind: "transformersjs",
    purpose: "Semantic screen understanding + visual grounding (ViT).",
    repo: "onnx-community/Florence-2-base-ft",
    task: "image-text-to-text",
    dtypeByTier: { A: "fp16", B: "q4" }, // C skips Florence → OCR+DOM only
    // Measured totals for vision_encoder + encoder + decoder_merged + embed_tokens:
    //   fp32 1086 MB · fp16 544 MB · q4 333 MB
    // The engine picks by tier via dtypeByTier; this figure is the q4 case.
    sizeBytes: 333_000_000,
    minTier: "B",
    required: false,
  },

  // ── PII: GLiNER zero-shot NER (names/addresses regex can't get)
  "gliner-pii": {
    id: "gliner-pii",
    name: "GLiNER multi PII",
    kind: "onnx-remote",
    purpose: "ML entity extraction for PII (person, address, org, …).",
    urls: {
      default:
        "https://huggingface.co/onnx-community/gliner_multi_pii-v1/resolve/main/onnx/model.onnx",
      quantized:
        "https://huggingface.co/onnx-community/gliner_multi_pii-v1/resolve/main/onnx/model_quantized.onnx",
    },
    tokenizerRepo: "onnx-community/gliner_multi_pii-v1",
    sizeBytes: 210_000_000, // quantized ≈ 55MB (preferred at tier C)
    minTier: "C",
    required: false,
  },

  // ── Visual PII: real face detection (replaces YCbCr heuristic)
  "face-detector": {
    id: "face-detector",
    name: "BlazeFace (short range)",
    kind: "mediapipe",
    purpose: "Detect faces in the screenshot for redaction.",
    assetUrl:
      "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
    sizeBytes: 230_000,
    minTier: "C",
    required: false,
  },

  // ── Planner: fully in-browser LLM (WebGPU only) ─────────────
  "planner-webllm": {
    id: "planner-webllm",
    name: "Llama-3.2-1B (WebLLM)",
    kind: "webllm",
    purpose: "On-device action planning; nothing leaves the browser.",
    repo: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    sizeBytes: 880_000_000,
    minTier: "A",
    required: false,
  },
};

export const ALL_MODEL_IDS = Object.keys(MODEL_REGISTRY) as ModelId[];

const TIER_RANK: Record<Tier, number> = { C: 0, B: 1, A: 2 };

/** Is a model eligible to run at the given tier? */
export function modelEligibleAtTier(id: ModelId, tier: Tier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[MODEL_REGISTRY[id].minTier];
}

/** The default set of models to warm for a tier. */
export function defaultModelsForTier(tier: Tier): ModelId[] {
  return ALL_MODEL_IDS.filter((id) => modelEligibleAtTier(id, tier));
}

/** transformers.js dtype for a model at a tier, with a sane default. */
export function dtypeForTier(id: ModelId, tier: Tier): string {
  const e = MODEL_REGISTRY[id];
  return e.dtypeByTier?.[tier] ?? (tier === "A" ? "fp16" : "q4");
}
