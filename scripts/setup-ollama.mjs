#!/usr/bin/env node
// ============================================================
// VLESS — Ollama Setup Script
// Installs and configures the local AI model for action planning
//
// Usage: node scripts/setup-ollama.mjs
// ============================================================

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

// Model choices ordered by size (smallest first)
const MODELS = [
  {
    name: "qwen2.5:0.5b",
    size: "400MB",
    description: "Tiny model — fastest, good for simple form filling",
    recommended: false,
  },
  {
    name: "qwen2.5:1.5b",
    size: "1GB",
    description: "Small model — good balance of speed and quality",
    recommended: true,
  },
  {
    name: "qwen2.5:3b",
    size: "2GB",
    description: "Medium model — best quality for complex tasks",
    recommended: false,
  },
];

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`[OK] Ollama is running (v${data.version})`);
      return true;
    }
  } catch {}
  console.log("[FAIL] Ollama is not running");
  console.log("");
  console.log("Install Ollama:");
  console.log("  Windows: https://ollama.ai/download");
  console.log("  Mac/Linux: curl -fsSL https://ollama.ai/install.sh | sh");
  console.log("");
  console.log("Then start it and run this script again.");
  return false;
}

async function getModels() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

async function pullModel(modelName) {
  console.log(`\nPulling ${modelName}...`);
  console.log("(This downloads the model, may take a few minutes)\n");

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });

    const reader = res.body?.getReader();
    if (!reader) {
      console.log("[FAIL] Could not read response");
      return false;
    }

    let lastStatus = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = new TextDecoder().decode(value);
      const lines = text.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.status !== lastStatus) {
            lastStatus = data.status;
            if (data.status.includes("pulling")) {
              const pct = data.completed && data.total
                ? ` (${Math.round((data.completed / data.total) * 100)}%)`
                : "";
              process.stdout.write(`\r  ${data.status}${pct}    `);
            } else {
              console.log(`  ${data.status}`);
            }
          }
        } catch {}
      }
    }

    console.log(`\n[OK] ${modelName} ready`);
    return true;
  } catch (error) {
    console.log(`\n[FAIL] Pull failed: ${error.message}`);
    return false;
  }
}

async function testModel(modelName) {
  console.log(`\nTesting ${modelName}...`);

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        prompt: 'You are a browser automation agent. The user says: "Fill the name field with John". The page has a form with fields: [Given Name (empty)], [Email (empty)]. Respond with a JSON action plan: {"steps":[{"action":"click","target":"Given Name"},{"action":"type","target":"Given Name","value":"John"}]}',
        stream: false,
        options: { temperature: 0.3, num_predict: 256 },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.log(`[FAIL] Ollama returned ${res.status}`);
      return false;
    }

    const data = await res.json();
    const response = data.response || "";

    // Check if response contains valid JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.steps && Array.isArray(parsed.steps)) {
          console.log(`[OK] Model responded with ${parsed.steps.length} action steps`);
          console.log(`  Response time: ${data.total_duration ? (data.total_duration / 1e9).toFixed(1) + "s" : "unknown"}`);
          console.log(`  Token count: ${data.eval_count || "unknown"}`);
          return true;
        }
      } catch {}
    }

    console.log(`[WARN] Model responded but format was unexpected`);
    console.log(`  First 200 chars: ${response.slice(0, 200)}`);
    return true; // Model works, just format issue
  } catch (error) {
    console.log(`[FAIL] Test failed: ${error.message}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("VLESS — Ollama Setup\n");

  // Check if Ollama is running
  const running = await checkOllama();
  if (!running) return;

  // Check what models are installed
  const installed = await getModels();
  console.log(`\nInstalled models: ${installed.length > 0 ? installed.join(", ") : "none"}`);

  // Find a VLESS-compatible model
  const vlessModels = installed.filter((m) => m.startsWith("qwen2.5"));
  if (vlessModels.length > 0) {
    console.log(`\n[OK] Found compatible model: ${vlessModels[0]}`);
    const works = await testModel(vlessModels[0]);
    if (works) {
      console.log("\n=== SETUP COMPLETE ===");
      console.log(`Model: ${vlessModels[0]}`);
      console.log("The extension will auto-detect this model.");
      console.log("Open any form, click VLESS, type a task, and click Start.");
      return;
    }
  }

  // No compatible model — ask which to install
  console.log("\nNo compatible model found. Choose one to install:\n");
  MODELS.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.name} (${m.size}) — ${m.description}${m.recommended ? " [RECOMMENDED]" : ""}`);
  });

  // Auto-select recommended
  const selected = MODELS.find((m) => m.recommended) || MODELS[0];
  console.log(`\nInstalling ${selected.name}...`);

  const pulled = await pullModel(selected.name);
  if (pulled) {
    const works = await testModel(selected.name);
    if (works) {
      console.log("\n=== SETUP COMPLETE ===");
      console.log(`Model: ${selected.name}`);
      console.log("The extension will auto-detect this model.");
    }
  }
}

main().catch(console.error);
