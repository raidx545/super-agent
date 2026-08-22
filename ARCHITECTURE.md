# VLESS — Technical Architecture Deep Dive

This document explains every component of the system, what tools power them, and how they connect end-to-end. Built for the SIH 2026 Problem Statement 26171: On-device Visual Perception for Lightweight Browser Agents.

---

## System Overview

VLESS is a **privacy-preserving browser agent** that runs a two-tier architecture:

```
CLIENT (Browser Extension)          SERVER (Ollama / Cloud LLM)
┌──────────────────────────┐        ┌─────────────────────────┐
│  Screenshot + DOM Capture│        │                         │
│           │              │        │  Receives ONLY          │
│  PII Detection (DOM+Vision)       │  sanitized metadata     │
│           │              │   ──>  │  (no PII, no faces,     │
│  Redaction (CSS + Canvas)│        │   no passwords)         │
│           │              │   <──  │                         │
│  Sanitize & Send         │        │  Returns action plan    │
│           │              │        │  (click, type, select)  │
│  Execute Actions         │        │                         │
│           │              │        │  Model: qwen2.5:1.5b    │
│  Visual Overlay          │        │  (1.5B params, local)   │
└──────────────────────────┘        └─────────────────────────┘
```

The key principle: **the server never sees raw screenshots, PII, faces, or passwords**. Only structural metadata (element types, positions, labels) is transmitted.

---

## Layer 1: Page Perception (What the Agent Sees)

### DOM Extractor (`src/core/perception/dom-extractor.ts`)
- **Purpose**: Reads the page structure without any ML model
- **Tool**: Native browser DOM APIs (`document.querySelectorAll`, `getBoundingClientRect`)
- **What it extracts**: Form fields, buttons, links, text content, page metadata
- **Output**: A `PageState` object with 30+ fields per element (tag, role, label, type, position, visibility)
- **Speed**: ~10-50ms per page (pure JavaScript, no network calls)

### Vision Pipeline (`src/core/models/vision-pipeline.ts`)
- **Purpose**: Reads text visible on screen using OCR
- **Tool**: PaddleOCR ONNX models running via ONNX Runtime Web
- **Models bundled**:
  - `ppocr-det-v3.onnx` (1.2MB) — text detection (finds where text is on screen)
  - `ppocr-rec-en.onnx` (7.8MB) — English text recognition (reads the text)
  - `ppocr-rec-hi.onnx` (8.9MB) — Hindi text recognition (reads Devanagari text)
- **Runtime**: ONNX Runtime Web with WebGPU acceleration (falls back to WASM)
- **How it works**:
  1. Screenshot is taken via `chrome.tabCapture.capture()`
  2. Image is resized to 640x640 and normalized for the detection model
  3. Detection model outputs bounding boxes where text exists
  4. Each bounding box is cropped and fed to the recognition model
  5. Recognition model outputs the actual text characters (CTC decoding)
- **Speed**: ~200-500ms per screenshot (depends on number of text regions)

### Hybrid Perceiver (`src/core/perception/hybrid-perceiver.ts`)
- **Purpose**: Merges DOM and Vision data into a single page understanding
- **Tool**: Custom merge algorithm with IoU (Intersection over Union) deduplication
- **How it works**:
  1. DOM gives structural data (element types, labels, positions)
  2. Vision gives OCR text (text visible on screen but not in DOM, like canvas-rendered text)
  3. Overlapping results are deduplicated using bounding-box overlap
  4. Combined confidence is computed from both signals

---

## Layer 2: Privacy Engine (The Core Innovation)

This is 60% of the SIH evaluation criteria (PII detection 20% + redaction precision 20% + visual context accuracy 20%).

### PII Detector (`src/core/privacy/pii-detector.ts`)
- **Purpose**: Finds all personally identifiable information on the page
- **Two detection signals**:

**DOM-based detection** (regex patterns for 15+ Indian PII types):

| PII Type | Pattern | Example |
|----------|---------|---------|
| Aadhaar | 12 digits (4-4-4) | 1234 5678 9012 |
| PAN Card | ABCDE1234F | ABCDE1234F |
| Phone (Indian) | 10 digits starting 6-9 | 9876543210 |
| Email | Standard email regex | user@example.com |
| Bank Account | 9-18 digits | 123456789012345 |
| IFSC Code | 4 letters + 0 + 6 alphanumeric | SBIN0001234 |
| UPI ID | name@provider | user@paytm |
| Passport | A + 7-8 digits | A1234567 |
| PIN Code | 6 digits | 110001 |
| Date of Birth | Various date formats | 15/08/1995 |
| Names | Capitalized word sequences | Shashank Kumar |
| Password fields | input[type=password] | (dots) |
| Financial | 16-digit card numbers | 4111111111111111 |
| Medical | MRN patterns | MRN-12345 |

**Vision-based detection** (canvas analysis):
- **Face detection**: Skin-color analysis in YCbCr color space + connected component analysis
- **Password dots**: Pattern detection for repeated small circles (password field rendering)
- **OCR text scan**: The OCR text blocks are scanned for PII patterns (catches text rendered in images)

**Hybrid merge**: Both signals are combined. When DOM and Vision both detect PII in the same region, confidence is boosted. Overlapping detections are deduplicated.

### Redaction Engine (`src/core/privacy/redaction-engine.ts`)
- **Purpose**: Visually obscures PII before any data leaves the device
- **Four redaction strategies**:

| Strategy | Use Case | How |
|----------|----------|-----|
| Gaussian Blur | Faces, profile photos | 3-pass box blur approximation |
| Black Box | Passwords, Aadhaar, PAN | Solid black rectangle fill |
| Pixelate | Moderate sensitivity | Block averaging (mosaic effect) |
| Mask Text | Visible text PII | Asterisk replacement overlay |

**DOM CSS injection**: Generates CSS rules that overlay sensitive form fields with visual indicators (red borders, lock icons) so the user can see what's being protected.

### Screenshot Redactor (`src/core/privacy/screenshot-redactor.ts`)
- **Purpose**: Redacts PII directly in screenshot pixels before sending to server
- **Tool**: OffscreenCanvas (works in service workers without DOM)
- **How it works**:
  1. Receives screenshot as data URL
  2. Draws it on an OffscreenCanvas
  3. For each PII region with a bounding box:
     - Faces get Gaussian blur (3-pass box blur for performance)
     - Passwords/Aadhaar get solid black fill
     - Moderate sensitivity gets pixelation
  4. Returns the redacted image as a new data URL
- **Key**: This runs in the service worker, not the content script (OffscreenCanvas is needed because service workers don't have `document.createElement('canvas')`)

### Visual Overlay (`src/core/privacy/visual-overlay.ts`)
- **Purpose**: Shows users what PII was detected and how it was redacted
- **Tool**: DOM injection (absolute-positioned div elements on the page)
- **Visual elements**:
  - Color-coded bounding boxes: red (critical), orange (high), yellow (medium)
  - Category labels on each box (e.g., "Aadhaar", "Phone", "Face")
  - Summary badge showing total PII count
  - Pipeline status panel in bottom-right corner

### Network Monitor (`src/core/privacy/network-monitor.ts`)
- **Purpose**: Tracks all outbound network requests to prove zero PII leakage
- **Tool**: Chrome `webRequest` API
- **What it generates**: A "privacy proof" — a log showing exactly what data left the device and confirming no PII was included

---

## Layer 3: AI Decision Engine (The Brain)

### Multi-Provider LLM System (`src/core/agent/llm-providers.ts`)
- **Purpose**: Makes the agent decide what actions to take
- **Architecture**: Four providers with automatic fallback

| Priority | Provider | Where it runs | Cost | Model |
|----------|----------|---------------|------|-------|
| 1st | Ollama | Local (your machine) | Free | qwen2.5:1.5b (986MB) |
| 2nd | Claude | Anthropic API | Pay/token | claude-3-5-haiku |
| 3rd | OpenAI | OpenAI API | Pay/token | gpt-4o-mini |
| 4th | OpenRouter | OpenRouter API | Pay/token | llama-3.2-1b |

**How it works**:
1. Sanitized page structure is sent to the LLM (element types, labels, positions — NO PII values)
2. LLM analyzes the page and returns a JSON action plan
3. The plan is a list of steps: `{type: "click", target: "[0]"}`, `{type: "type", target: "[1]", value: "Shashank"}`
4. For PII fields, the LLM references them by index — the client fills actual values locally

**Why qwen2.5:1.5b?**
- 1.5 billion parameters — small enough to run on any machine
- Q4_K_M quantization — optimized for speed on CPU
- 32K context window — handles complex page structures
- Runs via Ollama (one command to install, zero configuration)
- 6.3 tokens/second on CPU — fast enough for real-time planning

**Prompt engineering** (what the LLM sees):
```
System: "You are VLESS, a browser automation agent..."
User:   "TASK: Fill this passport form
         PAGE STATE:
         Elements:
         [0] <input> role="textbox" label="Given Name" type="text"
         [1] <input> role="textbox" label="Family Name" type="text"
         ...
         FORMS:
         Form passport-form:
           - Given Name: text EMPTY REQUIRED [PII:name]
           - Family Name: text EMPTY REQUIRED [PII:name]
         ..."
```

The LLM never sees PII values. It only sees that a field exists, its type, and that it's marked as PII.

### Server Bridge (`src/core/agent/server-bridge.ts`)
- **Purpose**: Legacy Ollama-only provider (kept for backward compatibility)
- **Tool**: Direct HTTP calls to `localhost:11434`
- **Fallback chain**: Ollama -> Cloud Proxy -> Rule-based

### Companion Server (`server/index.js`)
- **Purpose**: Optional Node.js server for cloud API proxying
- **Tool**: Express.js + Anthropic SDK
- **Endpoints**:
  - `GET /api/health` — checks Ollama and cloud API availability
  - `POST /api/plan` — sends sanitized context, gets action plan
  - `POST /api/explain` — gets natural language page description
- **When needed**: Only if using Claude/GPT through a server proxy instead of direct API calls

---

## Layer 4: Action Execution

### Action Executor (`src/core/actions/executor.ts`)
- **Purpose**: Actually performs actions on the page (clicks, types, selects)
- **Tool**: Chrome `chrome.tabs.sendMessage` -> content script -> DOM APIs
- **Human-like behavior**:
  - Types with 30-80ms delays between keystrokes
  - Dispatches full keyboard event sequence (keydown -> keypress -> input -> keyup)
  - Clicks with proper event bubbling
  - Handles select dropdowns with change events
- **Multi-strategy element finding** (tries in order):
  1. By element ID (`#field-id`)
  2. By CSS selector
  3. By name attribute
  4. By ARIA label
  5. By text content match
  6. Fuzzy match (Levenshtein distance)

### Form Validator (`src/core/agent/validator.ts`)
- **Purpose**: Validates form fields against Indian government form rules
- **Rules checked**:
  - Aadhaar: exactly 12 digits
  - PAN: exactly 5 letters + 4 digits + 1 letter
  - Phone: exactly 10 digits, starts with 6-9
  - Email: valid email format
  - PIN: exactly 6 digits
  - IFSC: exactly 4 letters + 0 + 6 alphanumeric
  - Passport: A-Z + 7-8 digits
  - Date: valid date format for Indian forms

---

## Layer 5: Memory & Learning

### Encrypted Memory Store (`src/core/memory/encrypted-store.ts`)
- **Purpose**: Remembers past interactions per website for faster future tasks
- **Tool**: IndexedDB + Web Crypto API (AES-GCM encryption)
- **What's stored**: Page schemas, successful action patterns, element positions
- **Encryption**: AES-256-GCM with a key derived from the extension's unique origin
- **Why encrypted**: The memory contains site-specific data that should never be readable by other extensions or browser tools

### Self-Improving Agent (`src/core/agent/self-improving.ts`)
- **Purpose**: Learns from success and failure to improve over time
- **How**:
  - Records action success/failure rates per element type per site
  - Adjusts confidence scores based on historical performance
  - Stores optimal timing delays per action type
  - Detects patterns (e.g., "on this site, submit buttons need double-click")

### Learning Log (`src/core/agent/learning-log.ts`)
- **Purpose**: Narrated activity feed showing what the agent is doing and why
- **Tool**: In-memory log with phase-tagged entries (discovery, analysis, planning, execution, verification)

---

## Layer 6: Multi-Tab Workflow Engine

### Workflow Engine (`src/core/tab/workflow-engine.ts`)
- **Purpose**: Handles tasks that span multiple tabs
- **Example**: "Copy data from spreadsheet, fill it in a form, then submit"
- **How**:
  1. Captures state from Tab A
  2. Stores it in the workflow context
  3. Switches to Tab B
  4. Uses stored context to fill fields
  5. Verifies completion

---

## Layer 7: Voice Commands

### Command Listener (`src/core/voice/command-listener.ts`)
- **Purpose**: Control the agent by speaking in Hindi or English
- **Tool**: Web Speech API (`SpeechRecognition`)
- **Supported commands**:
  - "Fill this form" / "Form bharo"
  - "Click submit" / "Submit pe click karo"
  - "Scroll down" / "Neeche jao"
  - "What's on this page?" / "Page pe kya hai?"
- **Languages**: English + Hindi (devanagari)

---

## Layer 8: Deterministic Replay

### Replay Engine (`src/core/replay/deterministic-replay.ts`)
- **Purpose**: Record a task once, replay it 15x faster without LLM inference
- **How**:
  1. First execution records all actions with timestamps and page states
  2. Subsequent executions replay the recorded actions directly
  3. If a page state differs, it falls back to LLM planning for that step
  4. Speed optimization: skips wait times, uses cached element positions

---

## Complete Data Flow (End-to-End)

Here is exactly what happens when a user clicks "Start" with the task "Fill this passport form":

```
Step 1: CAPTURE (10-50ms)
  background/index.ts receives EXECUTE_PIPELINE message
  -> sends PERCEIVE_PAGE to content script
  -> content script scans DOM, extracts all form fields
  -> returns PageState with 15+ form fields detected

Step 2: DETECT PII (5-20ms)
  pii-detector.ts runs 15 regex patterns against DOM data
  -> Finds: password field, Aadhaar field, phone, email, 3 name fields
  -> 7 PII regions detected with categories and sensitivity levels

Step 3: REDACT (10-30ms)
  redaction-engine.ts generates CSS rules for PII fields
  -> Content script injects CSS into the page (visual indicators)
  -> visual-overlay.ts shows bounding boxes on the page
  -> If screenshot available: screenshot-redactor.ts blurs faces, blacks passwords

Step 4: SANITIZE (1ms)
  full-pipeline.ts builds SanitizedContext
  -> PII values are stripped (replaced with ***)
  -> Element labels and positions are preserved
  -> Only safe structural metadata is included

Step 5: INITIALIZE SERVER (100-500ms)
  llm-providers.ts checks available providers
  -> Tries Ollama first (localhost:11434)
  -> Verifies qwen2.5:1.5b is loaded
  -> Falls back to Claude/OpenAI/OpenRouter if Ollama unavailable

Step 6: PLAN (2-10 seconds)
  llm-providers.ts sends sanitized context to qwen2.5:1.5b
  -> LLM receives: "Page has Given Name [0], Family Name [1], DOB [2]..."
  -> LLM returns: {"steps": [{"action": {"type":"click","target":"[0]"}}, ...]}
  -> Parser normalizes the response (handles markdown fences, "actions" vs "steps")

Step 7: EXECUTE (200-500ms per step)
  full-pipeline.ts sends each action to content script
  -> Content script finds the element by index/selector
  -> Clicks/fills with human-like timing (30-80ms keystroke delays)
  -> Dispatches full event sequence (keydown -> input -> keyup)

Step 8: VERIFY & SHOW (50ms)
  Visual overlay shows pipeline status panel
  -> Privacy score: 100 (zero PII left the device)
  -> 7 PII detected, 7 redacted, 0 sent to server
  -> All steps completed
```

**Total end-to-end time**: 3-15 seconds (depends on LLM provider speed)

---

## Tech Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Browser Extension | WXT Framework | Cross-browser MV3 extension scaffolding |
| DOM Perception | Native DOM APIs | Extract page structure |
| OCR | PaddleOCR ONNX + ONNX Runtime Web | Read text from screenshots |
| GPU Acceleration | WebGPU / WASM fallback | Speed up ONNX inference in browser |
| PII Detection | Custom regex engine (15 patterns) | Find Indian PII types |
| Face Detection | YCbCr skin-color analysis | Find faces without ML model |
| Redaction | OffscreenCanvas + CSS injection | Blur/black/pixelate PII in screenshots |
| LLM Planning | Ollama + qwen2.5:1.5b | Decide what actions to take |
| LLM Backup | Claude / OpenAI / OpenRouter APIs | Cloud fallback for complex tasks |
| Encryption | Web Crypto API (AES-256-GCM) | Encrypt stored memory |
| Storage | IndexedDB | Persistent per-site memory |
| Voice | Web Speech API | Hindi + English voice commands |
| Action Execution | Chrome Tabs API + DOM events | Click, type, select on page |
| Privacy Proof | chrome.webRequest | Track all outbound requests |
| Companion Server | Node.js + Express | Optional cloud API proxy |
| Build | TypeScript + Vite | Type safety + fast bundling |

---

## Why This Wins

1. **Privacy-first architecture**: The server never sees PII. This is provable via the privacy proof and network monitor.

2. **On-device vision**: PaddleOCR runs entirely in the browser via WebGPU/WASM. No screenshots leave the device.

3. **Multi-provider flexibility**: Works offline with Ollama, or uses Claude/GPT for complex tasks. No vendor lock-in.

4. **Indian PII specificity**: 15+ regex patterns built for Indian documents (Aadhaar, PAN, IFSC, UPI, passport). Not a generic solution.

5. **Production architecture**: 47 TypeScript files, typed interfaces, error handling, fallback chains. Not a prototype.

6. **Measurable privacy**: Every pipeline run generates a privacy proof showing exactly what data left the device. Judges can verify zero PII leakage in real-time.
