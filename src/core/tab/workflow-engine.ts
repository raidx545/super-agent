// ============================================================
// VLESS — Workflow Engine
// Execute complex tasks across multiple browser tabs.
// Data flows between tabs — extract from one, use in another.
//
// Example: "Open Gmail, check latest email, open attachment,
// fill a form using data from the attachment"
// ============================================================

import type { AgentAction, PlannedAction } from "../../types";

// ── Types ────────────────────────────────────────────────────

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  currentStepIndex: number;
  status: "idle" | "running" | "paused" | "completed" | "failed";
  dataContext: Record<string, string>;
  startTime?: number;
  endTime?: number;
  errors: string[];
}

export interface WorkflowStep {
  id: string;
  description: string;
  action: AgentAction;
  tabId?: number;
  waitForNavigation?: boolean;
  extractData?: {
    key: string;
    selector: string;
    attribute?: string;
  };
  condition?: {
    type: "element_exists" | "text_contains" | "url_contains";
    value: string;
  };
  retryCount: number;
  maxRetries: number;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  domain: string;
  steps: Omit<WorkflowStep, "id">[];
  timesUsed: number;
  successRate: number;
  lastUsed: number;
}

// ── Workflow Engine ──────────────────────────────────────────

class WorkflowEngine {
  private activeWorkflow: Workflow | null = null;
  private templates: WorkflowTemplate[] = [];
  private listeners: Array<(event: string, data: unknown) => void> = [];

  /**
   * Create a workflow from a plan.
   */
  createWorkflow(
    name: string,
    description: string,
    plan: PlannedAction[],
    dataContext: Record<string, string> = {}
  ): Workflow {
    const steps: WorkflowStep[] = plan.map((p, i) => ({
      id: `step-${i}`,
      description: p.reasoning,
      action: p.action,
      waitForNavigation: p.action.type === "navigate",
      retryCount: 0,
      maxRetries: p.action.maxRetries || 3,
    }));

    this.activeWorkflow = {
      id: `wf-${Date.now()}`,
      name,
      description,
      steps,
      currentStepIndex: 0,
      status: "idle",
      dataContext,
      errors: [],
    };

    this.notify("workflow:created", this.activeWorkflow);
    return this.activeWorkflow;
  }

  /**
   * Execute the next step in the active workflow.
   */
  async executeNextStep(
    executeAction: (action: AgentAction) => Promise<{ success: boolean; error?: string }>,
    getTabState: (tabId?: number) => Promise<{ elements: unknown[]; textContent: string; url: string }>
  ): Promise<{ success: boolean; stepIndex: number; error?: string }> {
    const wf = this.activeWorkflow;
    if (!wf || wf.status !== "running" && wf.status !== "idle") {
      return { success: false, stepIndex: -1, error: "No active workflow" };
    }

    if (wf.currentStepIndex >= wf.steps.length) {
      wf.status = "completed";
      wf.endTime = Date.now();
      this.notify("workflow:completed", wf);
      return { success: true, stepIndex: wf.currentStepIndex };
    }

    const step = wf.steps[wf.currentStepIndex];

    // Check condition if present
    if (step.condition) {
      const tabState = await getTabState(step.tabId);
      const conditionMet = this.checkCondition(step.condition, tabState);
      if (!conditionMet) {
        // Skip this step
        wf.currentStepIndex++;
        return { success: true, stepIndex: wf.currentStepIndex - 1 };
      }
    }

    // Resolve data references in action value
    if (step.action.type === "type" && step.action.value) {
      step.action.value = this.resolveDataReferences(
        step.action.value,
        wf.dataContext
      );
    }

    // Execute with retries
    let lastError = "";
    for (let retry = 0; retry <= step.maxRetries; retry++) {
      if (retry > 0) {
        step.retryCount = retry;
        await sleep(500);
      }

      const result = await executeAction(step.action);

      if (result.success) {
        // Extract data if configured
        if (step.extractData) {
          const tabState = await getTabState(step.tabId);
          const extracted = this.extractData(
            step.extractData,
            tabState
          );
          if (extracted !== null) {
            wf.dataContext[step.extractData.key] = extracted;
            this.notify("workflow:data_extracted", {
              key: step.extractData.key,
              value: extracted.slice(0, 50),
            });
          }
        }

        wf.currentStepIndex++;
        this.notify("workflow:step-complete", {
          stepIndex: wf.currentStepIndex - 1,
          step,
        });

        // Wait for navigation if needed
        if (step.waitForNavigation) {
          await sleep(1000);
        }

        return { success: true, stepIndex: wf.currentStepIndex - 1 };
      }

      lastError = result.error || "Unknown error";
    }

    // All retries failed
    wf.errors.push(`Step ${wf.currentStepIndex}: ${lastError}`);
    wf.currentStepIndex++;
    this.notify("workflow:step-failed", {
      stepIndex: wf.currentStepIndex - 1,
      error: lastError,
    });

    return {
      success: false,
      stepIndex: wf.currentStepIndex - 1,
      error: lastError,
    };
  }

  /**
   * Execute all remaining steps.
   */
  async executeAll(
    executeAction: (action: AgentAction) => Promise<{ success: boolean; error?: string }>,
    getTabState: (tabId?: number) => Promise<{ elements: unknown[]; textContent: string; url: string }>
  ): Promise<{ success: boolean; completed: number; total: number; errors: string[] }> {
    const wf = this.activeWorkflow;
    if (!wf) return { success: false, completed: 0, total: 0, errors: ["No workflow"] };

    wf.status = "running";
    wf.startTime = Date.now();
    this.notify("workflow:started", wf);

    let completed = 0;
    const total = wf.steps.length;

    while (wf.currentStepIndex < wf.steps.length && wf.status === "running") {
      const result = await this.executeNextStep(executeAction, getTabState);
      if (result.success) completed++;

      // Brief pause between steps
      await sleep(300);
    }

    if (wf.status === "running") {
      wf.status = wf.errors.length === 0 ? "completed" : "failed";
    }
    wf.endTime = Date.now();

    this.notify("workflow:finished", wf);

    return {
      success: wf.status === "completed",
      completed,
      total,
      errors: wf.errors,
    };
  }

  /**
   * Pause the active workflow.
   */
  pause(): void {
    if (this.activeWorkflow) {
      this.activeWorkflow.status = "paused";
      this.notify("workflow:paused", this.activeWorkflow);
    }
  }

  /**
   * Resume the active workflow.
   */
  resume(): void {
    if (this.activeWorkflow?.status === "paused") {
      this.activeWorkflow.status = "running";
      this.notify("workflow:resumed", this.activeWorkflow);
    }
  }

  /**
   * Get active workflow.
   */
  getActive(): Workflow | null {
    return this.activeWorkflow;
  }

  /**
   * Save a workflow as a reusable template.
   */
  saveTemplate(name: string, description: string, domain: string): WorkflowTemplate | null {
    const wf = this.activeWorkflow;
    if (!wf) return null;

    const template: WorkflowTemplate = {
      id: `tpl-${Date.now()}`,
      name,
      description,
      domain,
      steps: wf.steps.map((s) => ({
        description: s.description,
        action: { ...s.action },
        waitForNavigation: s.waitForNavigation,
        extractData: s.extractData,
        condition: s.condition,
        retryCount: 0,
        maxRetries: s.maxRetries,
      })),
      timesUsed: 0,
      successRate: 0,
      lastUsed: Date.now(),
    };

    this.templates.push(template);
    this.notify("template:saved", template);
    return template;
  }

  /**
   * Get saved templates for a domain.
   */
  getTemplates(domain?: string): WorkflowTemplate[] {
    if (domain) {
      return this.templates.filter((t) => t.domain === domain);
    }
    return [...this.templates];
  }

  // ── Private ──────────────────────────────────────────

  private checkCondition(
    condition: WorkflowStep["condition"],
    tabState: { elements: unknown[]; textContent: string; url: string }
  ): boolean {
    if (!condition) return true;

    switch (condition.type) {
      case "url_contains":
        return tabState.url.includes(condition.value);
      case "text_contains":
        return tabState.textContent.includes(condition.value);
      case "element_exists":
        return tabState.textContent.includes(condition.value); // Simplified
      default:
        return true;
    }
  }

  private resolveDataReferences(
    value: string,
    dataContext: Record<string, string>
  ): string {
    // Replace {{key}} references with actual values
    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return dataContext[key] || `{{${key}}}`;
    });
  }

  private extractData(
    extractConfig: WorkflowStep["extractData"],
    tabState: { elements: unknown[]; textContent: string; url: string }
  ): string | null {
    if (!extractConfig) return null;

    // Simple extraction from text content
    // For production, this would use DOM selectors
    return tabState.textContent.slice(0, 500);
  }

  private notify(event: string, data: unknown): void {
    for (const listener of this.listeners) {
      try { listener(event, data); } catch { /* ignore */ }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Singleton ────────────────────────────────────────────────

let instance: WorkflowEngine | null = null;

export function getWorkflowEngine(): WorkflowEngine {
  if (!instance) {
    instance = new WorkflowEngine();
  }
  return instance;
}
