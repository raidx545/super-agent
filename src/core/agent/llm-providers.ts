// ============================================================
// VLESS — Multi-Provider LLM Bridge
// Supports: Ollama (local), Claude, OpenAI/Codex, OpenRouter
// Direct API calls from background service worker.
// No proxy server required for cloud providers.
//
// API keys stored in chrome.storage.sync (encrypted at rest).
// ============================================================

import type { SanitizedContext, PlanResult } from "./server-bridge";
import type { PlannedAction } from "../../types";

// ── Provider Configuration Types ────────────────────────────

export type ProviderID = "ollama" | "claude" | "openai" | "openrouter";

export interface ProviderConfig {
  id: ProviderID;
  name: string;
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ProviderStatus {
  id: ProviderID;
  name: string;
  available: boolean;
  model: string | null;
  latencyMs: number;
  error?: string;
}

// ── Default Configs ─────────────────────────────────────────

const DEFAULT_CONFIGS: Record<ProviderID, ProviderConfig> = {
  ollama: {
    id: "ollama",
    name: "Ollama (Local)",
    enabled: true,
    baseUrl: "http://localhost:11434",
    model: "qwen2.5:1.5b",
    temperature: 0.3,
    maxTokens: 2048,
  },
  claude: {
    id: "claude",
    name: "Claude (Anthropic)",
    enabled: false,
    baseUrl: "https://api.anthropic.com",
    model: "claude-3-5-haiku-20241022",
    temperature: 0.3,
    maxTokens: 2048,
  },
  openai: {
    id: "openai",
    name: "OpenAI (GPT)",
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0.3,
    maxTokens: 2048,
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    enabled: false,
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.2-1b-instruct",
    temperature: 0.3,
    maxTokens: 2048,
  },
};

// ── Config Storage ──────────────────────────────────────────

const STORAGE_KEY = "vless_provider_configs";

export async function loadProviderConfigs(): Promise<
  Record<ProviderID, ProviderConfig>
> {
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    const saved = (stored[STORAGE_KEY] || {}) as Record<
      ProviderID,
      Partial<ProviderConfig>
    >;
    // Merge saved with defaults (so new fields are always present)
    const result: Record<ProviderID, ProviderConfig> = {} as any;
    for (const id of Object.keys(DEFAULT_CONFIGS) as ProviderID[]) {
      result[id] = { ...DEFAULT_CONFIGS[id], ...saved[id] };
    }
    return result;
  } catch {
    return { ...DEFAULT_CONFIGS };
  }
}

export async function saveProviderConfigs(
  configs: Record<ProviderID, ProviderConfig>
): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: configs });
}

export async function saveProviderConfig(
  id: ProviderID,
  config: Partial<ProviderConfig>
): Promise<void> {
  const all = await loadProviderConfigs();
  all[id] = { ...all[id], ...config };
  await saveProviderConfigs(all);
}

// ── LLM Prompt ─────────────────────────────────────────────

function buildPlanningPrompt(
  taskDescription: string,
  context: SanitizedContext,
  dataContext?: Record<string, string>
): { system: string; user: string } {
  const ps = context.pageStructure;

  const elements = ps.elements
    .slice(0, 30)
    .map((e, i) => {
      return `[${i}] <${e.tag}> role="${e.role}" label="${e.label}" type="${e.type}" ${
        e.isDisabled ? "DISABLED" : ""
      }`;
    })
    .join("\n");

  const forms = ps.forms
    .map((f) => {
      const fields = f.fields
        .map((ff) => {
          const val = ff.hasValue ? "FILLED" : "EMPTY";
          const req = ff.isRequired ? "REQUIRED" : "";
          const pii = ff.piiCategory ? `[PII:${ff.piiCategory}]` : "";
          return `  - ${ff.label}: ${ff.type} ${val} ${req} ${pii}`;
        })
        .join("\n");
      return `Form ${f.id}:\n${fields}`;
    })
    .join("\n\n");

  // PRIVACY: Never send dataContext values to the LLM.
  // The LLM only sees that PII fields exist (marked [PII:category]).
  // Actual values are filled locally by the client after the plan is returned.
  const piiFieldCount = dataContext ? Object.keys(dataContext).length : 0;
  const dataStr = piiFieldCount > 0
    ? `\nNote: ${piiFieldCount} fields require user data (filled client-side, not in prompt).\nFields marked [PII:category] have values available locally — use their index for type actions.`
    : "";

  const system = `You are VLESS, a browser automation agent. You analyze web pages and produce action plans.

## Your Task
Analyze the page state and produce a sequence of browser actions to accomplish the user's goal.

## Output Format
Respond with ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON.

{"reasoning":"<step-by-step thought process>","steps":[{"action":{"type":"<action_type>","target":"[<index>]","value":"<optional>"},"reasoning":"<why this step>","confidence":<0.0-1.0>,"risk":"<low|medium|high>"}]}

## Action Types
- **click**: Click an element. target="[0]" (element index)
- **type**: Type text into a field. target="[1]", value="text"
- **select**: Select dropdown option. target="[2]", value="option text"
- **scroll**: Scroll the page. value="up" or "down"
- **wait**: Wait for page to load. value="<ms>"
- **press_key**: Press keyboard key. value="Enter" or "Tab"
- **navigate**: Go to URL. value="https://..."

## Rules
- Use [0], [1], [2] etc. as targets — these are element indices from the page state
- For form filling: click the field first to focus it, then type the value
- Fields marked [PII:category] are sensitive — the client fills these locally, reference by index only
- Max 20 steps. Be efficient.
- Mark destructive actions (submit, delete, navigate away) as risk high
- Think step by step: what needs to happen first? What depends on what?

## Few-Shot Examples

Example 1 — Fill a login form:
{"reasoning":"I see a login form with email [0] and password [1] fields, and a submit button [2]. First click email, type value, then click password, type value, then click submit.","steps":[{"action":{"type":"click","target":"[0]"},"reasoning":"Focus email field","confidence":0.95,"risk":"low"},{"action":{"type":"type","target":"[0]","value":"user@example.com"},"reasoning":"Type email address","confidence":0.95,"risk":"low"},{"action":{"type":"click","target":"[1]"},"reasoning":"Focus password field","confidence":0.95,"risk":"low"},{"action":{"type":"type","target":"[1]","value":"password123"},"reasoning":"Type password","confidence":0.95,"risk":"low"},{"action":{"type":"click","target":"[2]"},"reasoning":"Click submit button","confidence":0.9,"risk":"high"}]}

Example 2 — Search on YouTube:
{"reasoning":"I see a search box [3] and the page is YouTube. I need to click the search box, type the query, and press Enter.","steps":[{"action":{"type":"click","target":"[3]"},"reasoning":"Focus search box","confidence":0.95,"risk":"low"},{"action":{"type":"type","target":"[3]","value":"harkirat singh"},"reasoning":"Type search query","confidence":0.95,"risk":"low"},{"action":{"type":"press_key","value":"Enter"},"reasoning":"Submit search","confidence":0.95,"risk":"low"}]}

Example 3 — Scroll and read:
{"reasoning":"User wants to see more content. I'll scroll down to reveal additional information.","steps":[{"action":{"type":"scroll","value":"down"},"reasoning":"Scroll down to see more content","confidence":0.95,"risk":"low"}]}`;

  const user = `TASK: "${taskDescription}"

PAGE STATE:
Domain: ${ps.metadata.domain}
Title: ${ps.metadata.title}
Total elements: ${ps.metadata.elementCount}

ELEMENTS:
${elements}

${forms ? `FORMS:\n${forms}` : "No forms detected."}
${dataStr}

${ps.metadata.hasCAPTCHA ? "WARNING: CAPTCHA detected — may need user intervention." : ""}
${ps.metadata.hasPaymentForm ? "WARNING: Payment form — handle with extreme caution." : ""}

Privacy: ${context.redactionProof.totalPIIDetected} PII regions detected and redacted.
Sensitive fields are marked [PII:category] — the client has these values locally.

Generate the action plan as JSON.`;

  return { system, user };
}

// ── Response Parsing ────────────────────────────────────────

function parsePlanResponse(response: string): {
  steps: PlannedAction[];
  reasoning: string;
} {
  // Strip markdown code fences if present
  const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { steps: [], reasoning: "No JSON found in response" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    // Handle both "steps" and "actions" keys
    const rawSteps = parsed.steps || parsed.actions || [];
    const steps: PlannedAction[] = rawSteps.map(
      (step: Record<string, unknown>, i: number) => {
        // Handle nested action object or flat step
        const action = (step.action || step) as Record<string, unknown>;
        // Normalize target: extract index from "[0]" format
        let target = (action.target || action.element || "") as string;
        // Normalize: extract bracket index from strings like "[0] Given Name"
        const bracketMatch = target.match(/\[(\d+)\]/);
        if (bracketMatch) {
          target = "[" + bracketMatch[1] + "]";
        }
        // Normalize action type
        let actionType = (action.type || "wait") as string;
        if (actionType === "fill") actionType = "type";
        if (actionType === "input") actionType = "type";

        return {
          index: i,
          action: {
            id: `llm-action-${i}`,
            type: actionType,
            target,
            value: action.value,
            retries: 0,
            maxRetries: 3,
          },
          reasoning: step.reasoning || "LLM-planned step",
          confidence: (step.confidence as number) || 0.8,
          verification: "Check page state after action",
          risk: (step.risk as "low" | "medium" | "high") || "low",
        };
      }
    );
    return {
      steps,
      reasoning: parsed.reasoning || `Generated ${steps.length} steps`,
    };
  } catch {
    return { steps: [], reasoning: "Failed to parse LLM response" };
  }
}

// ── Individual Providers ────────────────────────────────────

async function callOllama(
  config: ProviderConfig,
  system: string,
  user: string
): Promise<string> {
  const baseUrl = config.baseUrl || "http://localhost:11434";
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model || "qwen2.5:1.5b",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      options: {
        temperature: config.temperature ?? 0.3,
        num_predict: config.maxTokens ?? 2048,
        top_p: 0.9,
      },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = await response.json();
  return data.message?.content || "";
}

async function callClaude(
  config: ProviderConfig,
  system: string,
  user: string
): Promise<string> {
  if (!config.apiKey) throw new Error("Claude API key not configured");
  const baseUrl = config.baseUrl || "https://api.anthropic.com";

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: config.model || "claude-3-5-haiku-20241022",
      max_tokens: config.maxTokens || 2048,
      temperature: config.temperature ?? 0.3,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || "";
}

async function callOpenAI(
  config: ProviderConfig,
  system: string,
  user: string
): Promise<string> {
  if (!config.apiKey) throw new Error("OpenAI API key not configured");
  const baseUrl = config.baseUrl || "https://api.openai.com/v1";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || "gpt-4o-mini",
      max_tokens: config.maxTokens || 2048,
      temperature: config.temperature ?? 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callOpenRouter(
  config: ProviderConfig,
  system: string,
  user: string
): Promise<string> {
  if (!config.apiKey) throw new Error("OpenRouter API key not configured");
  const baseUrl = config.baseUrl || "https://openrouter.ai/api/v1";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "HTTP-Referer": "https://github.com/shashank-tomar0/super-agent",
      "X-Title": "VLESS Browser Agent",
    },
    body: JSON.stringify({
      model: config.model || "meta-llama/llama-3.2-1b-instruct",
      max_tokens: config.maxTokens || 2048,
      temperature: config.temperature ?? 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── Provider Call Router ────────────────────────────────────

const CALLERS: Record<
  ProviderID,
  (config: ProviderConfig, system: string, user: string) => Promise<string>
> = {
  ollama: callOllama,
  claude: callClaude,
  openai: callOpenAI,
  openrouter: callOpenRouter,
};

// ── Main API ────────────────────────────────────────────────

/**
 * Check which providers are available.
 */
export async function checkProviders(): Promise<ProviderStatus[]> {
  const configs = await loadProviderConfigs();
  const statuses: ProviderStatus[] = [];

  for (const [id, config] of Object.entries(configs) as [
    ProviderID,
    ProviderConfig,
  ][]) {
    if (!config.enabled) {
      statuses.push({
        id,
        name: config.name,
        available: false,
        model: null,
        latencyMs: 0,
        error: "Disabled",
      });
      continue;
    }

    const t0 = performance.now();
    try {
      if (id === "ollama") {
        // Ollama: check if server is running and model exists
        const resp = await fetch(`${config.baseUrl}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) throw new Error("Not running");
        const data = await resp.json();
        const models = (data.models || []).map((m: { name: string }) => m.name);
        const model = models.find((n: string) =>
          n.includes(config.model || "qwen")
        );
        if (model) {
          statuses.push({
            id,
            name: config.name,
            available: true,
            model,
            latencyMs: performance.now() - t0,
          });
        } else {
          statuses.push({
            id,
            name: config.name,
            available: false,
            model: null,
            latencyMs: performance.now() - t0,
            error: `Model "${config.model}" not found. Run: ollama pull ${config.model}`,
          });
        }
      } else {
        // Cloud providers: check if API key is set
        if (!config.apiKey) {
          statuses.push({
            id,
            name: config.name,
            available: false,
            model: null,
            latencyMs: 0,
            error: "API key not configured",
          });
        } else {
          // Try a minimal request to validate the key
          statuses.push({
            id,
            name: config.name,
            available: true,
            model: config.model || null,
            latencyMs: 0,
          });
        }
      }
    } catch (err) {
      statuses.push({
        id,
        name: config.name,
        available: false,
        model: null,
        latencyMs: performance.now() - t0,
        error: err instanceof Error ? err.message : "Check failed",
      });
    }
  }

  return statuses;
}

/**
 * Generate a plan using the best available provider.
 * Tries providers in priority order: Ollama -> Claude -> OpenAI -> OpenRouter
 */
export async function generatePlanWithBestProvider(
  taskDescription: string,
  sanitizedContext: SanitizedContext,
  dataContext?: Record<string, string>
): Promise<PlanResult> {
  const configs = await loadProviderConfigs();
  const statuses = await checkProviders();

  // Try each available provider in order
  const priority: ProviderID[] = ["ollama", "claude", "openai", "openrouter"];

  for (const id of priority) {
    const status = statuses.find((s) => s.id === id);
    const config = configs[id];
    if (!status?.available || !config?.enabled) continue;

    const startTime = performance.now();
    try {
      const { system, user } = buildPlanningPrompt(
        taskDescription,
        sanitizedContext,
        dataContext
      );
      const response = await CALLERS[id](config, system, user);
      const parsed = parsePlanResponse(response);

      return {
        success: true,
        steps: parsed.steps,
        reasoning: parsed.reasoning,
        provider: `${id}/${config.model}`,
        latencyMs: performance.now() - startTime,
      };
    } catch (err) {
      console.warn(`[VLESS] Provider ${id} failed:`, err);
      // Continue to next provider
    }
  }

  return {
    success: false,
    steps: [],
    reasoning: "No provider available",
    provider: "none",
    latencyMs: 0,
    error: "No LLM provider available. Configure one in Settings.",
  };
}

/**
 * Get the first available provider for quick checks.
 */
export async function getBestAvailableProvider(): Promise<{
  id: ProviderID;
  config: ProviderConfig;
} | null> {
  const configs = await loadProviderConfigs();
  const statuses = await checkProviders();
  const priority: ProviderID[] = ["ollama", "claude", "openai", "openrouter"];

  for (const id of priority) {
    const status = statuses.find((s) => s.id === id);
    if (status?.available) {
      return { id, config: configs[id] };
    }
  }
  return null;
}

/**
 * Explain a page using the best available provider.
 */
export async function explainPage(
  context: SanitizedContext
): Promise<string> {
  const best = await getBestAvailableProvider();
  if (!best) return "No LLM provider available.";

  const system =
    "You are a browser assistant. Describe the webpage briefly in 2-3 sentences. Focus on what the user can do on this page.";
  const user = `Domain: ${context.pageStructure.metadata.domain}
Title: ${context.pageStructure.metadata.title}
Elements: ${context.pageStructure.metadata.elementCount}
Forms: ${context.pageStructure.forms.length}
${context.pageStructure.metadata.hasCAPTCHA ? "Has CAPTCHA." : ""}
${context.pageStructure.metadata.hasPaymentForm ? "Has payment form." : ""}`;

  try {
    const response = await CALLERS[best.id](best.config, system, user);
    return response;
  } catch {
    return "Could not explain page.";
  }
}
