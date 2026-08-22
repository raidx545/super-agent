# 🐾 Super Agent — Setup Guide

## Quick Start (5 minutes)

### Step 1: Load the Extension in Chrome

```
1. Open chrome://extensions/
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select the .output/chrome-mv3/ folder from this project
5. Pin the extension to your toolbar
```

### Step 2: Open Any Real Website

```
1. Open any website with a form:
   - https://www.google.com (login form)
   - https://passport.india.gov.in (government form)
   - https://amazon.in (checkout form)
   - Any local HTML form
2. Click the VLESS extension icon → side panel opens
```

### Step 3: Test It

```
1. Type: "fill this form" or "click login" or "scroll down"
2. Press Enter or click Run
3. Watch the Learning Log narrate what's happening
4. Check Privacy Monitor → "Zero outbound requests"
```

**That's it!** The extension works without any models or Ollama — it uses DOM extraction (handles 95% of pages).

---

## Full Setup (With AI Models)

### Install Ollama (For Intelligent Planning)

Without Ollama, the agent uses rule-based planning (works but less smart).
With Ollama, the agent uses a real LLM to understand and plan.

```
1. Download Ollama: https://ollama.com/download
2. Install and run Ollama
3. Open terminal and run:
   ollama pull llama3.2
   (This downloads a 2GB model for AI planning)
4. Ollama runs on http://localhost:11434
5. The extension auto-detects it on startup
```

### Download Vision Models (For Visual Perception)

The agent works without vision models (DOM extraction is sufficient for 95% of pages).
Vision models add the ability to "see" canvas apps, PDFs, and image-heavy pages.

```
1. Open the extension side panel
2. Click the 👁️ Models tab
3. Click "Download All" (~10MB)
4. Wait for download to complete
5. Models are cached in the browser (fast reload)
```

Models used:
- PaddleOCR Detection v3 (2.3MB) — finds text regions
- PaddleOCR English Recognition (7.5MB) — reads English text
- PaddleOCR Hindi Recognition (8.6MB) — reads Hindi text (optional)

Source: https://huggingface.co/monkt/paddleocr-onnx (Apache 2.0)

---

## What Each Feature Does

| Tab | What It Does |
|-----|-------------|
| 🎯 Task | Type natural language tasks ("fill form", "click login") |
| 👁️ Models | Download/manage ONNX vision models |
| 🧠 Learn | Real-time narrated feed of agent's decisions |
| 🔒 Privacy | Visual proof that zero data leaves your browser |
| 🎙️ Voice | Voice commands in Hindi + English |
| 📋 Debug | Full reasoning trace with timing |

---

## Testing on Real Government Forms

For the SIH demo, test on:

1. **Passport Application**: https://portal2.passportindia.gov.in
2. **Income Tax Filing**: https://www.incometax.gov.in
3. **Aadhaar Update**: https://uidai.gov.in
4. **GST Registration**: https://www.gst.gov.in

The agent will:
- Scan the page and find all form fields
- Plan which fields to fill
- Fill each field with provided data
- Verify each action worked
- Report results with privacy proof

---

## Troubleshooting

**Extension doesn't open side panel:**
- Make sure Developer mode is ON in chrome://extensions/
- Right-click the extension icon → "Options" → check permissions

**Agent can't find elements:**
- The page might use shadow DOM or iframes (agent handles these)
- Try being more specific: "fill the email field" instead of "fill form"

**Ollama not detected:**
- Make sure Ollama is running: open terminal → `ollama serve`
- Check: http://localhost:11434/api/version should return JSON

**Models won't download:**
- Check internet connection
- Models download from HuggingFace (may be slow in some regions)
- The extension works without models — DOM extraction is sufficient

---

## Architecture

```
User types task
       ↓
Background Service Worker (orchestrator)
       ↓
Content Script (DOM access in page context)
       ├── findElement() — 12 strategies to find any element
       ├── executeAction() — click, type, select, scroll, navigate
       └── verify() — re-scan page after each action
       ↓
Side Panel (React UI)
       ├── Learning Log — narrates every decision
       ├── Privacy Monitor — tracks zero outbound requests
       └── Debug Trace — full reasoning timeline
```

The extension NEVER sends data to external servers.
Everything happens in your browser.
