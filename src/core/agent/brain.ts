// ============================================================
// VLESS — Agent Brain
// The ReAct (Reason + Act) loop that powers all decision-making
// Observe → Think → Act → Verify → Reflect
// ============================================================

import type {
  AgentTask,
  AgentStatus,
  PageState,
  ActionResult,
  ActionPlan,
  PlannedAction,
  ReasoningStep,
  MessageType,
  DataMapping,
} from "../../types";
import { extractPageState, isDOMSufficient } from "../perception/dom-extractor";
import { executeAction } from "../actions/executor";
import { verifyAction } from "../verification/multi-signal";

// ── Configuration ────────────────────────────────────────────

const MAX_RETRIES = 3;
const INTER_STEP_DELAY = 300; // ms between steps (human-like pacing)

// ── Agent State ──────────────────────────────────────────────

interface AgentState {
  task: AgentTask | null;
  currentPageState: PageState | null;
  reasoningTrace: ReasoningStep[];
  retryCount: number;
  abortController: AbortController | null;
}

const state: AgentState = {
  task: null,
  currentPageState: null,
  reasoningTrace: [],
  retryCount: 0,
  abortController: null,
};

// ── Public API ───────────────────────────────────────────────

/**
 * Start a new task. This is the main entry point.
 */
export async function startTask(
  taskDescription: string,
  dataContext?: Record<string, string>
): Promise<AgentTask> {
  // Create task
  const task: AgentTask = {
    id: `task-${Date.now()}`,
    description: taskDescription,
    status: "analyzing",
    plan: {
      steps: [],
      estimatedTime: 0,
      riskLevel: "low",
      requiresConfirmation: false,
      dataMappings: [],
    },
    currentStep: 0,
    totalSteps: 0,
    startTime: Date.now(),
  };

  state.task = task;
  state.reasoningTrace = [];
  state.retryCount = 0;
  state.abortController = new AbortController();

  broadcast({ type: "TASK_STATUS", payload: task });

  try {
    // Phase 1: Analyze the current page
    await addReasoning("observe", "Analyzing current page state...");
    const pageState = await perceiveCurrentPage();
    state.currentPageState = pageState;

    await addReasoning(
      "observe",
      `Page analyzed: ${pageState.elements.length} interactive elements, ` +
        `${pageState.forms.length} forms, ` +
        `confidence: ${(pageState.confidence * 100).toFixed(1)}%`
    );

    // Phase 2: Generate action plan
    task.status = "planning";
    broadcast({ type: "TASK_STATUS", payload: task });

    await addReasoning("think", `Generating action plan for: "${taskDescription}"`);
    const plan = await generatePlan(taskDescription, pageState, dataContext);
    task.plan = plan;
    task.totalSteps = plan.steps.length;

    await addReasoning(
      "think",
      `Plan generated: ${plan.steps.length} steps, ` +
        `risk: ${plan.riskLevel}, ` +
        `estimated time: ${(plan.estimatedTime / 1000).toFixed(1)}s`
    );

    // Phase 3: Execute the plan
    task.status = "executing";
    broadcast({ type: "TASK_STATUS", payload: task });

    const result = await executePlan(task, plan);

    // Phase 4: Complete
    task.status = result.success ? "completed" : "failed";
    task.endTime = Date.now();
    task.result = result.summary;

    broadcast({ type: "TASK_COMPLETE", payload: { task, result } });
    return task;
  } catch (error) {
    task.status = "failed";
    task.endTime = Date.now();
    task.error = error instanceof Error ? error.message : "Unknown error";
    broadcast({ type: "TASK_COMPLETE", payload: { task, error } });
    return task;
  }
}

/**
 * Pause the current task.
 */
export function pauseTask(): void {
  if (state.task) {
    state.task.status = "paused";
    broadcast({ type: "TASK_STATUS", payload: state.task });
  }
}

/**
 * Resume the current task.
 */
export function resumeTask(): void {
  if (state.task && state.task.status === "paused") {
    state.task.status = "executing";
    broadcast({ type: "TASK_STATUS", payload: state.task });
    executePlan(state.task, state.task.plan);
  }
}

/**
 * Cancel the current task.
 */
export function cancelTask(): void {
  state.abortController?.abort();
  if (state.task) {
    state.task.status = "failed";
    state.task.error = "Cancelled by user";
    broadcast({ type: "TASK_COMPLETE", payload: { task: state.task } });
  }
}

/**
 * Get the current reasoning trace (for visual debug).
 */
export function getReasoningTrace(): ReasoningStep[] {
  return [...state.reasoningTrace];
}

/**
 * Get current agent status.
 */
export function getStatus(): AgentStatus {
  return state.task?.status || "idle";
}

// ── Perception ───────────────────────────────────────────────

async function perceiveCurrentPage(): Promise<PageState> {
  // DOM extraction (fast path)
  const domState = extractPageState();

  if (isDOMSufficient(domState)) {
    return domState;
  }

  // TODO: Fall through to visual perception when DOM is insufficient
  // For now, return DOM state with reduced confidence
  return { ...domState, confidence: Math.min(domState.confidence, 0.7) };
}

// ── Planning ─────────────────────────────────────────────────

async function generatePlan(
  description: string,
  pageState: PageState,
  dataContext?: Record<string, string>
): Promise<ActionPlan> {
  const steps: PlannedAction[] = [];
  let stepIndex = 0;

  // Analyze the task and generate steps
  // This is where the LLM would be called for complex tasks
  // For now, we use a rule-based approach for common patterns

  const intent = classifyIntent(description);

  switch (intent.type) {
    case "form_fill":
      steps.push(...planFormFill(pageState, intent, dataContext, stepIndex));
      break;
    case "navigation":
      steps.push(...planNavigation(pageState, intent, stepIndex));
      break;
    case "data_extraction":
      steps.push(...planExtraction(pageState, intent, stepIndex));
      break;
    case "multi_step":
      steps.push(...planMultiStep(pageState, intent, dataContext, stepIndex));
      break;
    default:
      steps.push({
        index: stepIndex,
        action: {
          id: `action-${stepIndex}`,
          type: "wait",
          timeout: 2000,
          retries: 0,
          maxRetries: 0,
        },
        reasoning: "Unable to determine specific actions. Waiting for user input.",
        confidence: 0.3,
        verification: "Page state unchanged",
        risk: "low",
      });
  }

  return {
    steps,
    estimatedTime: steps.length * 1500, // ~1.5s per step
    riskLevel: steps.some((s) => s.risk === "high") ? "high" : 
               steps.some((s) => s.risk === "medium") ? "medium" : "low",
    requiresConfirmation: steps.some((s) => s.risk === "high"),
    dataMappings: intent.dataMappings || [],
  };
}

// ── Intent Classification ────────────────────────────────────

interface TaskIntent {
  type: "form_fill" | "navigation" | "data_extraction" | "multi_step" | "unknown";
  targetElements?: string[];
  dataMappings?: { fieldName: string; dataSource: string; value: string; confidence: number }[];
  parameters?: Record<string, string>;
}

function classifyIntent(description: string): TaskIntent {
  const lower = description.toLowerCase();

  // Form filling patterns
  if (
    lower.includes("fill") ||
    lower.includes("complete") ||
    lower.includes("submit") ||
    lower.includes("apply") ||
    lower.includes("register")
  ) {
    return {
      type: "form_fill",
      dataMappings: extractDataMappings(description),
    };
  }

  // Navigation patterns
  if (
    lower.includes("go to") ||
    lower.includes("open") ||
    lower.includes("navigate") ||
    lower.includes("visit")
  ) {
    const urlMatch = description.match(
      /(?:https?:\/\/)?(?:www\.)?[\w.-]+\.\w+[\w/.?]*/
    );
    return {
      type: "navigation",
      parameters: { url: urlMatch?.[0] || "" },
    };
  }

  // Data extraction patterns
  if (
    lower.includes("extract") ||
    lower.includes("get") ||
    lower.includes("find") ||
    lower.includes("search") ||
    lower.includes("read")
  ) {
    return { type: "data_extraction" };
  }

  // Multi-step (compound instructions)
  if (
    lower.includes("then") ||
    lower.includes("after that") ||
    lower.includes("and then") ||
    lower.includes(",") && lower.split(",").length > 2
  ) {
    return { type: "multi_step" };
  }

  return { type: "unknown" };
}

function extractDataMappings(
  description: string
): DataMapping[] {
  const mappings: DataMapping[] = [];

  // Look for patterns like "name: Shashank" or "fill name with X"
  const patterns = [
    /(\w+)\s*(?:as|:|=|with)\s*["']?([^"']+)["']?/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(description)) !== null) {
      mappings.push({
        fieldName: match[1],
        dataSource: "description",
        value: match[2].trim(),
        confidence: 0.8,
      });
    }
  }

  return mappings;
}

// ── Plan Generators ──────────────────────────────────────────

function planFormFill(
  pageState: PageState,
  intent: TaskIntent,
  dataContext?: Record<string, string>,
  startIdx = 0
): PlannedAction[] {
  const steps: PlannedAction[] = [];
  let idx = startIdx;

  // Find unfilled form fields
  const allFields = pageState.forms.flatMap((f) => f.fields);
  const unfilledFields = allFields.filter(
    (f) => !f.filledByUser && f.required
  );

  for (const field of unfilledFields) {
    // Find matching data
    const mapping = intent.dataMappings?.find(
      (m) =>
        m.fieldName.toLowerCase() === field.name.toLowerCase() ||
        m.fieldName.toLowerCase() === field.label.toLowerCase() ||
        field.label.toLowerCase().includes(m.fieldName.toLowerCase())
    );

    const value = mapping?.value || dataContext?.[field.name] || dataContext?.[field.label] || "";

    if (value) {
      steps.push({
        index: idx++,
        action: {
          id: `action-${idx}`,
          type: "click",
          target: field.id || field.name,
          retries: 0,
          maxRetries: MAX_RETRIES,
        },
        reasoning: `Click on "${field.label || field.name}" field to focus it`,
        confidence: 0.9,
        verification: "Field should be focused/active",
        risk: "low",
      });

      steps.push({
        index: idx++,
        action: {
          id: `action-${idx}`,
          type: "type",
          target: field.id || field.name,
          value,
          retries: 0,
          maxRetries: MAX_RETRIES,
        },
        reasoning: `Type "${value}" into "${field.label || field.name}" ` +
          `(expected format: ${field.type}, max ${field.maxLength || "no limit"} chars)`,
        confidence: mapping ? 0.85 : 0.5,
        verification: `Field value should be "${value}"`,
        risk: "low",
      });
    } else if (field.required) {
      // No data available for required field — ask user
      steps.push({
        index: idx++,
        action: {
          id: `action-${idx}`,
          type: "wait",
          timeout: 0, // Wait indefinitely for user
          retries: 0,
          maxRetries: 0,
        },
        reasoning: `Missing required data for "${field.label || field.name}". Need user input.`,
        confidence: 0.3,
        verification: "Waiting for user to provide value",
        risk: "low",
      });
    }
  }

  return steps;
}

function planNavigation(
  _pageState: PageState,
  intent: TaskIntent,
  startIdx = 0
): PlannedAction[] {
  const url = intent.parameters?.url;
  if (!url) return [];

  return [
    {
      index: startIdx,
      action: {
        id: `action-${startIdx}`,
        type: "navigate",
        value: url.startsWith("http") ? url : `https://${url}`,
        retries: 0,
        maxRetries: 1,
      },
      reasoning: `Navigate to ${url}`,
      confidence: 0.95,
      verification: "URL should change to target",
      risk: "low",
    },
  ];
}

function planExtraction(
  _pageState: PageState,
  _intent: TaskIntent,
  startIdx = 0
): PlannedAction[] {
  return [
    {
      index: startIdx,
      action: {
        id: `action-${startIdx}`,
        type: "wait",
        timeout: 1000,
        retries: 0,
        maxRetries: 0,
      },
      reasoning: "Extracting visible data from current page",
      confidence: 0.7,
      verification: "Data should be captured in page state",
      risk: "low",
    },
  ];
}

function planMultiStep(
  pageState: PageState,
  intent: TaskIntent,
  dataContext?: Record<string, string>,
  startIdx = 0
): PlannedAction[] {
  // For multi-step, generate form_fill + navigation combination
  const formSteps = planFormFill(pageState, intent, dataContext, startIdx);
  return formSteps;
}

// ── Plan Execution ───────────────────────────────────────────

interface ExecutionResult {
  success: boolean;
  summary: string;
  stepsCompleted: number;
  stepsTotal: number;
}

async function executePlan(
  task: AgentTask,
  plan: ActionPlan
): Promise<ExecutionResult> {
  let stepsCompleted = 0;

  for (const step of plan.steps) {
    // Check if task was cancelled
    if (state.abortController?.signal.aborted) {
      return {
        success: false,
        summary: "Task cancelled",
        stepsCompleted,
        stepsTotal: plan.steps.length,
      };
    }

    task.currentStep = step.index;
    broadcast({ type: "TASK_STATUS", payload: task });

    // Add reasoning
    await addReasoning(
      "think",
      `Step ${step.index + 1}: ${step.reasoning} ` +
        `(confidence: ${(step.confidence * 100).toFixed(0)}%)`
    );

    // Skip "wait for user" steps
    if (step.action.type === "wait" && step.action.timeout === 0) {
      await addReasoning(
        "reflect",
        "Waiting for user to provide missing data..."
      );
      // In a real implementation, this would pause and wait for user input
      continue;
    }

    // Execute the action
    task.status = "executing";
    broadcast({ type: "TASK_STATUS", payload: task });

    await addReasoning("act", `Executing: ${step.action.type}`);
    const startTime = performance.now();

    let result: ActionResult;
    let retryCount = 0;

    while (retryCount <= step.action.maxRetries) {
      result = await executeAction(step.action);
      result.executionTime = performance.now() - startTime;

      // Verify the action
      task.status = "verifying";
      broadcast({ type: "TASK_STATUS", payload: task });

      const verification = await verifyAction(step.action, result);
      result.verificationSignals = verification.signals;

      if (verification.passed || retryCount >= step.action.maxRetries) {
        break;
      }

      retryCount++;
      await addReasoning(
        "reflect",
        `Action failed verification (${verification.overallConfidence.toFixed(0)}%). ` +
          `Retrying... (${retryCount}/${step.action.maxRetries})`
      );
    }

    if (!result!.success) {
      await addReasoning(
        "reflect",
        `Step failed after ${retryCount} retries: ${result!.error}`
      );
      return {
        success: false,
        summary: `Failed at step ${step.index + 1}: ${result!.error}`,
        stepsCompleted,
        stepsTotal: plan.steps.length,
      };
    }

    stepsCompleted++;
    await addReasoning(
      "verify",
      `Step ${step.index + 1} completed successfully in ${result!.executionTime.toFixed(0)}ms`
    );

    // Human-like pacing between steps
    if (INTER_STEP_DELAY > 0) {
      await sleep(INTER_STEP_DELAY + Math.random() * 200);
    }
  }

  return {
    success: true,
    summary: `Task completed: ${stepsCompleted}/${plan.steps.length} steps`,
    stepsCompleted,
    stepsTotal: plan.steps.length,
  };
}

// ── Reasoning Trace ──────────────────────────────────────────

async function addReasoning(
  phase: ReasoningStep["phase"],
  reasoning: string
): Promise<void> {
  const step: ReasoningStep = {
    timestamp: Date.now(),
    phase,
    input: state.currentPageState?.url || "",
    reasoning,
    output: "",
    confidence: 1.0,
    duration: 0,
  };

  state.reasoningTrace.push(step);
  broadcast({ type: "UPDATE_DEBUG_OVERLAY", payload: { reasoningTrace: state.reasoningTrace } });
}

// ── Messaging ────────────────────────────────────────────────

function broadcast(message: { type: MessageType; payload: unknown }): void {
  // Send to side panel
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel might not be open
  });
}

// ── Utilities ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
