# VLESS 2.0 — Rebuild Plan

**SIH 2026 · PS 26171 — On-device Visual Perception for Light-weight Browser Agents**

> Status: proposed. This supersedes the current architecture. It is written after a full audit
> that found the "on-device visual perception" to be **non-functional and never wired in**, the
> **privacy guarantee false** (PII interpolated into cloud prompts), and **~half the codebase dead**.
> This plan rebuilds the core to be genuinely elite, on-device, and provable.

---

## 0. Principles (non-negotiable)

1. **The vision model is the star, not decoration.** A real ViT reads the screen and drives grounding. This is criterion #1 (25%) and the literal PS requirement.
2. **PII never enters a prompt or a packet — ever, and we prove it.** Not a claim; a measured, DevTools-verifiable tripwire that *blocks* outbound requests containing detected PII.
3. **On-device decides.** Planning runs locally (WebLLM on WebGPU → Ollama on CPU → deterministic). The server is optional and receives only a redacted, structured, anonymized payload.
4. **Every layer runs on a CPU-only machine (degraded) and shines on WebGPU.** A hard degradation ladder, never a hard failure.
5. **No dead code shipped as a feature.** If it's in the pitch, it's on a live path with a test.
6. **Correctness is demonstrable.** Each subsystem has an acceptance test a judge could re-run.

---

## 1. Target architecture

Three execution contexts, each doing only what it *can* do in MV3 — this alone kills a whole class of current bugs (`document`/canvas/WebGPU in the service worker):

```
┌───────────────────────────────────────────────────────────────────────────┐
│ CONTENT SCRIPT (has DOM)                                                     │
│  • DOM extraction (structural prior)   • Action execution (native-setter)    │
│  • Visual overlay / PII boxes          • Outbound fetch/XHR tripwire hook     │
└───────────────▲───────────────────────────────────────────────┬────────────┘
                │ messages                                        │ actions
┌───────────────┴───────────────────────────────────────────────▼────────────┐
│ SERVICE WORKER (orchestrator only — no DOM, no canvas)                        │
│  • Task state machine + AbortController   • Tab pinning   • chrome.alarms     │
│  • captureVisibleTab()  • webRequest privacy ledger  • routing               │
└───────────────▲───────────────────────────────────────────────┬────────────┘
                │ frames + jobs                                   │ results
┌───────────────┴───────────────────────────────────────────────▼────────────┐
│ OFFSCREEN DOCUMENT (has WebGPU + OffscreenCanvas — the ML host)               │
│  • Florence-2 (ViT) grounding/detection   • PP-OCRv5 (correct plumbing)      │
│  • GLiNER PII NER   • BlazeFace faces      • Redaction canvas + verify        │
│  • WebLLM planner (WebGPU)                                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Data flow (one step):**
`captureVisibleTab` → offscreen decodes frame → **perceive** (DOM prior ⊕ OCR ⊕ ViT → ScreenGraph) → **detect PII** (regex+checksum ⊕ GLiNER ⊕ faces ⊕ OCR-region) → **redact** frame + build anonymized ScreenGraph → **verify redaction** (re-OCR) → **plan** (local; PII filled client-side by index) → **execute** (content script, native setters) → **verify** (DOM diff ⊕ URL ⊕ ARIA ⊕ *visual re-check*) → loop.

---

## 2. Elite tech stack per layer

| Layer | Elite choice | Why (vs. the "basic" option) | Runtime |
|---|---|---|---|
| Capture | `chrome.tabs.captureVisibleTab` + scroll-stitch for full page | Works from SW; no MediaStream/offscreen gymnastics; deterministic | SW |
| **Vision (ViT)** | **Florence-2-base-ft** (open-vocab detection, region caption, `<CAPTION_TO_PHRASE_GROUNDING>`, `<OCR_WITH_REGION>`) | One ViT does detection **and** grounding **and** OCR-region — a genuine screen-understanding model, not a heuristic | transformers.js v3 (WebGPU/WASM) |
| OCR | **PP-OCRv5-mobile** det+rec, **correct** DB post-proc + CTC + real char dicts (EN + Devanagari) | Fixes the garbage-output bugs; adds Hindi; feeds PII + grounding | onnxruntime-web |
| Icon/element detect | **YOLO-nano UI/icon detector** (OmniParser-style) as a fast prior | Catches icon-only controls Florence/DOM miss; tiny + CPU-fast | onnxruntime-web |
| **PII (text)** | **GLiNER `gliner_multi_pii-v1`** (zero-shot ML NER) **+** tightened regex with **checksums** (Aadhaar Verhoeff, Luhn, PAN/IFSC/UPI structure) | ML catches names/addresses; checksums kill false positives → precision leadership | transformers.js + local |
| **PII (visual)** | **BlazeFace / MediaPipe Face Detector** + OCR-region PII scan | Real ML faces (replaces YCbCr skin heuristic); catches PII rendered in images/canvas — the true differentiator | MediaPipe Tasks (WASM) |
| Redaction | OffscreenCanvas: black-box (critical), Gaussian blur (faces), pixelate (medium) **+ re-OCR verification** | Provably removes PII from pixels before any send — no competitor verifies | Offscreen doc |
| **Planner** | **WebLLM** (Llama-3.2-1B / Qwen2 q4f16, WebGPU) → **Ollama** (CPU) → **deterministic** form-fill | Fully local decision-making; offline-capable; PII filled by index locally | Offscreen (WebLLM) / SW |
| Execution | **Native-setter** value injection + full event sequence + fuzzy resolver | Works on React/Vue/Angular (current code silently fails on them) | Content |
| Verification | Multi-signal (DOM diff ⊕ URL ⊕ ARIA live) **+ visual re-check** via ViT | Closes perceive→act→perceive loop; catches "looked done but wasn't" | Content + offscreen |
| **Privacy proof** | `webRequest` ledger + content fetch/XHR wrapper + **PII tripwire that blocks** | Measured, not hardcoded; live ledger judges can verify in DevTools | SW + content |
| Memory | AES-256-GCM, **non-extractable** key, non-PII schemas only | Real at-rest crypto (current "encrypted" store is plaintext) | SW/IndexedDB |
| Voice (opt) | On-device Whisper-tiny (transformers.js) instead of Web Speech | Web Speech streams audio to Google — breaks "on-device" | Offscreen |

---

## 3. Salvage vs. delete

**Salvage (refactor, keep):**
- `perception/dom-extractor.ts` — solid structural extractor (becomes the DOM prior).
- `privacy/pii-detector.ts` — the **regex taxonomy** (15 Indian types) as the seed; add checksums + context gating + GLiNER fusion.
- `privacy/screenshot-redactor.ts` — correct OffscreenCanvas redaction; wire it to real capture + verification.
- WXT + React sidepanel scaffold, multi-provider LLM shell (best JSON parser), `scripts/download-models.mjs`.

**Delete (dead / broken, sold as features):**
`agent/brain.ts`, `agent/self-improving.ts`, `agent/recipes.ts`, `agent/history.ts`, `tab/orchestrator.ts`, `tab/workflow-engine.ts`, `actions/executor.ts` (superseded), `verification/multi-signal.ts` (rebuilt), `verification/visual-diff.ts`, `replay/deterministic-replay.ts`, `replay/replay-engine.ts`, `memory/store.ts`, `voice/command-listener.ts`, `perception/hybrid-perceiver.ts`, `models/runtime.ts`. (`memory/encrypted-store.ts` → fixed & reused.)

---

## 4. Phased build

Each phase ends with a runnable, testable artifact. No phase depends on a later one.

- **P0 — Foundations (additive, zero deletions).** Add offscreen document + message bus; add `transformers.js`, `onnxruntime-web`, `@mlc-ai/web-llm`, MediaPipe deps; model registry + Cache-API loader with progress; backend detector (WebGPU→WASM) + degradation ladder config. *Acceptance:* offscreen doc loads, a model downloads+caches, backend reported.
- **P1 — Capture + OCR, correct.** `captureVisibleTab` → offscreen decode; PP-OCRv5 with correct DB post-processing, CTC, real EN+Devanagari dicts. *Acceptance:* OCR reads a known screenshot with >90% char accuracy incl. Hindi; unit tests on decode.
- **P2 — ViT perception + ScreenGraph.** Florence-2 in offscreen (WebGPU); open-vocab detection + phrase grounding; fuse DOM ⊕ OCR ⊕ ViT (IoU + confidence) → `ScreenGraph`. *Acceptance:* "find the login button" grounds to correct box on 5 sample pages; canvas-rendered text appears in graph.
- **P3 — PII engine (precision-first).** Checksum-gated regex + GLiNER + BlazeFace + OCR-region scan → calibrated regions. *Acceptance:* labeled benchmark set; **precision AND recall both reported** (fix: current tests measure recall only); false-positive suite passes (no bare `\d{3}`/`\d{10}` hits).
- **P4 — Redaction + verification + provable privacy.** Offscreen redaction by sensitivity; **re-OCR verify**; webRequest ledger + fetch/XHR tripwire that **blocks** PII. *Acceptance:* redacted frame has zero PII on re-OCR; DevTools shows only anonymized payload leaving; tripwire blocks an injected leak.
- **P5 — On-device planner.** Deterministic form-fill (PII filled locally by index) + WebLLM (WebGPU) + Ollama fallback; PII never in prompt. *Acceptance:* fills the synthetic passport form end-to-end offline; prompt inspection shows only placeholders + indices.
- **P6 — Execution + task loop, robust.** Native-setter injection; tab pinning; AbortController↔CANCEL; alarms keepalive; stable element ids. *Acceptance:* fills a real React form (e.g. a live gov-style demo); CANCEL stops mid-task; survives a navigation.
- **P7 — Verification loop + memory.** Content-side multi-signal + ViT visual re-check; non-extractable AES-GCM memory (non-PII schemas). *Acceptance:* a failed click is detected and retried; memory round-trips encrypted.
- **P8 — Demo polish.** Live privacy ledger UI, perception overlay, latency/resource HUD, judge demo script; Firefox build; README/ARCHITECTURE rewritten to match reality.

---

## 5. Jaw-dropping features (genuine innovation)

1. **Provable zero-leak privacy** — a live outbound ledger + a PII tripwire that *blocks* any request containing detected PII. Not "trust us"; verifiable in DevTools, on stage.
2. **Redaction verification loop** — we re-OCR the redacted frame and mathematically assert PII is gone from the pixels *before* anything is sent. No known competitor does this.
3. **Tri-signal perception** — DOM ⊕ OCR ⊕ ViT catches PII and controls rendered in **canvas / images / PDFs** that DOM-only agents (and Operator/Computer-Use) miss.
4. **Visual action verification** — the same ViT confirms the click actually produced the intended change (perceive→act→perceive).
5. **100% offline decision path** — WebLLM/Ollama; works with the network cable pulled. The ultimate privacy demo.
6. **Indian-PII precision leadership** — checksum-validated Aadhaar/PAN/IFSC/UPI + GLiNER names/addresses.

---

## 6. Mapping to evaluation criteria

| Criterion | Wt | How we win |
|---|---|---|
| Visual context accuracy | 25% | Real ViT (Florence-2) grounding + OCR + DOM fusion → ScreenGraph; handles canvas/SPA/PDF |
| PII recall/precision | 20% | GLiNER + checksum regex + faces + OCR-region; precision *and* recall benchmarked |
| Redaction precision | 20% | Sensitivity-matched redaction **verified by re-OCR**; connected to the real send path |
| Client resource utilization | 20% | Quantized models, lazy load, Cache API, WebGPU→WASM ladder; HUD reports peak mem/latency |
| End-to-end latency | 15% | DOM fast-path first; ViT only when needed; async pipeline; measured HUD |

---

## 7. Risks & degradation ladder

- **Tier A (WebGPU, modern):** Florence-2 + WebLLM in-browser — full experience.
- **Tier B (WASM SIMD / weak iGPU):** Florence-2-base q4 on WASM (slower) *or* OCR+YOLO detector; planner via Ollama.
- **Tier C (CPU only — your dev machine):** PP-OCR-mobile int8 + tightened DOM + YOLO-nano on WASM; deterministic/Ollama planner; Florence optional. **Still fully functional.**
- First-load model download is large → Cache API + progress UI + optional pre-bundle of the smallest models.
- Florence latency on CPU is high → gated behind DOM fast-path; only invoked for ambiguous/canvas regions.

---

## 8. Judge demo script (90 seconds)

1. Open a synthetic Aadhaar/PAN form with a face photo. Hit run.
2. Overlay lights up: ViT-grounded elements + PII boxes (Aadhaar/PAN/face) with confidence.
3. Show the redacted frame: face blurred, IDs black-boxed; ledger shows re-OCR = "0 PII in pixels."
4. Open DevTools Network: only an anonymized ScreenGraph leaves (or nothing, if fully local). Trip the tripwire with a planted value → request **blocked**.
5. Form fills itself; visual verify confirms; latency/resource HUD shown.
6. Pull the network cable; run again → still works (local planner).
