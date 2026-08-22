// ============================================================
// VLESS — Visual Overlay
// Real-time overlay showing PII detection and redaction on the page
//
// Features:
// - Bounding boxes around detected PII regions
// - Color-coded by sensitivity (critical=red, high=orange, etc.)
// - Pipeline status indicator
// - Privacy score display
// - Step-by-step narration
// ============================================================

import type { PIIDetectionResult, PIIRegion } from "./pii-detector";

// ── Types ────────────────────────────────────────────────────

export interface OverlayConfig {
  showBoundingBoxes: boolean;
  showPipelineStatus: boolean;
  showPrivacyScore: boolean;
  showNarration: boolean;
  position: "top-right" | "bottom-right" | "bottom-left" | "top-left";
  opacity: number;
}

interface OverlayState {
  active: boolean;
  container: HTMLDivElement | null;
  statusPanel: HTMLDivElement | null;
  narrationPanel: HTMLDivElement | null;
  boundingBoxes: HTMLDivElement[];
  config: OverlayConfig;
}

// ── State ────────────────────────────────────────────────────

const state: OverlayState = {
  active: false,
  container: null,
  statusPanel: null,
  narrationPanel: null,
  boundingBoxes: [],
  config: {
    showBoundingBoxes: true,
    showPipelineStatus: true,
    showPrivacyScore: true,
    showNarration: true,
    position: "top-right",
    opacity: 0.95,
  },
};

// ── Sensitivity Colors ───────────────────────────────────────

const SENSITIVITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#22c55e",
};

const CATEGORY_ICONS: Record<string, string> = {
  face: "👤",
  password: "🔒",
  aadhaar: "🆔",
  phone: "📱",
  email: "📧",
  pan: "💳",
  bank_account: "🏦",
  ifsc: "🏛️",
  name: "📝",
  address: "📍",
  date_of_birth: "📅",
  financial: "💰",
  medical: "🏥",
  upi: "💸",
  ip_address: "🌐",
  generic_sensitive: "⚠️",
};

// ── Main Overlay API ─────────────────────────────────────────

/**
 * Show the visual overlay on the page.
 */
export function showOverlay(config?: Partial<OverlayConfig>): void {
  if (state.active) return;

  state.config = { ...state.config, ...config };
  state.active = true;

  // Create main container
  state.container = document.createElement("div");
  state.container.id = "vless-pii-overlay";
  state.container.style.cssText = `
    position: fixed;
    ${getPositionCSS(state.config.position)};
    z-index: 2147483647;
    pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    opacity: ${state.config.opacity};
  `;

  // Status panel
  if (state.config.showPipelineStatus) {
    state.statusPanel = createStatusPanel();
    state.container.appendChild(state.statusPanel);
  }

  // Narration panel
  if (state.config.showNarration) {
    state.narrationPanel = createNarrationPanel();
    state.container.appendChild(state.narrationPanel);
  }

  document.body.appendChild(state.container);
}

/**
 * Hide the overlay.
 */
export function hideOverlay(): void {
  if (!state.active) return;

  // Remove bounding boxes
  removeBoundingBoxes();

  // Remove container
  if (state.container) {
    state.container.remove();
    state.container = null;
  }

  state.statusPanel = null;
  state.narrationPanel = null;
  state.active = false;
}

/**
 * Update overlay with PII detection results.
 * Shows bounding boxes around all detected PII regions.
 */
export function updatePIIDetection(result: PIIDetectionResult): void {
  if (!state.active || !state.config.showBoundingBoxes) return;

  // Clear previous bounding boxes
  removeBoundingBoxes();

  // Add new bounding boxes
  for (const region of result.regions) {
    if (!region.boundingBox) continue;
    addBoundingBox(region);
  }

  // Update status panel with summary
  if (state.statusPanel) {
    updateStatusPanel(result);
  }

  // Add narration
  addNarration(
    "detect",
    `PII Scan: ${result.summary.totalRegions} regions found ` +
    `(${result.summary.criticalCount} critical, ${result.summary.highCount} high, ` +
    `${result.summary.mediumCount} medium, ${result.summary.lowCount} low)`
  );
}

/**
 * Update overlay with pipeline step status.
 */
export function updatePipelineStatus(
  step: string,
  status: "running" | "complete" | "error",
  details?: string
): void {
  if (!state.active || !state.statusPanel) return;

  const stepEl = state.statusPanel.querySelector(`[data-step="${step}"]`) as HTMLElement;
  if (stepEl) {
    stepEl.classList.remove("running", "complete", "error");
    stepEl.classList.add(status);

    const iconEl = stepEl.querySelector(".step-icon");
    if (iconEl) {
      iconEl.textContent = status === "complete" ? "✅" : status === "error" ? "❌" : "⏳";
    }

    const detailsEl = stepEl.querySelector(".step-details");
    if (detailsEl && details) {
      detailsEl.textContent = details;
    }
  }

  // Narrate
  addNarration(
    status === "running" ? "action" : status === "complete" ? "success" : "error",
    `${step}: ${status}${details ? ` — ${details}` : ""}`
  );
}

/**
 * Update privacy score display.
 */
export function updatePrivacyScore(
  detected: number,
  redacted: number,
  outboundRequests: number
): void {
  if (!state.active || !state.config.showPrivacyScore) return;

  const scoreEl = state.container?.querySelector(".privacy-score") as HTMLElement;
  if (scoreEl) {
    const score = outboundRequests === 0 ? 100 : Math.max(0, 100 - outboundRequests * 10);
    const color = score === 100 ? "#22c55e" : score >= 80 ? "#eab308" : "#ef4444";

    scoreEl.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <div style="width: 40px; height: 40px; border-radius: 50%; border: 3px solid ${color}; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; color: ${color};">
          ${score}
        </div>
        <div>
          <div style="font-weight: 600; font-size: 13px; color: #1a1a1a;">
            ${outboundRequests === 0 ? "🔒 Perfect Privacy" : `⚠️ ${outboundRequests} outbound requests`}
          </div>
          <div style="font-size: 11px; color: #666;">
            ${detected} PII detected, ${redacted} redacted
          </div>
        </div>
      </div>
    `;
  }
}

// ── Bounding Box Management ──────────────────────────────────

function addBoundingBox(region: PIIRegion): void {
  if (!region.boundingBox) return;

  const bb = region.boundingBox;
  const color = SENSITIVITY_COLORS[region.sensitivity] || "#888";
  const icon = CATEGORY_ICONS[region.category] || "⚠️";

  const box = document.createElement("div");
  box.className = "vless-pii-box";
  box.style.cssText = `
    position: fixed;
    left: ${bb.x}px;
    top: ${bb.y}px;
    width: ${bb.width}px;
    height: ${bb.height}px;
    border: 2px solid ${color};
    border-radius: 3px;
    background: ${color}15;
    pointer-events: none;
    z-index: 2147483646;
    transition: all 0.3s ease;
  `;

  // Label
  const label = document.createElement("span");
  label.className = "vless-pii-label";
  label.style.cssText = `
    position: absolute;
    top: -18px;
    left: 0;
    font-size: 10px;
    font-weight: 600;
    color: white;
    background: ${color};
    padding: 1px 5px;
    border-radius: 2px;
    white-space: nowrap;
    pointer-events: none;
  `;
  label.textContent = `${icon} ${region.category.toUpperCase()} [${region.sensitivity}]`;
  box.appendChild(label);

  // Confidence badge
  const confBadge = document.createElement("span");
  confBadge.style.cssText = `
    position: absolute;
    bottom: -16px;
    right: 0;
    font-size: 9px;
    color: ${color};
    background: white;
    border: 1px solid ${color};
    padding: 0 3px;
    border-radius: 2px;
    pointer-events: none;
  `;
  confBadge.textContent = `${Math.round(region.confidence * 100)}%`;
  box.appendChild(confBadge);

  document.body.appendChild(box);
  state.boundingBoxes.push(box);
}

function removeBoundingBoxes(): void {
  for (const box of state.boundingBoxes) {
    box.remove();
  }
  state.boundingBoxes = [];
}

// ── Panel Creation ───────────────────────────────────────────

function createStatusPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  panel.style.cssText = `
    background: white;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    padding: 12px;
    margin-bottom: 8px;
    pointer-events: auto;
    max-width: 300px;
    font-size: 12px;
  `;

  panel.innerHTML = `
    <div style="font-weight: 700; font-size: 14px; margin-bottom: 8px; color: #1a237e;">
      🐾 VLESS Pipeline
    </div>
    <div class="pipeline-steps">
      <div data-step="capture" class="pipeline-step">
        <span class="step-icon">⏳</span>
        <span class="step-text">Capture</span>
        <span class="step-details" style="color: #888;"></span>
      </div>
      <div data-step="detect_pii" class="pipeline-step">
        <span class="step-icon">⏳</span>
        <span class="step-text">PII Detection</span>
        <span class="step-details" style="color: #888;"></span>
      </div>
      <div data-step="redact" class="pipeline-step">
        <span class="step-icon">⏳</span>
        <span class="step-text">Redaction</span>
        <span class="step-details" style="color: #888;"></span>
      </div>
      <div data-step="send" class="pipeline-step">
        <span class="step-icon">⏳</span>
        <span class="step-text">Send Safe Data</span>
        <span class="step-details" style="color: #888;"></span>
      </div>
      <div data-step="plan" class="pipeline-step">
        <span class="step-icon">⏳</span>
        <span class="step-text">LLM Planning</span>
        <span class="step-details" style="color: #888;"></span>
      </div>
      <div data-step="execute" class="pipeline-step">
        <span class="step-icon">⏳</span>
        <span class="step-text">Execute</span>
        <span class="step-details" style="color: #888;"></span>
      </div>
    </div>
    <div class="privacy-score" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;"></div>
  `;

  // Style pipeline steps
  const style = document.createElement("style");
  style.textContent = `
    .pipeline-step {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      color: #888;
      transition: color 0.3s;
    }
    .pipeline-step.running { color: #1a237e; }
    .pipeline-step.complete { color: #2e7d32; }
    .pipeline-step.error { color: #d32f2f; }
    .step-text { font-weight: 500; }
  `;
  panel.appendChild(style);

  return panel;
}

function createNarrationPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  panel.style.cssText = `
    background: white;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    padding: 12px;
    pointer-events: auto;
    max-width: 300px;
    max-height: 200px;
    overflow-y: auto;
    font-size: 11px;
  `;

  panel.innerHTML = `
    <div style="font-weight: 700; font-size: 12px; margin-bottom: 6px; color: #1a237e;">
      📋 Activity Log
    </div>
    <div class="narration-entries"></div>
  `;

  return panel;
}

// ── Status Panel Update ──────────────────────────────────────

function updateStatusPanel(result: PIIDetectionResult): void {
  if (!state.statusPanel) return;

  const scoreEl = state.statusPanel.querySelector(".privacy-score");
  if (scoreEl) {
    const total = result.summary.totalRegions;
    const critical = result.summary.criticalCount;
    const high = result.summary.highCount;

    scoreEl.innerHTML = `
      <div style="font-size: 11px; color: #333;">
        <div style="font-weight: 600; margin-bottom: 4px;">🔒 Privacy Analysis</div>
        <div>Total PII: ${total} regions</div>
        <div style="color: #ef4444;">Critical: ${critical}</div>
        <div style="color: #f97316;">High: ${high}</div>
        <div style="margin-top: 4px; color: #2e7d32; font-weight: 600;">
          All ${critical + high} sensitive regions will be redacted
        </div>
      </div>
    `;
  }
}

// ── Narration ────────────────────────────────────────────────

function addNarration(type: string, message: string): void {
  if (!state.narrationPanel) return;

  const entries = state.narrationPanel.querySelector(".narration-entries");
  if (!entries) return;

  const icons: Record<string, string> = {
    detect: "🔍",
    action: "⚡",
    success: "✅",
    error: "❌",
    warning: "⚠️",
    info: "ℹ️",
  };

  const entry = document.createElement("div");
  entry.style.cssText = `
    padding: 3px 0;
    border-bottom: 1px solid #f0f0f0;
    color: #333;
    line-height: 1.4;
  `;
  entry.innerHTML = `<span>${icons[type] || "📌"}</span> ${message}`;

  entries.appendChild(entry);

  // Auto-scroll to bottom
  entries.scrollTop = entries.scrollHeight;

  // Keep only last 20 entries
  while (entries.children.length > 20) {
    entries.removeChild(entries.firstChild!);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function getPositionCSS(position: string): string {
  switch (position) {
    case "top-right": return "top: 16px; right: 16px;";
    case "bottom-right": return "bottom: 16px; right: 16px;";
    case "bottom-left": return "bottom: 16px; left: 16px;";
    case "top-left": return "top: 16px; left: 16px;";
    default: return "top: 16px; right: 16px;";
  }
}
