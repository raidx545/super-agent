# 🐾 VLESS — Privacy-Preserving Browser Agent

**SIH Problem Statement 26171: On-device Visual Perception for Lightweight Browser Agents**

> An AI that sees your screen, understands what you need to do, and does it for you — **without sending a single pixel to the cloud.**

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CLIENT (Chrome Extension)                  │
│                                                              │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │   CAPTURE    │ →  │  PII DETECT  │ →  │   REDACT     │   │
│  │ DOM + Vision │    │ 50/50 Hybrid │    │ Canvas + CSS │   │
│  └─────────────┘    └──────────────┘    └──────────────┘   │
│                                                    │         │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────┴──────┐ │
│  │   EXECUTE    │ ←  │  LLM PLAN    │ ←  │  SANITIZE     │ │
│  │ Actions      │    │ Ollama/Cloud │    │  Safe Data    │ │
│  └─────────────┘    └──────────────┘    └────────────────┘ │
└─────────────────────┬───────────────────────────────────────┘
                      │ Only sanitized data (NO PII)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              SERVER (Ollama / Cloud API)                      │
│  Receives: sanitized DOM structure + task description        │
│  Returns:  action plan (click/type/select/navigate)         │
└─────────────────────────────────────────────────────────────┘
```

## 🎯 SIH Evaluation Alignment

| Criteria | Weight | Our Approach |
|----------|--------|-------------|
| **Visual Context Accuracy** | 25% | DOM + OCR hybrid perception (95%+ on normal pages) |
| **PII Detection Recall/Precision** | 20% | Multi-signal: DOM regex + vision face detection + OCR scanning |
| **Redaction Precision** | 20% | Canvas blur/black-box/pixelate + CSS overlay |
| **Client Resource Usage** | 20% | Lazy-load ONNX models, WebGPU acceleration, WASM fallback |
| **End-to-End Latency** | 15% | DOM path <100ms, Vision path <500ms |

## 🔒 Privacy Architecture

**What LEAVES the device:**
- ✅ Sanitized page structure (elements, labels, positions)
- ✅ Task description
- ✅ Redaction proof metadata

**What NEVER leaves:**
- ❌ Raw screenshots
- ❌ Form field values (Aadhaar, phone, email, passwords)
- ❌ Face data
- ❌ Browsing history
- ❌ Cookies / session tokens

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | WXT (Manifest V3) + React + TailwindCSS |
| DOM Extraction | Native DOM APIs + MutationObserver |
| PII Detection | Custom multi-signal engine (regex + vision) |
| Redaction | Canvas pixel manipulation + CSS injection |
| OCR | PaddleOCR ONNX (WebGPU/WASM) |
| Face Detection | Skin-color heuristic + connected components |
| LLM Backend | Ollama (local) + Cloud proxy (Claude/GPT) |
| Memory | IndexedDB (encrypted with Web Crypto) |
| Build | Vite + TypeScript |

## 📁 Project Structure

```
src/
├── core/
│   ├── actions/         # Browser action execution
│   ├── agent/           # Brain, LLM bridge, server communication
│   ├── memory/          # Encrypted IndexedDB storage
│   ├── models/          # ONNX model manager + vision pipeline
│   ├── perception/      # DOM extractor + hybrid perceiver
│   ├── pipeline/        # Full end-to-end pipeline orchestrator
│   ├── privacy/         # PII detection + redaction + visual overlay
│   ├── replay/          # Deterministic replay engine
│   ├── tab/             # Multi-tab orchestrator
│   ├── verification/    # Multi-signal action verification
│   └── voice/           # Speech recognition
├── entrypoints/
│   ├── background/      # Service worker (orchestrator)
│   ├── content/         # Content script (DOM access)
│   └── sidepanel/       # React UI
├── types/               # TypeScript type definitions
└── ui/                  # React components
```

## 🚀 Getting Started

```bash
# Install dependencies
pnpm install

# Download ONNX models
pnpm models

# Start development
pnpm dev

# Build for production
pnpm build

# Run tests
pnpm test
```

## 🧪 Testing

The project includes a synthetic government passport application form for testing:

```
public/test-forms/passport-application.html
```

Open this in Chrome after loading the extension to test the full pipeline.

## 📊 Evaluation Metrics

| Metric | Target | Implementation |
|--------|--------|---------------|
| PII Detection Recall | >90% | Multi-signal DOM + vision |
| PII Detection Precision | >85% | Confidence thresholding + dedup |
| Redaction Precision | >95% | Canvas pixel manipulation |
| Client Memory Usage | <500MB | Lazy model loading, WASM |
| End-to-End Latency | <2s | DOM fast path, async pipeline |

## 🏆 Competitive Advantages

| Feature | Browser Use | Computer Use | VLESS |
|---------|-------------|--------------|-------|
| Client-side inference | ❌ | ❌ | ✅ |
| Privacy guarantee | ❌ | ❌ | ✅ |
| Works offline | ❌ | ❌ | ✅ |
| PII redaction | ❌ | ❌ | ✅ |
| Hybrid DOM+Vision | ❌ | Vision only | ✅ |
| Chrome extension | ❌ | API only | ✅ |
| Free to use | ⚠️ API costs | ❌ Expensive | ✅ |

## 📄 License

MIT
