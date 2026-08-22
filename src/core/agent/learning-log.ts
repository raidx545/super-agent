// ============================================================
// VLESS — Agent Learning Log
// Real-time narrated feed of what the agent is discovering
// "Watch Me Learn" mode — makes the agent feel alive
// ============================================================

export interface LogEntry {
  id: string;
  timestamp: number;
  phase: "discovery" | "analysis" | "action" | "success" | "warning" | "error" | "learning";
  icon: string;
  message: string;
  details?: string;
  confidence?: number;
}

// ── State ────────────────────────────────────────────────────

let entries: LogEntry[] = [];
let listeners: Array<(entries: LogEntry[]) => void> = [];

// ── Public API ───────────────────────────────────────────────

/**
 * Add a log entry and notify listeners.
 */
export function log(
  phase: LogEntry["phase"],
  message: string,
  details?: string,
  confidence?: number
): LogEntry {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    timestamp: Date.now(),
    phase,
    icon: getPhaseIcon(phase),
    message,
    details,
    confidence,
  };

  entries.push(entry);

  // Keep last 200 entries
  if (entries.length > 200) {
    entries = entries.slice(-200);
  }

  notifyListeners();
  return entry;
}

/**
 * Start streaming mode — agent will narrate its discoveries.
 */
export function startStreaming(): void {
  entries = [];
  notifyListeners();
}

/**
 * Stop streaming mode.
 */
export function stopStreaming(): void {
  // No-op, streaming is implicit based on entry presence
}

/**
 * Get all log entries.
 */
export function getEntries(): LogEntry[] {
  return [...entries];
}

/**
 * Get entries from the last N seconds.
 */
export function getRecentEntries(seconds: number): LogEntry[] {
  const cutoff = Date.now() - seconds * 1000;
  return entries.filter((e) => e.timestamp >= cutoff);
}

/**
 * Subscribe to new entries.
 */
export function onLogEntry(callback: (entries: LogEntry[]) => void): () => void {
  listeners.push(callback);
  return () => {
    listeners = listeners.filter((l) => l !== callback);
  };
}

/**
 * Clear all entries.
 */
export function clearEntries(): void {
  entries = [];
  notifyListeners();
}

// ── Narration Helpers ────────────────────────────────────────

/**
 * Narrate page perception — what the agent sees.
 */
export function narratePerception(pageState: {
  url: string;
  title: string;
  elements: { tag: string; label?: string; text?: string }[];
  forms: { id: string; fields: { label: string; required: boolean; filledByUser: boolean }[] }[];
  metadata: {
    hasCAPTCHA: boolean;
    hasHoneypot: boolean;
    hasPaymentForm: boolean;
  };
}): void {
  log("discovery", `Scanning page: "${pageState.title}"`);

  // Elements
  const elementTypes = new Map<string, number>();
  for (const el of pageState.elements) {
    elementTypes.set(el.tag, (elementTypes.get(el.tag) || 0) + 1);
  }
  const elementSummary = Array.from(elementTypes.entries())
    .map(([tag, count]) => `${count} <${tag}>`)
    .join(", ");
  log("analysis", `Found ${pageState.elements.length} interactive elements: ${elementSummary}`);

  // Forms
  if (pageState.forms.length > 0) {
    for (const form of pageState.forms) {
      const totalFields = form.fields.length;
      const filled = form.fields.filter((f) => f.filledByUser).length;
      const required = form.fields.filter((f) => f.required).length;
      const empty = totalFields - filled;

      log("analysis", `Form "${form.id}": ${totalFields} fields (${filled} filled, ${empty} empty, ${required} required)`, undefined, totalFields > 0 ? filled / totalFields : undefined);

      // Describe each field
      for (const field of form.fields.slice(0, 15)) {
        const status = field.filledByUser ? "✓" : field.required ? "⚠️ required" : "○ optional";
        log("analysis", `  Field "${field.label || "unnamed"}": ${status}`);
      }
    }
  } else {
    log("analysis", "No forms detected on this page");
  }

  // Flags
  if (pageState.metadata.hasCAPTCHA) {
    log("warning", "🛡️ CAPTCHA detected — may need user intervention");
  }
  if (pageState.metadata.hasHoneypot) {
    log("warning", "🍯 Honeypot field detected — will skip");
  }
  if (pageState.metadata.hasPaymentForm) {
    log("warning", "💳 Payment form detected — handling with caution");
  }
}

/**
 * Narrate an action being executed.
 */
export function narrateAction(action: {
  type: string;
  target?: string;
  value?: string;
}): void {
  switch (action.type) {
    case "click":
      log("action", `Clicking "${action.target || "element"}"`);
      break;
    case "type":
      log("action", `Typing "${(action.value || "").slice(0, 30)}${(action.value || "").length > 30 ? "..." : ""}" into "${action.target || "field"}"`);
      break;
    case "scroll":
      log("action", `Scrolling ${action.value || "down"}`);
      break;
    case "navigate":
      log("action", `Navigating to ${action.value}`);
      break;
    case "select":
      log("action", `Selecting "${action.value}" from "${action.target}"`);
      break;
    case "wait":
      log("action", `Waiting ${action.value || "for page"}...`);
      break;
    default:
      log("action", `Executing ${action.type}`);
  }
}

/**
 * Narrate an action result.
 */
export function narrateResult(success: boolean, details?: string): void {
  if (success) {
    log("success", `✅ Action completed successfully${details ? `: ${details}` : ""}`);
  } else {
    log("error", `❌ Action failed${details ? `: ${details}` : ""}`);
  }
}

/**
 * Narrate a learning event.
 */
export function narrateLearning(insight: string): void {
  log("learning", `🧠 Learned: ${insight}`);
}

/**
 * Narrate retry attempt.
 */
export function narrateRetry(attempt: number, maxRetries: number, reason: string): void {
  log("warning", `🔄 Retry ${attempt}/${maxRetries}: ${reason}`);
}

// ── Helpers ──────────────────────────────────────────────────

function getPhaseIcon(phase: LogEntry["phase"]): string {
  switch (phase) {
    case "discovery": return "🔍";
    case "analysis": return "📊";
    case "action": return "⚡";
    case "success": return "✅";
    case "warning": return "⚠️";
    case "error": return "❌";
    case "learning": return "🧠";
  }
}

function notifyListeners(): void {
  const snapshot = [...entries];
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // Listener error
    }
  }
}
