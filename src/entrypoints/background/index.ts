// ============================================================
// VLESS — Background Service Worker
// The orchestrator: routes messages between side panel ↔ content script
// FULLY INTEGRATED: HybridPerceiver + LLM + Visual Diff + Learning Log
// ============================================================

import { defineBackground } from "wxt/utils/define-background";
import type {
  Message,
  AgentTask,
  PageState,
  MessageType,
  PlannedAction,
} from "../../types";
import { checkOllamaAvailability, generatePlanWithLLM, isLLMAvailable, getLLMStatus } from "../../core/agent/llm-bridge";
import { log, narratePerception, narrateAction, narrateResult, narrateRetry, narrateLearning } from "../../core/agent/learning-log";
import { startMonitoring, stopMonitoring, isClean, getStats } from "../../core/privacy/network-monitor";
import { validateForm } from "../../core/agent/validator";
import { getHybridPerceiver } from "../../core/perception/hybrid-perceiver";
import { getModelManager } from "../../core/models/model-manager";

export default defineBackground({
  persistent: false,

  main() {
    const perceiver = getHybridPerceiver();
    const modelManager = getModelManager();

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

      // Check Ollama + detect backend on install
      const [llmStatus] = await Promise.all([
        checkOllamaAvailability(),
        modelManager.detectBackend(),
      ]);
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

        return true;
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
        case "CANCEL_TASK":
          return { success: true, message: "Task cancelled" };
        case "PERCEIVE_PAGE":
          return handlePerceivePage();
        case "EXECUTE_ACTION":
          return handleExecuteAction(message.payload);
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
        default:
          return { error: `Unknown message type: ${message.type}` };
      }
    }

    // ── Task Management (FULLY INTEGRATED) ───────────────

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
        // ── PHASE 1: PERCEIVE (Hybrid Perceiver) ────────
        log("discovery", "Perceiving page with hybrid DOM+Vision pipeline...");
        const perceptionResult = await perceiver.perceive();
        const pageState = perceptionResult.pageState;

        log("analysis", `Source: ${perceptionResult.source} | Confidence: ${(perceptionResult.domConfidence * 100).toFixed(0)}%`);
        log("analysis", `Elements: ${pageState.elements.length} | Forms: ${pageState.forms.length}`);
        narratePerception(pageState);

        // ── PHASE 2: PLAN (LLM or Rule-Based) ──────────
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
          plan = generateRuleBasedPlan(payload.description, pageState, payload.data);
        }

        task.plan = plan;
        task.totalSteps = plan.steps.length;
        log("analysis", `Plan: ${plan.steps.length} steps, ~${((plan.estimatedTime) / 1000).toFixed(1)}s`);

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
            log("warning", `Validation: ${validation.blockingIssues.join(", ")}`);
          } else if (allFormFields.some((f) => f.required)) {
            log("success", `All ${allFormFields.filter((f) => f.required).length} required fields validated OK`);
          }
        }

        // ── PHASE 3: EXECUTE (with retry + visual diff) ─
        task.status = "executing";
        broadcast({ type: "TASK_STATUS", payload: task });

        let stepsCompleted = 0;
        for (const step of plan.steps) {
          task.currentStep = step.index;
          broadcast({ type: "TASK_STATUS", payload: task });
          narrateAction(step.action);
          log("action", `Step ${step.index + 1}: ${step.reasoning}`);

          // Capture before state for verification
          let beforeState: { pageState: PageState } | null = null;
          try {
            beforeState = await perceiver.perceive();
          } catch { /* optional */ }

          // Execute with retries
          let lastError = "";
          let success = false;
          for (let retry = 0; retry <= step.action.maxRetries; retry++) {
            if (retry > 0) narrateRetry(retry, step.action.maxRetries, lastError);

            const result = await handleExecuteAction(step.action);
            if (result.success) {
              success = true;

              // ── VISUAL DIFF VERIFICATION ──────────────
              try {
                const afterState = await perceiver.perceive();
                const domChanged = beforeState
                  ? beforeState.pageState.elements.length !== afterState.pageState.elements.length ||
                    beforeState.pageState.textContent !== afterState.pageState.textContent
                  : true;

                if (domChanged) {
                  log("success", `Step ${step.index + 1} verified: page changed as expected`);
                  narrateResult(true, "Page state changed — action confirmed");
                } else {
                  log("warning", `Step ${step.index + 1}: page unchanged — may need verification`);
                  narrateResult(true, "Action executed (page unchanged — may need visual check)");
                }
              } catch {
                narrateResult(true);
              }
              break;
            }
            lastError = result.error || "Unknown error";
          }

          if (!success) {
            narrateResult(false, lastError);
            log("error", `Step ${step.index + 1} failed: ${lastError}`);

            // ── LLM FAILURE ANALYSIS ───────────────────
            if (isLLMAvailable() && beforeState) {
              try {
                const { analyzeFailure } = await import("../../core/agent/llm-bridge");
                const analysis = await analyzeFailure(step.action, lastError, beforeState.pageState);
                log("analysis", `LLM analysis: ${analysis.analysis}`);
              } catch { /* optional */ }
            }

            task.status = "failed";
            task.error = lastError;
            task.endTime = Date.now();
            stopMonitoring();
            broadcast({ type: "TASK_COMPLETE", payload: { task, privacyClean: isClean() } });
            return task;
          }

          stepsCompleted++;
          await sleep(500);
        }

        // ── PHASE 4: COMPLETE ──────────────────────────
        task.status = "completed";
        task.endTime = Date.now();
        task.result = `Completed ${stepsCompleted}/${plan.steps.length} steps`;

        const elapsed = ((task.endTime - task.startTime) / 1000).toFixed(1);
        narrateLearning(`Task completed in ${elapsed}s. ${stepsCompleted} steps executed.`);
        log("success", `🎉 Task completed! ${stepsCompleted}/${plan.steps.length} steps in ${elapsed}s`);

        const finalStats = stopMonitoring();
        log("success", `🔒 Privacy: ${finalStats.outboundRequests} outbound, ${finalStats.bytesSent} bytes sent`);

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

    // ── Rule-Based Plan Generator ────────────────────────

    function generateRuleBasedPlan(
      description: string,
      pageState: PageState,
      data?: Record<string, string>
    ) {
      const steps: PlannedAction[] = [];
      let idx = 0;
      const lower = description.toLowerCase();

      if (lower.includes("fill") || lower.includes("complete") || lower.includes("submit")) {
        const allFields = pageState.forms.flatMap((f) => f.fields);
        const unfilled = allFields.filter((f) => !f.filledByUser && f.required);

        for (const field of unfilled) {
          const value = data?.[field.name] || data?.[field.label] || "";
          if (value) {
            steps.push({
              index: idx++,
              action: { id: `a-${idx}`, type: "click", target: field.id || field.name, retries: 0, maxRetries: 3 },
              reasoning: `Click "${field.label || field.name}"`,
              confidence: 0.9,
              verification: "Field should be focused",
              risk: "low",
            });
            steps.push({
              index: idx++,
              action: { id: `a-${idx}`, type: "type", target: field.id || field.name, value, retries: 0, maxRetries: 3 },
              reasoning: `Type "${value}"`,
              confidence: 0.85,
              verification: "Field value should match",
              risk: "low",
            });
          }
        }
      }

      if (lower.includes("scroll")) {
        steps.push({
          index: idx++,
          action: { id: `a-${idx}`, type: "scroll", value: "down", retries: 0, maxRetries: 1 },
          reasoning: "Scroll down",
          confidence: 0.9,
          verification: "Page should scroll",
          risk: "low",
        });
      }

      if (steps.length === 0) {
        steps.push({
          index: idx++,
          action: { id: `a-${idx}`, type: "wait", timeout: 1000, retries: 0, maxRetries: 0 },
          reasoning: `No specific actions for: "${description}"`,
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

    // ── Page Perception (via Hybrid Perceiver) ───────────

    async function handlePerceivePage(): Promise<PageState> {
      const result = await perceiver.perceive();
      return result.pageState;
    }

    // ── Action Execution ─────────────────────────────────

    async function handleExecuteAction(
      action: any
    ): Promise<{ success: boolean; error?: string }> {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab");

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (a: any) => {
          const find = (t: string): Element | null => {
            if (document.getElementById(t)) return document.getElementById(t);
            try { const e = document.querySelector(t); if (e) return e; } catch {}
            const n = document.querySelector(`[name="${t}"]`); if (n) return n;
            const ar = document.querySelector(`[aria-label="${t}"]`); if (ar) return ar;
            const ph = document.querySelector(`[placeholder="${t}"]`); if (ph) return ph;
            const btns = document.querySelectorAll("button, a, [role='button']");
            for (const b of btns) {
              if (b.textContent?.trim().toLowerCase().includes(t.toLowerCase())) return b;
            }
            return null;
          };

          try {
            switch (a.type) {
              case "click": {
                const el = a.coordinates
                  ? document.elementFromPoint(a.coordinates.x, a.coordinates.y)
                  : find(a.target || "");
                if (!el) return { success: false, error: `Not found: ${a.target}` };
                el.scrollIntoView({ behavior: "smooth", block: "center" });
                const r = el.getBoundingClientRect();
                for (const e of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
                  el.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }));
                return { success: true };
              }
              case "type": {
                const el = find(a.target || "");
                if (!el) return { success: false, error: `Not found: ${a.target}` };
                (el as HTMLInputElement).focus();
                el.scrollIntoView({ behavior: "smooth", block: "center" });
                const inp = el as HTMLInputElement;
                inp.select(); inp.value = "";
                inp.dispatchEvent(new Event("input", { bubbles: true }));
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
                const d = (a.value || "down").toLowerCase();
                const m: Record<string, number> = { up: -500, down: 500, top: -99999, bottom: 99999 };
                window.scrollBy({ top: m[d] || 500, behavior: "smooth" });
                return { success: true };
              }
              case "navigate": {
                window.location.href = a.value || "";
                return { success: true };
              }
              default:
                return { success: false, error: `Unknown: ${a.type}` };
            }
          } catch (e: any) {
            return { success: false, error: e.message };
          }
        },
        args: [action],
      });

      return results?.[0]?.result || { success: false, error: "Script execution failed" };
    }

    // ── Memory ───────────────────────────────────────────

    async function handleGetMemory(payload: { domain: string }): Promise<unknown> {
      const r = await chrome.storage.local.get(`memory_${payload.domain}`);
      return r[`memory_${payload.domain}`] || null;
    }

    async function handleSaveMemory(payload: { domain: string; data: unknown }): Promise<void> {
      await chrome.storage.local.set({ [`memory_${payload.domain}`]: payload.data });
    }

    // ── Helpers ──────────────────────────────────────────

    function broadcast(message: { type: MessageType; payload: unknown }): void {
      chrome.runtime.sendMessage(message).catch(() => {});
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    }
  },
});
