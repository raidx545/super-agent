// ============================================================
// VLESS — Multi-Tab Orchestrator
// Manages multiple tabs simultaneously for complex workflows
// "Open Gmail, check email, open attachment, fill form from data"
// ============================================================

import type { PageState, AgentAction } from "../../types";

// ── Types ────────────────────────────────────────────────────

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  isActive: boolean;
  isAgentControlled: boolean;
  lastPerceived: number;
  pageState: PageState | null;
}

export interface TabWorkflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  currentStep: number;
  status: "running" | "paused" | "completed" | "failed";
  tabAssignments: Map<number, string>; // tabId → stepGroupId
  startTime: number;
  dataContext: Record<string, string>;
}

export interface WorkflowStep {
  id: string;
  group: string; // Which tab group this step belongs to
  action: AgentAction;
  description: string;
  requiresTab: number | null; // null = any tab
  waitForNavigation: boolean;
  dataFromPreviousStep?: string; // Reference to data extracted from previous step
}

// ── State ────────────────────────────────────────────────────

interface OrchestratorState {
  trackedTabs: Map<number, TabInfo>;
  activeWorkflow: TabWorkflow | null;
  crossTabData: Map<string, unknown>; // Shared data between tabs
}

const state: OrchestratorState = {
  trackedTabs: new Map(),
  activeWorkflow: null,
  crossTabData: new Map(),
};

let listeners: Array<(event: string, data: unknown) => void> = [];

// ── Tab Management ───────────────────────────────────────────

/**
 * Start tracking a tab.
 */
export async function trackTab(tabId: number): Promise<TabInfo> {
  const tab = await chrome.tabs.get(tabId);

  const info: TabInfo = {
    id: tabId,
    url: tab.url || "",
    title: tab.title || "",
    isActive: tab.active,
    isAgentControlled: true,
    lastPerceived: 0,
    pageState: null,
  };

  state.trackedTabs.set(tabId, info);
  notify("tab:tracked", info);
  return info;
}

/**
 * Stop tracking a tab.
 */
export function untrackTab(tabId: number): void {
  state.trackedTabs.delete(tabId);
  notify("tab:untracked", { tabId });
}

/**
 * Get all tracked tabs.
 */
export function getTrackedTabs(): TabInfo[] {
  return Array.from(state.trackedTabs.values());
}

/**
 * Get the best tab for a given URL/domain.
 */
export function findTabForUrl(url: string): TabInfo | null {
  const parsed = new URL(url);
  for (const tab of state.trackedTabs.values()) {
    try {
      const tabParsed = new URL(tab.url);
      if (tabParsed.hostname === parsed.hostname) {
        return tab;
      }
    } catch {
      // Invalid URL
    }
  }
  return null;
}

/**
 * Open a new tab and start tracking it.
 */
export async function openTab(url: string): Promise<TabInfo> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error("Failed to create tab");

  return trackTab(tab.id);
}

/**
 * Switch to a specific tab.
 */
export async function switchToTab(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });

  // Update tracked tabs
  for (const tab of state.trackedTabs.values()) {
    tab.isActive = tab.id === tabId;
  }

  notify("tab:switched", { tabId });
}

/**
 * Close a tracked tab.
 */
export async function closeTab(tabId: number): Promise<void> {
  await chrome.tabs.remove(tabId);
  untrackTab(tabId);
}

// ── Cross-Tab Data Flow ──────────────────────────────────────

/**
 * Store data extracted from one tab for use in another.
 */
export function storeCrossTabData(key: string, value: unknown): void {
  state.crossTabData.set(key, value);
  notify("data:stored", { key, value });
}

/**
 * Retrieve cross-tab data.
 */
export function getCrossTabData(key: string): unknown {
  return state.crossTabData.get(key);
}

/**
 * Get all cross-tab data.
 */
export function getAllCrossTabData(): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of state.crossTabData) {
    data[key] = value;
  }
  return data;
}

// ── Workflow Execution ───────────────────────────────────────

/**
 * Create a multi-tab workflow.
 */
export function createWorkflow(
  name: string,
  steps: WorkflowStep[],
  dataContext: Record<string, string> = {}
): TabWorkflow {
  const workflow: TabWorkflow = {
    id: `workflow-${Date.now()}`,
    name,
    steps,
    currentStep: 0,
    status: "running",
    tabAssignments: new Map(),
    startTime: Date.now(),
    dataContext,
  };

  state.activeWorkflow = workflow;
  notify("workflow:created", workflow);
  return workflow;
}

/**
 * Execute the next step in the active workflow.
 */
export async function executeNextStep(): Promise<{
  success: boolean;
  stepIndex: number;
  error?: string;
}> {
  const workflow = state.activeWorkflow;
  if (!workflow || workflow.status !== "running") {
    return { success: false, stepIndex: -1, error: "No active workflow" };
  }

  const step = workflow.steps[workflow.currentStep];
  if (!step) {
    workflow.status = "completed";
    notify("workflow:completed", workflow);
    return { success: true, stepIndex: workflow.currentStep };
  }

  try {
    // Ensure we're on the right tab
    if (step.requiresTab) {
      await switchToTab(step.requiresTab);
    }

    // Resolve data references
    if (step.dataFromPreviousStep) {
      const data = getCrossTabData(step.dataFromPreviousStep);
      if (data && step.action.type === "type") {
        step.action.value = String(data);
      }
    }

    // Execute the action
    const result = await executeActionOnTab(
      step.requiresTab || await getActiveTabId(),
      step.action
    );

    if (!result.success) {
      workflow.status = "failed";
      notify("workflow:failed", { workflow, error: result.error });
      return { success: false, stepIndex: workflow.currentStep, error: result.error };
    }

    // Wait for navigation if needed
    if (step.waitForNavigation) {
      await waitForNavigation(step.requiresTab || await getActiveTabId(), 5000);
    }

    workflow.currentStep++;
    notify("workflow:step-complete", { workflow, stepIndex: workflow.currentStep - 1 });

    // Check if workflow is complete
    if (workflow.currentStep >= workflow.steps.length) {
      workflow.status = "completed";
      notify("workflow:completed", workflow);
    }

    return { success: true, stepIndex: workflow.currentStep - 1 };
  } catch (error) {
    workflow.status = "failed";
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    notify("workflow:failed", { workflow, error: errMsg });
    return { success: false, stepIndex: workflow.currentStep, error: errMsg };
  }
}

/**
 * Pause the active workflow.
 */
export function pauseWorkflow(): void {
  if (state.activeWorkflow) {
    state.activeWorkflow.status = "paused";
    notify("workflow:paused", state.activeWorkflow);
  }
}

/**
 * Resume the active workflow.
 */
export function resumeWorkflow(): void {
  if (state.activeWorkflow && state.activeWorkflow.status === "paused") {
    state.activeWorkflow.status = "running";
    notify("workflow:resumed", state.activeWorkflow);
  }
}

/**
 * Get active workflow status.
 */
export function getActiveWorkflow(): TabWorkflow | null {
  return state.activeWorkflow;
}

// ── Tab Action Execution ─────────────────────────────────────

async function executeActionOnTab(
  tabId: number,
  action: AgentAction
): Promise<{ success: boolean; error?: string }> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (a: any) => {
        const find = (t: string): Element | null => {
          if (document.getElementById(t)) return document.getElementById(t);
          try { const e = document.querySelector(t); if (e) return e; } catch {}
          const n = document.querySelector(`[name="${t}"]`);
          if (n) return n;
          const ar = document.querySelector(`[aria-label="${t}"]`);
          if (ar) return ar;
          const ph = document.querySelector(`[placeholder="${t}"]`);
          if (ph) return ph;
          const btns = document.querySelectorAll("button, a, [role='button']");
          for (const b of btns) {
            if (b.textContent?.trim().toLowerCase().includes(t.toLowerCase())) return b;
          }
          return null;
        };

        try {
          switch (a.type) {
            case "click": {
              const el = find(a.target || "");
              if (!el) return { success: false, error: `Not found: ${a.target}` };
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              const r = el.getBoundingClientRect();
              el.dispatchEvent(new MouseEvent("click", {
                bubbles: true, cancelable: true,
                clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
              }));
              return { success: true };
            }
            case "type": {
              const el = find(a.target || "");
              if (!el) return { success: false, error: `Not found: ${a.target}` };
              const inp = el as HTMLInputElement;
              inp.focus();
              inp.value = "";
              for (const c of a.value || "") {
                inp.dispatchEvent(new KeyboardEvent("keydown", { key: c, bubbles: true }));
                inp.value += c;
                inp.dispatchEvent(new InputEvent("input", { data: c, inputType: "insertText", bubbles: true }));
                inp.dispatchEvent(new KeyboardEvent("keyup", { key: c, bubbles: true }));
              }
              inp.dispatchEvent(new Event("change", { bubbles: true }));
              inp.blur();
              return { success: true };
            }
            case "scroll": {
              window.scrollBy({ top: a.value === "up" ? -500 : 500, behavior: "smooth" });
              return { success: true };
            }
            case "navigate": {
              window.location.href = a.value || "";
              return { success: true };
            }
            default:
              return { success: false, error: `Unknown action: ${a.type}` };
          }
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      },
      args: [action],
    });

    return results?.[0]?.result || { success: false, error: "Script execution failed" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Tab execution failed" };
  }
}

// ── Helpers ──────────────────────────────────────────────────

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab.id;
}

async function waitForNavigation(tabId: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeout);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.url) {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        const tab = state.trackedTabs.get(tabId);
        if (tab) tab.url = changeInfo.url;
        resolve(true);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function notify(event: string, data: unknown): void {
  for (const listener of listeners) {
    try {
      listener(event, data);
    } catch {
      // Listener error
    }
  }
}

/**
 * Subscribe to orchestrator events.
 */
export function onOrchestratorEvent(callback: (event: string, data: unknown) => void): () => void {
  listeners.push(callback);
  return () => {
    listeners = listeners.filter((l) => l !== callback);
  };
}
