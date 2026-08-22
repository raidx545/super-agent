// ============================================================
// VLESS — Background Service Worker (Production)
// The orchestrator: routes messages, plans, verifies
//
// Architecture:
//   - Background: plans actions, manages task lifecycle, verifies
//   - Content Script: executes actions in page context (DOM is accessible there)
//   - Side Panel: displays status, learning log, privacy monitor
//
// Key design: Background NEVER touches the DOM directly.
// It sends messages to the content script which runs in page context.
// ============================================================

import { defineBackground } from "wxt/utils/define-background";
import type {
  Message,
  AgentTask,
  PageState,
  MessageType,
  PlannedAction,
  AgentAction,
  VerificationSignal,
} from "../../types";
import { checkOllamaAvailability, generatePlanWithLLM, isLLMAvailable, getLLMStatus } from "../../core/agent/llm-bridge";
import { log, narratePerception, narrateAction, narrateResult, narrateRetry, narrateLearning } from "../../core/agent/learning-log";
import { startMonitoring, stopMonitoring, isClean, getStats } from "../../core/privacy/network-monitor";
import { validateForm } from "../../core/agent/validator";
import { executeFullPipeline, type PipelineResult } from "../../core/pipeline/full-pipeline";

export default defineBackground({
  persistent: false,

  main() {
    // ── Extension Lifecycle ──────────────────────────────

    chrome.runtime.onInstalled.addListener(async () => {
      console.log("🐾 VLESS installed.");

      chrome.storage.local.set({
        settings: {
          autoPerceive: true,
          confirmHighRisk: true,
          showVisualDebug: true,
          maxRetries: 3,
          stepDelay: 300,
          language: "hi-IN",
        },
      });

      // Check Ollama on install
      const llmStatus = await checkOllamaAvailability();
      console.log("🐾 LLM:", llmStatus.available ? `Connected (${llmStatus.model})` : "Unavailable");
    });

    // Open side panel when extension icon is clicked
    chrome.action.onClicked.addListener((tab) => {
      if (tab.id) {
        chrome.sidePanel.open({ tabId: tab.id });
      }
    });

    // ── Message Router ───────────────────────────────────

    chrome.runtime.onMessage.addListener(
      (
        message: Message,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: any) => void
      ) => {
        handleMessage(message, sender)
          .then(sendResponse)
          .catch((error) => {
            console.error("Message handling error:", error);
            sendResponse({ error: error.message });
          });

        return true; // Keep channel open for async response
      }
    );

    async function handleMessage(
      message: Message,
      _sender: chrome.runtime.MessageSender
    ): Promise<unknown> {
      switch (message.type) {
        case "START_TASK":
          return handleStartTask(
            message.payload as { description: string; data?: Record<string, string> }
          );
        case "EXECUTE_PIPELINE":
          return handleExecutePipeline(
            message.payload as { description: string; data?: Record<string, string>; tabId?: number }
          );
        case "CANCEL_TASK":
          return { success: true, message: "Task cancelled" };
        case "PERCEIVE_PAGE":
          return handlePerceivePage();
        case "EXECUTE_ACTION":
          return handleExecuteAction(message.payload as AgentAction);
        case "GET_MEMORY":
          return handleGetMemory(message.payload as { domain: string });
        case "SAVE_MEMORY":
          return handleSaveMemory(message.payload as { domain: string; data: unknown });
        case "TOGGLE_OVERLAY":
          return { success: true };
        case "CHECK_LLM":
          return checkOllamaAvailability();
        case "GET_LLM_STATUS":
          return getLLMStatus();
        case "GET_PRIVACY_STATS":
          return getStats();
        case "DO_CAPTURE_TAB":
          return handleCaptureTab();
        default:
          return { error: `Unknown message type: ${message.type}` };
      }
    }

    // ══════════════════════════════════════════════════════
    // TASK ORCHESTRATION — The brain of the agent
    // ══════════════════════════════════════════════════════

    async function handleStartTask(payload: {
      description: string;
      data?: Record<string, string>;
    }): Promise<AgentTask> {
      console.log(`🐾 Starting task: "${payload.description}"`);

      // Start privacy monitoring
      startMonitoring();
      log("discovery", `Starting task: "${payload.description}"`);

      const task: AgentTask = {
        id: `task-${Date.now()}`,
        description: payload.description,
        status: "analyzing",
        plan: { steps: [], estimatedTime: 0, riskLevel: "low", requiresConfirmation: false, dataMappings: [] },
        currentStep: 0,
        totalSteps: 0,
        startTime: Date.now(),
      };

      broadcast({ type: "TASK_STATUS", payload: task });

      try {
        // ── PHASE 1: PERCEIVE ──────────────────────────
        log("discovery", "Scanning page...");
        const pageState = await handlePerceivePage();

        log("analysis", `Page: "${pageState.title}" | ${pageState.elements.length} interactive elements | ${pageState.forms.length} form(s)`);
        if (pageState.metadata.hasCAPTCHA) {
          log("warning", "⚠️ CAPTCHA detected — agent cannot bypass this");
        }
        if (pageState.metadata.hasHoneypot) {
          log("warning", "⚠️ Honeypot field detected — will skip");
        }

        narratePerception(pageState);

        // ── PHASE 2: PLAN ──────────────────────────────
        task.status = "planning";
        broadcast({ type: "TASK_STATUS", payload: task });
        log("analysis", "Generating action plan...");

        let plan;
        if (isLLMAvailable()) {
          log("analysis", "🧠 Using LLM for intelligent planning...");
          const llmResult = await generatePlanWithLLM(payload.description, pageState, payload.data);
          if (llmResult.usedLLM && llmResult.steps.length > 0) {
            log("learning", `LLM generated ${llmResult.steps.length} steps`);
            plan = {
              steps: llmResult.steps,
              estimatedTime: llmResult.steps.length * 1500,
              riskLevel: "low" as const,
              requiresConfirmation: false,
              dataMappings: [],
            };
          } else {
            plan = generateRuleBasedPlan(payload.description, pageState, payload.data);
          }
        } else {
          log("analysis", "📋 Using rule-based planning (Ollama not available)");
          plan = generateRuleBasedPlan(payload.description, pageState, payload.data);
        }

        task.plan = plan;
        task.totalSteps = plan.steps.length;
        log("analysis", `Plan: ${plan.steps.length} steps, ~${((plan.estimatedTime) / 1000).toFixed(1)}s`);

        if (plan.steps.length === 0) {
          log("warning", "No actions to perform — task complete");
          task.status = "completed";
          task.endTime = Date.now();
          task.result = "No actionable steps found on this page";
          broadcast({ type: "TASK_COMPLETE", payload: { task, privacyClean: isClean() } });
          return task;
        }

        // ── PHASE 2.5: VALIDATE ────────────────────────
        const allFormFields = pageState.forms.flatMap((f) => f.fields);
        if (allFormFields.length > 0) {
          const validation = validateForm(
            allFormFields.map((f) => ({
              name: f.name, id: f.id, label: f.label, type: f.type,
              value: f.value || payload.data?.[f.name] || payload.data?.[f.label] || "",
              placeholder: "", required: f.required, maxLength: f.maxLength, pattern: f.pattern,
            }))
          );
          if (!validation.allValid) {
            log("warning", `Validation warnings: ${validation.blockingIssues.join(", ")}`);
          } else if (allFormFields.some((f) => f.required)) {
            log("success", `All ${allFormFields.filter((f) => f.required).length} required fields validated OK`);
          }
        }

        // ── PHASE 3: EXECUTE ───────────────────────────
        task.status = "executing";
        broadcast({ type: "TASK_STATUS", payload: task });

        let stepsCompleted = 0;

        for (const step of plan.steps) {
          task.currentStep = step.index;
          broadcast({ type: "TASK_STATUS", payload: task });
          narrateAction(step.action);
          log("action", `Step ${step.index + 1}/${plan.steps.length}: ${step.reasoning}`);

          // Capture before state
          let beforeState: PageState | null = null;
          try {
            beforeState = await handlePerceivePage();
          } catch { /* optional */ }

          // Execute with retries
          let lastError = "";
          let success = false;

          for (let retry = 0; retry <= step.action.maxRetries; retry++) {
            if (retry > 0) {
              narrateRetry(retry, step.action.maxRetries, lastError);
              log("action", `Retry ${retry}/${step.action.maxRetries}: ${lastError}`);
              // Wait before retry (content may be loading)
              await sleep(500);
            }

            const result = await handleExecuteAction(step.action);

            if (result.success) {
              success = true;

              // ── VERIFY: Compare before/after page state ─
              const signals: VerificationSignal[] = [];

              try {
                const afterState = await handlePerceivePage();

                // DOM diff: did the page change?
                const elementCountChanged = beforeState
                  ? beforeState.elements.length !== afterState.elements.length
                  : false;
                const textChanged = beforeState
                  ? beforeState.textContent !== afterState.textContent
                  : false;
                const formsChanged = beforeState
                  ? JSON.stringify(beforeState.forms) !== JSON.stringify(afterState.forms)
                  : false;

                const pageChanged = elementCountChanged || textChanged || formsChanged;

                signals.push({
                  type: "dom_diff",
                  passed: true,
                  confidence: pageChanged ? 0.9 : 0.6,
                  details: pageChanged
                    ? "Page state changed after action"
                    : "Page unchanged (action may be visual only)",
                });

                if (pageChanged) {
                  log("success", `Step ${step.index + 1} verified: page changed`);
                } else {
                  log("analysis", `Step ${step.index + 1}: page unchanged (may be visual only)`);
                }

                // For type actions: verify the field value changed
                if (step.action.type === "type" && step.action.value) {
                  const targetField = afterState.forms
                    .flatMap((f) => f.fields)
                    .find((f) => f.id === step.action.target || f.name === step.action.target);

                  if (targetField) {
                    const valueMatches = targetField.value === step.action.value;
                    signals.push({
                      type: "dom_diff",
                      passed: valueMatches,
                      confidence: valueMatches ? 0.95 : 0.3,
                      details: valueMatches
                        ? `Field value matches: "${step.action.value}"`
                        : `Field value mismatch: expected "${step.action.value}", got "${targetField.value}"`,
                    });
                  }
                }
              } catch {
                // Verification is best-effort
                signals.push({
                  type: "dom_diff",
                  passed: true,
                  confidence: 0.5,
                  details: "Verification skipped — could not re-perceive page",
                });
              }

              narrateResult(true, signals.length > 0 ? `${signals.length} signal(s) checked` : undefined);
              break;
            }

            lastError = result.error || "Unknown error";
          }

          if (!success) {
            narrateResult(false, lastError);
            log("error", `Step ${step.index + 1} failed after retries: ${lastError}`);

            task.status = "failed";
            task.error = lastError;
            task.endTime = Date.now();
            stopMonitoring();
            broadcast({ type: "TASK_COMPLETE", payload: { task, privacyClean: isClean() } });
            return task;
          }

          stepsCompleted++;
          await sleep(300); // Brief pause between steps
        }

        // ── PHASE 4: COMPLETE ──────────────────────────
        task.status = "completed";
        task.endTime = Date.now();
        task.result = `Completed ${stepsCompleted}/${plan.steps.length} steps`;

        const elapsed = ((task.endTime - task.startTime) / 1000).toFixed(1);
        narrateLearning(`Task completed in ${elapsed}s. ${stepsCompleted} steps executed.`);
        log("success", `🎉 Task completed! ${stepsCompleted}/${plan.steps.length} steps in ${elapsed}s`);

        const finalStats = stopMonitoring();
        log("success", `🔒 Privacy: ${finalStats.outboundRequests} outbound requests, ${finalStats.bytesSent} bytes sent`);

        broadcast({ type: "TASK_COMPLETE", payload: { task, privacyClean: isClean(), privacyStats: finalStats } });
        return task;
      } catch (error) {
        task.status = "failed";
        task.endTime = Date.now();
        task.error = error instanceof Error ? error.message : "Unknown error";
        log("error", `Task failed: ${task.error}`);
        stopMonitoring();
        broadcast({ type: "TASK_COMPLETE", payload: { task, privacyClean: isClean() } });
        return task;
      }
    }

    // ══════════════════════════════════════════════════════
    // PAGE PERCEPTION — via content script
    // ══════════════════════════════════════════════════════

    async function handlePerceivePage(): Promise<PageState> {
      const tab = await getActiveTab();
      if (!tab?.id) {
        return createEmptyPageState();
      }

      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "PERCEIVE_PAGE",
          payload: null,
          source: "background",
          timestamp: Date.now(),
        } as Message);

        return response as PageState;
      } catch {
        // Content script not injected yet — inject and retry
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
          });
          await sleep(200);

          const response = await chrome.tabs.sendMessage(tab.id, {
            type: "PERCEIVE_PAGE",
            payload: null,
            source: "background",
            timestamp: Date.now(),
          } as Message);

          return response as PageState;
        } catch {
          return createEmptyPageState();
        }
      }
    }

    // ══════════════════════════════════════════════════════
    // ACTION EXECUTION — via content script
    // The content script has direct DOM access.
    // Background sends the action, content script executes it.
    // ══════════════════════════════════════════════════════

    async function handleExecuteAction(
      action: AgentAction
    ): Promise<{ success: boolean; error?: string }> {
      const tab = await getActiveTab();
      if (!tab?.id) {
        return { success: false, error: "No active tab found" };
      }

      try {
        // Send action to content script for execution
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "EXECUTE_ACTION",
          payload: action,
          source: "background",
          timestamp: Date.now(),
        } as Message);

        return response as { success: boolean; error?: string };
      } catch (error) {
        // Content script not ready — inject and retry
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
          });
          await sleep(300);

          const response = await chrome.tabs.sendMessage(tab.id, {
            type: "EXECUTE_ACTION",
            payload: action,
            source: "background",
            timestamp: Date.now(),
          } as Message);

          return response as { success: boolean; error?: string };
        } catch (retryError) {
          return {
            success: false,
            error: retryError instanceof Error ? retryError.message : "Failed to execute action",
          };
        }
      }
    }

    // ══════════════════════════════════════════════════════
    // RULE-BASED PLAN GENERATOR
    // When Ollama isn't available, generate a plan from rules
    // ══════════════════════════════════════════════════════

    function generateRuleBasedPlan(
      description: string,
      pageState: PageState,
      data?: Record<string, string>
    ) {
      const steps: PlannedAction[] = [];
      let idx = 0;
      const lower = description.toLowerCase();

      // Fill form: click + type each unfilled required field
      if (lower.includes("fill") || lower.includes("complete") || lower.includes("submit")) {
        const allFields = pageState.forms.flatMap((f) => f.fields);
        const unfilled = allFields.filter((f) => !f.filledByUser && f.required);

        for (const field of unfilled) {
          const value = data?.[field.name] || data?.[field.label] || "";
          const target = field.id || field.name || field.label;

          if (value) {
            // Click to focus
            steps.push({
              index: idx++,
              action: {
                id: `a-${idx}`, type: "click",
                target, retries: 0, maxRetries: 3,
              },
              reasoning: `Focus "${field.label || field.name}"`,
              confidence: 0.9,
              verification: "Field should be focused",
              risk: "low",
            });

            // Type value
            steps.push({
              index: idx++,
              action: {
                id: `a-${idx}`, type: "type",
                target, value, retries: 0, maxRetries: 3,
              },
              reasoning: `Type "${value}" in "${field.label || field.name}"`,
              confidence: 0.85,
              verification: `Field value should be "${value}"`,
              risk: "low",
            });
          } else if (field.options.length > 0) {
            // Select dropdown — pick first option as placeholder
            steps.push({
              index: idx++,
              action: {
                id: `a-${idx}`, type: "select",
                target, value: field.options[0] || "", retries: 0, maxRetries: 3,
              },
              reasoning: `Select "${field.options[0]}" in "${field.label || field.name}"`,
              confidence: 0.7,
              verification: "Option should be selected",
              risk: "low",
            });
          }
        }
      }

      // Scroll
      if (lower.includes("scroll")) {
        const dir = lower.includes("up") ? "up" : "down";
        steps.push({
          index: idx++,
          action: {
            id: `a-${idx}`, type: "scroll",
            value: dir, retries: 0, maxRetries: 1,
          },
          reasoning: `Scroll ${dir}`,
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
          action: {
            id: `a-${idx}`, type: "click",
            target: clickMatch[1].trim(), retries: 0, maxRetries: 3,
          },
          reasoning: `Click "${clickMatch[1].trim()}"`,
          confidence: 0.8,
          verification: "Element should respond",
          risk: "low",
        });
      }

      // Navigate
      const navMatch = lower.match(/(?:go to|open|navigate to|visit)\s+(.+)/);
      if (navMatch) {
        let url = navMatch[1].trim();
        if (!url.startsWith("http")) url = `https://${url}`;
        steps.push({
          index: idx++,
          action: {
            id: `a-${idx}`, type: "navigate",
            value: url, retries: 0, maxRetries: 1,
          },
          reasoning: `Navigate to "${url}"`,
          confidence: 0.9,
          verification: "URL should change",
          risk: "medium",
        });
      }

      // Fallback: no recognized command
      if (steps.length === 0) {
        steps.push({
          index: idx++,
          action: {
            id: `a-${idx}`, type: "wait",
            timeout: 1000, retries: 0, maxRetries: 0,
          },
          reasoning: `No actions recognized for: "${description}"`,
          confidence: 0.3,
          verification: "Page unchanged",
          risk: "low",
        });
      }

      return {
        steps,
        estimatedTime: steps.length * 1500,
        riskLevel: "low" as const,
        requiresConfirmation: false,
        dataMappings: [],
      };
    }

    // ══════════════════════════════════════════════════════
    // FULL PIPELINE — PII Detection + Redaction + Planning
    // ══════════════════════════════════════════════════════

    async function handleExecutePipeline(payload: {
      description: string;
      data?: Record<string, string>;
      tabId?: number;
    }): Promise<PipelineResult> {
      console.log(`🐾 [Pipeline] Starting: "${payload.description}"`);
      startMonitoring();

      const result = await executeFullPipeline({
        taskDescription: payload.description,
        dataContext: payload.data,
        tabId: payload.tabId,
      });

      // Log the result
      log("analysis", `Pipeline complete: ${result.steps.length} steps, ` +
        `${result.piiDetection.summary.totalRegions} PII regions detected, ` +
        `${result.redactionSummary.redacted} redacted`
      );

      if (result.plan.length > 0) {
        log("success", `Action plan: ${result.plan.length} steps from ${result.planResult.provider}`);
      } else {
        log("warning", "No action plan generated");
      }

      // Broadcast pipeline result to side panel
      broadcast({ type: "PIPELINE_COMPLETE", payload: result });

      return result;
    }

    // ══════════════════════════════════════════════════════
    // MEMORY
    // ══════════════════════════════════════════════════════

    async function handleGetMemory(payload: { domain: string }): Promise<unknown> {
      const r = await chrome.storage.local.get(`memory_${payload.domain}`);
      return r[`memory_${payload.domain}`] || null;
    }

    async function handleSaveMemory(payload: { domain: string; data: unknown }): Promise<void> {
      await chrome.storage.local.set({ [`memory_${payload.domain}`]: payload.data });
    }

    // ══════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════

    async function getActiveTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab;
    }

    function broadcast(message: { type: MessageType; payload: unknown }): void {
      chrome.runtime.sendMessage(message).catch(() => {});
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    }

    // ══════════════════════════════════════════════════════
    // SCREENSHOT CAPTURE — via chrome.tabCapture
    // Only works from service worker, not content script
    // ══════════════════════════════════════════════════════

    async function handleCaptureTab(): Promise<{
      success: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: string;
    }> {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          return { success: false, error: "No active tab" };
        }

        // Use chrome.tabCapture to capture the visible tab
        const stream = await (chrome.tabCapture as any).capture({
          video: true,
          videoConstraints: {
            mandatory: {
              chromeMediaSource: "tab",
              maxWidth: 1920,
              maxHeight: 1080,
            },
          },
        });

        if (!stream) {
          return { success: false, error: "Failed to capture tab" };
        }

        // Convert MediaStream to canvas to data URL
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;

        await new Promise<void>((resolve) => {
          video.onloadedmetadata = () => {
            video.play();
            requestAnimationFrame(() => resolve());
          };
        });

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(video, 0, 0);

        // Stop the stream
        stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        video.srcObject = null;

        const dataUrl = canvas.toDataURL("image/png", 0.8);

        return {
          success: true,
          dataUrl,
          width: canvas.width,
          height: canvas.height,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Capture failed",
        };
      }
    }

    function createEmptyPageState(): PageState {
      return {
        url: "", title: "", timestamp: Date.now(),
        elements: [], forms: [], textContent: "",
        metadata: {
          hasCAPTCHA: false, hasHoneypot: false, isSecure: true,
          hasFileUpload: false, hasPaymentForm: false,
          formCount: 0, totalElements: 0, interactiveElements: 0,
        },
        confidence: 0, perceptionTime: 0,
      };
    }
  },
});
