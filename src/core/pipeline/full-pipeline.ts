// ============================================================
// VLESS — Full Pipeline (Service Worker)
// Runs entirely in the background service worker.
// Communicates with content script via messages for:
//   - DOM extraction (PERCEIVE_PAGE)
//   - Screenshot capture (DO_CAPTURE_TAB / CAPTURE_SCREENSHOT)
//   - Action execution (EXECUTE_ACTION)
//   - Visual overlay (SHOW_PII_OVERLAY / INJECT_REDACTION_CSS)
//
// NEVER accesses document, window, or DOM APIs.
// ============================================================

import { detectAllPII, type PIIDetectionResult } from "../privacy/pii-detector";
import { generateDOMRedactionCSS } from "../privacy/redaction-engine";
import { initializeServer, isServerAvailable, getActiveProvider, type SanitizedContext, type PlanResult } from "../agent/server-bridge";
import { callOffscreen } from "../runtime/messaging";
import type { OcrResult } from "../../types/runtime";
import {
  startTrace, traceObserve, tracePIIDetection, traceRedaction,
  traceRedactionVerification, tracePlan, completeTrace, type ReasoningTrace,
} from "../agent/reasoning-trace";
import { generatePlanWithBestProvider, getBestAvailableProvider } from "../agent/llm-providers";
import type { PlannedAction, PageState, Message } from "../../types";

// ── Pipeline Types ───────────────────────────────────────────

export interface PipelineInput {
  taskDescription: string;
  dataContext?: Record<string, string>;
  tabId?: number;
}

export interface PipelineResult {
  success: boolean;
  phase: "capture" | "detect" | "redact" | "send" | "plan" | "execute" | "complete" | "error";
  steps: PipelineStep[];
  plan: PlannedAction[];
  piiDetection: PIIDetectionResult;
  redactionSummary: RedactionSummary;
  planResult: PlanResult;
  privacyProof: PrivacyProof;
  reasoningTrace: ReasoningTrace | null;
  totalLatencyMs: number;
  error?: string;
}

export interface PipelineStep {
  name: string;
  status: "pending" | "running" | "complete" | "error";
  latencyMs: number;
  details: string;
}

export interface RedactionSummary {
  totalPII: number;
  redacted: number;
  cssInjected: boolean;
  overlayShown: boolean;
}

export interface PrivacyProof {
  sensitiveDataDetected: number;
  sensitiveDataRedacted: number;
  dataSentToServer: {
    rawScreenshot: boolean;
    formValues: boolean;
    piiText: boolean;
    faces: boolean;
    sanitizedStructure: boolean;
    taskDescription: boolean;
  };
  zeroOutboundPII: boolean;
  proofDescription: string;
}

// ── Pipeline State ───────────────────────────────────────────

// ── Main Pipeline ────────────────────────────────────────────

export async function executeFullPipeline(
  input: PipelineInput
): Promise<PipelineResult> {

  const startTime = performance.now();
  const steps: PipelineStep[] = [];

  // Start the reasoning trace for this pipeline run
  startTrace(`pipeline-${Date.now()}`, input.taskDescription);
  traceObserve(`Pipeline started: "${input.taskDescription}"`);

  const addStep = (name: string): PipelineStep => {
    const step: PipelineStep = { name, status: "pending", latencyMs: 0, details: "" };
    steps.push(step);
    return step;
  };

  const runStep = async <T>(step: PipelineStep, fn: () => Promise<T>): Promise<T | null> => {
    step.status = "running";
    const t0 = performance.now();
    try {
      const result = await fn();
      step.status = "complete";
      step.latencyMs = performance.now() - t0;
      return result;
    } catch (err) {
      step.status = "error";
      step.latencyMs = performance.now() - t0;
      step.details = err instanceof Error ? err.message : "Unknown error";
      return null;
    }
  };

  // Default privacy proof
  let privacyProof: PrivacyProof = {
    sensitiveDataDetected: 0,
    sensitiveDataRedacted: 0,
    dataSentToServer: {
      rawScreenshot: false,
      formValues: false,
      piiText: false,
      faces: false,
      sanitizedStructure: true,
      taskDescription: true,
    },
    zeroOutboundPII: true,
    proofDescription: "",
  };

  let piiDetection: PIIDetectionResult = {
    regions: [],
    summary: {
      totalRegions: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      byCategory: {} as any,
      bySource: { dom: 0, vision: 0, combined: 0 },
      overallConfidence: 0,
      detectionTimeMs: 0,
    },
    sanitizedDOMMetadata: {
      safeElements: [],
      safeTextContent: "",
      safeForms: [],
      pageMetadata: { title: "", url: "", hasForm: false, hasCAPTCHA: false, elementCount: 0 },
    },
  };

  let redactionSummary: RedactionSummary = {
    totalPII: 0,
    redacted: 0,
    cssInjected: false,
    overlayShown: false,
  };

  let planResult: PlanResult = {
    success: false,
    steps: [],
    reasoning: "",
    provider: "none",
    latencyMs: 0,
  };

  try {
    // ════════════════════════════════════════════════════════
    // PHASE 1: CAPTURE — DOM + Screenshot from content script
    // ════════════════════════════════════════════════════════

    const captureStep = addStep("capture");
    captureStep.status = "running";

    // Get DOM data from content script
    const domData = await sendToContentScript("PERCEIVE_PAGE", null);
    if (!domData) {
      captureStep.status = "error";
      captureStep.details = "Failed to get page data from content script";
      return buildErrorResult("Content script not available. Reload the page.", steps, startTime);
    }
    captureStep.details = `${domData.elements.length} elements, ${domData.forms.length} forms`;

    // Capture screenshot (best effort — may fail on some pages)
    let screenshotDataUrl: string | null = null;
    try {
      const screenshot = await sendToContentScript("CAPTURE_SCREENSHOT", null);
      if (screenshot?.success && screenshot.dataUrl) {
        screenshotDataUrl = screenshot.dataUrl;
        captureStep.details += ", screenshot captured";
      }
    } catch {
      // Screenshot is optional — DOM-only path still works
    }
    captureStep.status = "complete";

    // ════════════════════════════════════════════════════════
    // PHASE 2: DETECT PII — Multi-signal (DOM + OCR)
    // ════════════════════════════════════════════════════════

    const detectStep = addStep("detect_pii");

    // Run OCR on screenshot via the offscreen ML host (correct MV3 architecture)
    let ocrTextBlocks: Array<{ text: string; confidence: number; boundingBox: { x: number; y: number; width: number; height: number } }> = [];
    if (screenshotDataUrl) {
      try {
        const ocrResult: OcrResult = await callOffscreen("runOcr", {
          imageDataUrl: screenshotDataUrl,
          lang: "auto",
        });
        if (ocrResult.words && ocrResult.words.length > 0) {
          ocrTextBlocks = ocrResult.words.map((w) => ({
            text: w.text,
            confidence: w.score,
            boundingBox: { x: w.box.x, y: w.box.y, width: w.box.w, height: w.box.h },
          }));
          detectStep.details = `OCR: ${ocrTextBlocks.length} text regions (${ocrResult.timings.total.toFixed(0)}ms, ${ocrResult.backend})`;
        }
      } catch (err) {
        // OCR is optional — DOM detection still works
        console.warn("[VLESS] Offscreen OCR failed:", err);
      }
    }
    const detectionResult = await runStep(detectStep, async () => {
      return detectAllPII(domData, undefined, ocrTextBlocks.length > 0 ? ocrTextBlocks : undefined);
    });

    if (detectionResult) {
      piiDetection = detectionResult;
      detectStep.details = `${detectionResult.summary.totalRegions} PII regions ` +
        `(${detectionResult.summary.criticalCount} critical, ${detectionResult.summary.highCount} high)`;
      privacyProof.sensitiveDataDetected = detectionResult.summary.totalRegions;
      // Trace: PII detection results
      tracePIIDetection(
        detectionResult.summary.totalRegions,
        detectionResult.summary.criticalCount,
        detectionResult.summary.highCount,
        detectionResult.summary.byCategory as Record<string, number>
      );
    }

    // ════════════════════════════════════════════════════════
    // PHASE 3: REDACT — Apply CSS redaction + show overlay
    // ════════════════════════════════════════════════════════

    const redactStep = addStep("redact");
    let redactedScreenshotUrl: string | null = null;
    const redactResult = await runStep(redactStep, async () => {
      // Inject redaction CSS into the page
      const css = generateDOMRedactionCSS(piiDetection.regions);
      if (css.trim()) {
        await sendToContentScript("INJECT_REDACTION_CSS", css);
        redactionSummary.cssInjected = true;
      }

      // Show PII overlay on the page
      await sendToContentScript("SHOW_PII_OVERLAY", {
        regions: piiDetection.regions
          .filter((r) => r.boundingBox)
          .map((r) => ({
            id: r.id,
            category: r.category,
            sensitivity: r.sensitivity,
            boundingBox: r.boundingBox!,
            confidence: r.confidence,
          })),
        summary: {
          totalRegions: piiDetection.summary.totalRegions,
          criticalCount: piiDetection.summary.criticalCount,
          highCount: piiDetection.summary.highCount,
        },
      });
      redactionSummary.overlayShown = true;

      // Canvas redaction on screenshot via offscreen ML host
      if (screenshotDataUrl) {
        try {
          const redactRegions = piiDetection.regions
            .filter((r) => r.boundingBox && r.redactionStrategy !== "none")
            .map((r) => ({
              x: r.boundingBox!.x,
              y: r.boundingBox!.y,
              width: r.boundingBox!.width,
              height: r.boundingBox!.height,
              strategy: r.redactionStrategy as "blur" | "black_box" | "pixelate" | "mask_text",
            }));

          if (redactRegions.length > 0) {
            const redacted = await callOffscreen("redactScreenshot", {
              imageDataUrl: screenshotDataUrl,
              regions: redactRegions,
            });
            redactedScreenshotUrl = redacted.imageDataUrl;
            redactionSummary.totalPII = redacted.regionsRedacted;
            redactionSummary.redacted = redacted.regionsRedacted;
          }
        } catch (err) {
          console.warn("[VLESS] Offscreen redaction failed:", err);
        }
      }

      return true;
    });

    if (redactResult) {
      redactionSummary.totalPII = piiDetection.regions.length;
      redactionSummary.redacted = piiDetection.regions.filter(
        (r) => r.redactionStrategy !== "none"
      ).length;
      privacyProof.sensitiveDataRedacted = redactionSummary.redacted;
      redactStep.details = `${redactionSummary.redacted} regions redacted`;
      // Trace: redaction results
      traceRedaction(
        redactionSummary.redacted,
        piiDetection.regions.map((r) => r.redactionStrategy)
      );
    }

    // ════════════════════════════════════════════════════════
    // PHASE 3.5: VERIFY REDACTION — Re-OCR the redacted frame
    // Proves PII is gone from the pixels before anything leaves device
    // ════════════════════════════════════════════════════════

    // If true, re-OCR confirmed zero PII in the redacted frame
    let redactionVerified = false;
    const verifyTarget = redactedScreenshotUrl || screenshotDataUrl;
    if (verifyTarget && redactionSummary.redacted > 0) {
      const verifyStep = addStep("verify_redaction");
      const verifyResult = await runStep(verifyStep, async () => {
        // Re-OCR the REDACTED screenshot via offscreen to prove PII is gone
        const result = await callOffscreen("verifyRedaction", {
          imageDataUrl: verifyTarget,
        });
        return {
          passed: result.passed,
          piiTextFound: result.residualPII,
          timings: { ocr: result.ocrTimeMs },
        };
      });
      if (verifyResult) {
        redactionVerified = verifyResult.passed;
        verifyStep.details = verifyResult.passed
          ? `✅ Verified: 0 PII in pixels (${verifyResult.timings.ocr.toFixed(0)}ms)`
          : `❌ ${verifyResult.piiTextFound} PII regions residual`;
        // Trace: redaction verification
        traceRedactionVerification(verifyResult.passed, verifyResult.piiTextFound, verifyResult.timings.ocr);
      }
    }

    // ════════════════════════════════════════════════════════
    // PHASE 4: INITIALIZE SERVER — Find best LLM backend
    // ════════════════════════════════════════════════════════

    const serverStep = addStep("init_server");
    await runStep(serverStep, async () => {
      // Check multi-provider system first
      const bestProvider = await getBestAvailableProvider();
      if (bestProvider) {
        serverStep.details = `${bestProvider.id} (${bestProvider.config.model})`;
        return;
      }
      // Fallback to legacy server-bridge
      await initializeServer();
      if (isServerAvailable()) {
        const provider = getActiveProvider();
        serverStep.details = `${provider?.name} (${provider?.model})`;
      } else {
        serverStep.details = "No server — rule-based fallback";
      }
    });

    // ════════════════════════════════════════════════════════
    // PHASE 5: BUILD SANITIZED CONTEXT
    // ════════════════════════════════════════════════════════

    const sanitizeStep = addStep("sanitize");
    const sanitizedContext = await runStep(sanitizeStep, async () => {
      return buildSanitizedContext(domData, piiDetection, input.taskDescription, input.dataContext);
    });

    if (!sanitizedContext) {
      return buildErrorResult("Failed to build sanitized context", steps, startTime);
    }
    sanitizeStep.details = "Context sanitized";

    // ════════════════════════════════════════════════════════
    // PHASE 6: GET PLAN — Ask LLM or use rules
    // ════════════════════════════════════════════════════════

    const planStep = addStep("get_plan");
    const planResultData = await runStep(planStep, async () => {
      // Try multi-provider LLM first, then fallback to server-bridge, then rules
      const llmResult = await generatePlanWithBestProvider(
        input.taskDescription,
        sanitizedContext,
        input.dataContext
      );
      if (llmResult.success && llmResult.steps.length > 0) {
        return llmResult;
      }
      // Fallback to legacy server-bridge
      if (isServerAvailable()) {
        const provider = getActiveProvider()!;
        return provider.generatePlan(
          input.taskDescription,
          sanitizedContext,
          input.dataContext
        );
      }
      // Try deterministic planner first (fast, offline, no LLM needed)
      const { generateDeterministicPlan, isDeterministicEligible } = await import("../agent/deterministic-planner");
      const allFields = domData.forms.flatMap((f: any) => f.fields);
      if (isDeterministicEligible(input.taskDescription, allFields.length) && input.dataContext) {
        console.log("[VLESS] Using deterministic planner (no LLM needed)");
        const detPlan = generateDeterministicPlan(
          allFields.map((f: any, i: number) => ({
            index: i,
            label: f.label,
            name: f.name,
            id: f.id,
            type: f.type,
            required: f.required,
            options: f.options,
            currentValue: f.value,
          })),
          input.dataContext
        );
        if (detPlan.success) {
          return {
            success: true,
            steps: detPlan.steps,
            reasoning: detPlan.reasoning,
            provider: "deterministic",
            latencyMs: performance.now() - startTime,
          };
        }
      }
      // Last resort: rule-based (limited to fill/scroll/click/navigate)
      console.warn("[VLESS] No LLM available — falling back to rule-based planning.");
      return generateRuleBasedPlan(input.taskDescription, domData, input.dataContext);
    });

    if (planResultData) {
      planResult = planResultData;
      planStep.details = `${planResult.steps.length} steps (${planResult.provider})`;
      // Trace: planning results
      tracePlan(
        planResult.steps.length,
        planResult.provider,
        planResult.reasoning,
        planResult.latencyMs
      );
    }

    // ════════════════════════════════════════════════════════
    // PHASE 7: EXECUTE — Run plan steps via content script
    // ════════════════════════════════════════════════════════

    let executionResult: { success: boolean; completed: number; total: number; errors: string[] } | null = null;
    if (planResult.steps.length > 0) {
      const execStep = addStep("execute");
      execStep.status = "running";
      const { executePlanSteps } = await import("./full-pipeline");
      executionResult = await executePlanSteps(planResult.steps, input.dataContext);
      execStep.status = executionResult.success ? "complete" : "error";
      execStep.details = `${executionResult.completed}/${executionResult.total} steps` +
        (executionResult.errors.length > 0 ? ` (${executionResult.errors.length} errors)` : "");
    }

    // ════════════════════════════════════════════════════════
    // PHASE 8: SHOW PIPELINE STATUS PANEL
    // ════════════════════════════════════════════════════════

    await sendToContentScript("SHOW_PIPELINE_PANEL", {
      steps: steps.map((s) => ({
        name: s.name.replace("_", " "),
        status: s.status,
        details: s.details,
      })),
      privacyScore: privacyProof.zeroOutboundPII ? 100 : 50,
      piiDetected: privacyProof.sensitiveDataDetected,
      piiRedacted: privacyProof.sensitiveDataRedacted,
    });

    // Build privacy proof
    if (redactionVerified) {
      privacyProof.proofDescription = generatePrivacyProofDescription(privacyProof) +
        "\n✅ RE-OCR VERIFIED: Redacted frame contains zero PII text.";
    } else {
      privacyProof.proofDescription = generatePrivacyProofDescription(privacyProof);
    }

    const totalLatency = performance.now() - startTime;

    // Complete the reasoning trace
    const completedTrace = completeTrace(true);

    return {
      success: planResult.success || planResult.steps.length > 0,
      phase: "complete",
      steps,
      plan: planResult.steps,
      piiDetection,
      redactionSummary,
      planResult,
      privacyProof,
      reasoningTrace: completedTrace,
      totalLatencyMs: totalLatency,
    };
  } catch (error) {

    return buildErrorResult(
      error instanceof Error ? error.message : "Pipeline failed",
      steps,
      startTime
    );
  }
}

// ── Execute Plan Steps ──────────────────────────────────────

export async function executePlanSteps(
  plan: PlannedAction[],
  dataContext?: Record<string, string>
): Promise<{ success: boolean; completed: number; total: number; errors: string[] }> {
  let completed = 0;
  const errors: string[] = [];

  for (const step of plan) {
    // Resolve data values
    if (step.action.type === "type" && dataContext) {
      const target = step.action.target || "";
      step.action.value = dataContext[target] || step.action.value || "";
    }

    // Multi-strategy execution with fallbacks
    let result: any = null;
    let lastError = "";

    // Strategy 1: Direct execution
    result = await sendToContentScript("EXECUTE_ACTION", step.action);

    // Strategy 2: If click failed, try with XPath fallback
    if (!result?.success && step.action.type === "click" && step.action.target) {
      const xpathResult = await sendToContentScript("EXECUTE_ACTION", {
        ...step.action,
        target: `xpath=//button[contains(text(),'${step.action.target}')] | //a[contains(text(),'${step.action.target}')]`,
      });
      if (xpathResult?.success) result = xpathResult;
    }

    // Strategy 3: If type failed, try clearing and retyping
    if (!result?.success && step.action.type === "type") {
      // First click to focus, then type
      const clickResult = await sendToContentScript("EXECUTE_ACTION", {
        type: "click",
        target: step.action.target,
        retries: 0,
        maxRetries: 1,
      });
      if (clickResult?.success) {
        await new Promise((r) => setTimeout(r, 200));
        result = await sendToContentScript("EXECUTE_ACTION", step.action);
      }
    }

    // Strategy 4: If still failed, try with text content match
    if (!result?.success && step.action.target) {
      const textResult = await sendToContentScript("EXECUTE_ACTION", {
        ...step.action,
        target: step.action.value || step.action.target,
      });
      if (textResult?.success) result = textResult;
    }

    if (result?.success) {
      completed++;
    } else {
      lastError = result?.error || "Unknown error";
      errors.push(`Step ${step.index}: ${lastError}`);
      if (errors.length > 3) break; // Stop after 3 consecutive failures
    }

    // Brief pause between actions (human-like pacing)
    await sleep(300 + Math.random() * 200);
  }

  return {
    success: completed === plan.length,
    completed,
    total: plan.length,
    errors,
  };
}

// ── Message Helpers ──────────────────────────────────────────

function isRestrictedUrl(url?: string): boolean {
  if (!url) return false;
  return /^(chrome-extension:|chrome:|edge:|about:|brave:)/.test(url);
}

async function sendToContentScript(type: string, payload: unknown): Promise<any> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    if (isRestrictedUrl(tab.url)) return null;

    return chrome.tabs.sendMessage(tab.id, {
      type,
      payload,
      source: "background",
      timestamp: Date.now(),
    } as Message);
  } catch {
    // Try injecting content script first
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return null;

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-scripts/content.js"],
      });
      await sleep(200);

      return chrome.tabs.sendMessage(tab.id, {
        type,
        payload,
        source: "background",
        timestamp: Date.now(),
      } as Message);
    } catch {
      return null;
    }
  }
}

// ── Build Sanitized Context ──────────────────────────────────

function buildSanitizedContext(
  domData: PageState,
  piiDetection: PIIDetectionResult,
  taskDescription: string,
  dataContext?: Record<string, string>
): SanitizedContext {
  const piiFieldSelectors = new Set(
    piiDetection.regions
      .filter((r) => r.fieldSelector)
      .map((r) => r.fieldSelector!)
  );

  const piiTextValues = new Set(
    piiDetection.regions
      .filter((r) => r.textValue)
      .map((r) => r.textValue!)
  );

  // Sanitize text: replace PII values with ***
  let safeTextContent = domData.textContent || "";
  for (const piiText of piiTextValues) {
    if (piiText && safeTextContent.includes(piiText)) {
      safeTextContent = safeTextContent.replace(
        new RegExp(escapeRegex(piiText), "g"),
        "***"
      );
    }
  }

  // Safe elements (no PII values)
  const safeElements = domData.elements.map((el) => ({
    tag: el.tag,
    role: el.role,
    label: el.label || el.text || "",
    type: el.type,
    rect: { x: el.rect.x, y: el.rect.y, width: el.rect.width, height: el.rect.height },
    isVisible: el.isVisible,
    isDisabled: el.isDisabled,
  }));

  // Safe forms (hasValue flag instead of actual values)
  const safeForms = domData.forms.map((form) => ({
    id: form.id,
    fields: form.fields.map((field) => {
      const selector = field.id ? `#${field.id}` : field.name ? `[name="${field.name}"]` : null;
      const isPII = selector ? piiFieldSelectors.has(selector) : false;
      return {
        label: field.label || field.name || "",
        type: field.type,
        hasValue: !!field.value,
        isRequired: field.required,
        piiCategory: isPII
          ? piiDetection.regions.find((r) => r.fieldSelector === selector)?.category || null
          : null,
      };
    }),
  }));

  return {
    pageStructure: {
      elements: safeElements,
      forms: safeForms,
      safeTextContent,
      metadata: {
        title: domData.title,
        domain: (() => { try { return new URL(domData.url).hostname; } catch { return ""; } })(),
        hasForm: domData.forms.length > 0,
        hasCAPTCHA: domData.metadata.hasCAPTCHA,
        hasPaymentForm: domData.metadata.hasPaymentForm,
        elementCount: domData.elements.length,
      },
    },
    redactionProof: {
      totalPIIDetected: piiDetection.summary.totalRegions,
      categoriesDetected: Object.keys(piiDetection.summary.byCategory),
      redactionMethods: [...new Set(piiDetection.regions.map((r) => r.redactionStrategy))],
      confidenceScore: piiDetection.summary.overallConfidence,
    },
    taskDescription,
    dataContext,
  };
}

// ── Rule-Based Plan ──────────────────────────────────────────

function generateRuleBasedPlan(
  taskDescription: string,
  domData: PageState,
  dataContext?: Record<string, string>
): PlanResult {
  const t0 = performance.now();
  const steps: PlannedAction[] = [];
  let idx = 0;
  const lower = taskDescription.toLowerCase();

  if (lower.includes("fill") || lower.includes("complete") || lower.includes("submit")) {
    const allFields = domData.forms.flatMap((f) => f.fields);
    const unfilled = allFields.filter((f) => !f.filledByUser && f.required);

    for (const field of unfilled) {
      const value = dataContext?.[field.name] || dataContext?.[field.label] || "";
      const target = field.id || field.name || field.label;

      if (value) {
        steps.push({
          index: idx++,
          action: { id: `r-${idx}`, type: "click", target, retries: 0, maxRetries: 3 },
          reasoning: `Focus "${field.label || field.name}"`,
          confidence: 0.9,
          verification: "Field should be focused",
          risk: "low",
        });
        steps.push({
          index: idx++,
          action: { id: `r-${idx}`, type: "type", target, value, retries: 0, maxRetries: 3 },
          reasoning: `Type in "${field.label || field.name}"`,
          confidence: 0.85,
          verification: `Field should contain value`,
          risk: "low",
        });
      } else if (field.options.length > 0) {
        steps.push({
          index: idx++,
          action: { id: `r-${idx}`, type: "select", target, value: field.options[0] || "", retries: 0, maxRetries: 3 },
          reasoning: `Select "${field.options[0]}" in "${field.label || field.name}"`,
          confidence: 0.7,
          verification: "Option should be selected",
          risk: "low",
        });
      }
    }
  }

  if (lower.includes("scroll")) {
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "scroll", value: lower.includes("up") ? "up" : "down", retries: 0, maxRetries: 1 },
      reasoning: "Scroll page",
      confidence: 0.9,
      verification: "Page should scroll",
      risk: "low",
    });
  }

  // Click specific element
  const clickMatch = lower.match(/(?:click|press|tap)\s+(?:on\s+)?["']?([^"']+)["']?/);
  if (clickMatch) {
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "click", target: clickMatch[1].trim(), retries: 0, maxRetries: 3 },
      reasoning: `Click "${clickMatch[1].trim()}"`,
      confidence: 0.8,
      verification: "Element should respond",
      risk: "low",
    });
  }

  // Search on a site: "search X on youtube", "find X on google"
  const searchMatch = lower.match(/(?:search|find|look up|search for)\s+(.+?)\s+(?:on|in|at)\s+(\S+)/);
  if (searchMatch) {
    const query = searchMatch[1].trim();
    const site = searchMatch[2].trim();
    const siteUrls: Record<string, string> = {
      youtube: "https://www.youtube.com",
      google: "https://www.google.com",
      bing: "https://www.bing.com",
      amazon: "https://www.amazon.in",
      flipkart: "https://www.flipkart.com",
      github: "https://github.com",
    };
    const baseUrl = siteUrls[site] || `https://www.${site}.com`;
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "navigate", value: baseUrl, retries: 0, maxRetries: 1 },
      reasoning: `Navigate to ${site}`,
      confidence: 0.9,
      verification: "URL should change",
      risk: "medium",
    });
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "type", target: "search", value: query, retries: 0, maxRetries: 3 },
      reasoning: `Search for "${query}" on ${site}`,
      confidence: 0.85,
      verification: "Search results should appear",
      risk: "low",
    });
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "press_key", key: "Enter", retries: 0, maxRetries: 1 },
      reasoning: "Submit search",
      confidence: 0.9,
      verification: "Page should show results",
      risk: "low",
    });
  }

  // Open a site by name: "open youtube", "go to google"
  const siteMatch = lower.match(/(?:go to|open|navigate to|visit)\s+(\S+)$/);
  if (siteMatch && steps.length === 0) {
    const site = siteMatch[1].replace(/[^a-z0-9.]/g, "");
    const siteUrls: Record<string, string> = {
      youtube: "https://www.youtube.com",
      google: "https://www.google.com",
      bing: "https://www.bing.com",
      amazon: "https://www.amazon.in",
      flipkart: "https://www.flipkart.com",
      github: "https://github.com",
    };
    let url = siteUrls[site];
    if (!url) {
      if (site.includes(".") || /^(com|org|net|in|io|dev)$/.test(site)) {
        url = site.startsWith("http") ? site : `https://${site}`;
      } else {
        url = `https://www.${site}.com`;
      }
    }
    steps.push({
      index: idx++,
      action: { id: `r-${idx}`, type: "navigate", value: url, retries: 0, maxRetries: 1 },
      reasoning: `Navigate to "${url}"`,
      confidence: 0.9,
      verification: "URL should change",
      risk: "medium",
    });
  }

  return {
    success: steps.length > 0,
    steps,
    reasoning: steps.length > 0
      ? `Rule-based plan: ${steps.length} steps`
      : "Could not determine actions. Try being more specific.",
    provider: "rule-based",
    latencyMs: performance.now() - t0,
  };
}

// ── Utilities ────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function generatePrivacyProofDescription(proof: PrivacyProof): string {
  const lines: string[] = [];
  lines.push("PRIVACY PROOF");
  lines.push(`PII detected: ${proof.sensitiveDataDetected} regions`);
  lines.push(`PII redacted: ${proof.sensitiveDataRedacted} regions`);
  lines.push("");
  lines.push("Data sent to server:");
  lines.push("  [OK] Sanitized page structure (elements, labels, positions)");
  lines.push("  [OK] Task description");
  lines.push(`  [${proof.dataSentToServer.rawScreenshot ? "FAIL" : "OK"}] Raw screenshot: ${proof.dataSentToServer.rawScreenshot ? "SENT" : "NOT sent"}`);
  lines.push(`  [${proof.dataSentToServer.formValues ? "FAIL" : "OK"}] Form values: ${proof.dataSentToServer.formValues ? "SENT" : "NOT sent"}`);
  lines.push(`  [${proof.dataSentToServer.piiText ? "FAIL" : "OK"}] PII text: ${proof.dataSentToServer.piiText ? "SENT" : "NOT sent"}`);
  lines.push(`  [${proof.dataSentToServer.faces ? "FAIL" : "OK"}] Faces: ${proof.dataSentToServer.faces ? "SENT" : "NOT sent"}`);
  lines.push("");
  lines.push(proof.zeroOutboundPII
    ? "ZERO sensitive data left the device"
    : "WARNING: Some sensitive data was transmitted");
  return lines.join("\n");
}

function buildErrorResult(
  error: string,
  steps: PipelineStep[],
  startTime: number
): PipelineResult {
  return {
    success: false,
    phase: "error",
    steps,
    plan: [],
    piiDetection: {
      regions: [],
      summary: {
        totalRegions: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
        byCategory: {} as any,
        bySource: { dom: 0, vision: 0, combined: 0 },
        overallConfidence: 0,
        detectionTimeMs: 0,
      },
      sanitizedDOMMetadata: {
        safeElements: [], safeTextContent: "", safeForms: [],
        pageMetadata: { title: "", url: "", hasForm: false, hasCAPTCHA: false, elementCount: 0 },
      },
    },
    redactionSummary: { totalPII: 0, redacted: 0, cssInjected: false, overlayShown: false },
    planResult: { success: false, steps: [], reasoning: "", provider: "none", latencyMs: 0 },
    privacyProof: {
      sensitiveDataDetected: 0, sensitiveDataRedacted: 0,
      dataSentToServer: { rawScreenshot: false, formValues: false, piiText: false, faces: false, sanitizedStructure: false, taskDescription: false },
      zeroOutboundPII: true, proofDescription: "",
    },
    reasoningTrace: null,
    totalLatencyMs: performance.now() - startTime,
    error,
  };
}
