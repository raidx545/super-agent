# 🐾 VLESS — On-Device Browser Agent

> **Privacy-preserving AI that sees your screen, understands your intent, and automates web tasks — without sending a single pixel to the cloud.**

Built for **SIH 2026 — Problem Statement SIH26171**: On-device Visual Perception for Lightweight Browser Agents.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CHROME EXTENSION                          │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  SIDE PANEL (React + TailwindCSS)                    │    │
│  │  • Task input with natural language                  │    │
│  │  • Agent status + progress bar                       │    │
│  │  • Reasoning trace (what the agent is thinking)      │    │
│  │  • Page inspector (what the agent sees)              │    │
│  │  • Visual debug overlay toggle                       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  CONTENT SCRIPT (runs on every page)                 │    │
│  │  • DOM extraction engine                             │    │
│  │  • Action execution (click, type, scroll, etc.)      │    │
│  │  • Visual debug overlay (bounding boxes)             │    │
│  │  • Honeypot + CAPTCHA detection                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  BACKGROUND SERVICE WORKER                           │    │
│  │  • Agent brain (ReAct loop)                          │    │
│  │  • Intent compiler                                   │    │
│  │  • Action planning                                   │    │
│  │  • Memory management                                 │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  ON-DEVICE ML (ONNX Runtime Web)                     │    │
│  │  • PaddleOCR (15MB) — text extraction                │    │
│  │  • UI Detector (25MB) — element detection            │    │
│  │  • WebGPU acceleration (when available)              │    │
│  │  • WASM fallback (universal support)                 │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  MEMORY (IndexedDB — encrypted at rest)              │    │
│  │  • Site memory graph (page structures, form schemas) │    │
│  │  • Action patterns (what worked, what didn't)        │    │
│  │  • Navigation flows (page A → page B → page C)       │    │
│  │  • User preferences (saved form data)                │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18
- pnpm

### Setup

```bash
# Install dependencies
pnpm install

# Start development mode
pnpm wxt

# Build for production
pnpm wxt build
```

### Load in Chrome

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `.output/chrome-mv3/`

---

## ✨ Features

### Core (What Makes Us Different)

| Feature | Description |
|---------|-------------|
| **Hybrid DOM+Vision Perception** | Uses DOM when available (fast), visual fallback when needed (universal). Nobody else does this. |
| **On-Device Inference** | All ML runs in browser via ONNX Runtime Web. Zero data leaves the device. |
| **Multi-Signal Verification** | After every action, verify it worked using DOM diff, URL change, error check, and accessibility tree. |
| **Visual Debug Overlay** | Color-coded bounding boxes showing what the agent "sees" — green (confident), yellow (uncertain), red (low confidence). |
| **Encrypted Memory** | Site memory graph stored in IndexedDB. Remembers page structures, form schemas, and navigation flows across sessions. |

### Agent Intelligence

| Feature | Description |
|---------|-------------|
| **ReAct Agent Loop** | Observe → Think → Act → Verify → Reflect cycle with self-correction. |
| **Intent Compiler** | Transforms vague natural language ("fill this form") into precise action plans. |
| **Reasoning Trace** | Every decision logged with full reasoning and confidence scores — complete transparency. |
| **Error Recovery** | If an action fails, tries alternative approaches automatically. |

### Actions

Click, type, scroll, navigate, select, hover, keyboard shortcuts, form fill, multi-tab orchestration.

### Safety

Honeypot detection, CAPTCHA detection, payment form detection, user confirmation for high-risk actions.

---

## 🧠 How It Works

### 1. Perception
The agent perceives the page using a **hybrid approach**:
- **DOM extraction** (fast, ~10ms): Extracts all interactive elements, forms, labels from the DOM
- **Visual perception** (universal, ~200ms): Falls back to ONNX models when DOM is insufficient (canvas apps, PDFs, complex SPAs)

### 2. Planning
The **intent compiler** transforms your natural language request into a precise action plan:
```
"Fill this form with my resume data"
→ Click "Name" field → Type "Shashank Tomar"
→ Click "Email" field → Type "shashank@example.com"
→ ... (12 more steps)
→ Verify all fields filled correctly
```

### 3. Execution
Actions are executed via DOM injection with **human-like pacing**:
- Character-by-character typing (not paste)
- Realistic delays between actions
- Scroll-into-view before clicking

### 4. Verification
After every action, **4 independent signals** confirm it worked:
- DOM diff (did the page change as expected?)
- URL change (did navigation happen?)
- Error check (any error messages?)
- Accessibility tree (ARIA status messages?)

### 5. Memory
The agent **remembers** what it learned:
- "On passport.seva.gov.in, the submit button is at the bottom right"
- "This form needs exactly 12 digits for Aadhaar"
- "After filling page 1, click 'Next' to go to page 2"

---

## 🔒 Privacy

| What Leaves the Browser | What Never Leaves |
|------------------------|-------------------|
| Task description | Screenshots |
| Action plan | Page text content |
| Structural metadata | Form field values |
| Error reports | Visual model outputs |

**Zero network requests during operation.** Open DevTools → Network tab to verify.

---

## 📊 Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome Manifest V3 |
| Build | WXT + Vite |
| UI | React 19 + TailwindCSS 3 |
| Language | TypeScript (strict) |
| ML Runtime | ONNX Runtime Web (WebGPU/WASM) |
| Models | PaddleOCR, Custom UI Detector |
| Storage | IndexedDB (via idb) |
| Testing | Vitest |

---

## 📁 Project Structure

```
src/
├── entrypoints/           # WXT entry points
│   ├── background/        # Service worker
│   ├── content/           # Content script
│   └── sidepanel/         # Side panel UI
├── core/                  # Core engine
│   ├── perception/        # DOM extraction
│   ├── agent/             # ReAct brain
│   ├── actions/           # Action execution
│   ├── verification/      # Multi-signal verification
│   ├── memory/            # Encrypted IndexedDB storage
│   └── models/            # ONNX Runtime integration
├── ui/                    # React components
│   ├── components/        # App, TaskInput, ReasoningTrace, etc.
│   └── styles/            # Global CSS
├── types/                 # TypeScript types
└── utils/                 # Shared utilities
```

---

## 🎯 SIH 2026 — Why This Wins

1. **Nobody has done this.** Every browser agent sends screenshots to the cloud. We're the first to do on-device visual perception in a browser extension.

2. **Hybrid DOM+Vision.** We use the fast path (DOM) when possible and fall back to vision when needed. More accurate than either alone.

3. **Verifiable privacy.** Zero network requests during operation. Judges can see this in DevTools. This is a proof, not a promise.

4. **Production-grade.** Error recovery, memory, multi-signal verification, adversarial robustness. Not an MVP — a product.

5. **Real impact.** Government employees filling forms, accessibility for visually impaired, enterprise automation with data sovereignty.

---

## 📝 License

MIT — Built for SIH 2026
