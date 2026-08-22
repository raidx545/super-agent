// ============================================================
// VLESS — Background Service Worker
// The orchestrator: routes messages between side panel ↔ content script
// ============================================================

import { defineBackground } from "wxt/utils/define-background";
import type {
  Message,
  AgentTask,
  PageState,
  MessageType,
} from "../../types";

export default defineBackground({
  persistent: false,

  main() {
    // ── Extension Lifecycle ──────────────────────────────

    chrome.runtime.onInstalled.addListener(() => {
      console.log("🐾 VLESS installed.");

      chrome.storage.local.set({
        settings: {
          autoPerceive: true,
          confirmHighRisk: true,
          showVisualDebug: true,
          maxRetries: 3,
          stepDelay: 300,
          language: "en",
        },
      });
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
            message.payload as {
              description: string;
              data?: Record<string, string>;
            }
          );

        case "CANCEL_TASK":
          return { success: true, message: "Task cancelled" };

        case "PERCEIVE_PAGE":
          return handlePerceivePage();

        case "EXECUTE_ACTION":
          return handleExecuteAction(message.payload);

        case "GET_MEMORY":
          return handleGetMemory(
            message.payload as { domain: string }
          );

        case "SAVE_MEMORY":
          return handleSaveMemory(message.payload);

        default:
          return {
            error: `Unknown message type: ${message.type}`,
          };
      }
    }

    // ── Task Management ──────────────────────────────────

    async function handleStartTask(payload: {
      description: string;
      data?: Record<string, string>;
    }): Promise<AgentTask> {
      console.log(`🐾 Starting task: "${payload.description}"`);

      const task: AgentTask = {
        id: `task-${Date.now()}`,
        description: payload.description,
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

      broadcast({ type: "TASK_STATUS", payload: task });

      try {
        // Step 1: Perceive
        const pageState = await handlePerceivePage();

        // Step 2: Plan
        task.status = "planning";
        broadcast({ type: "TASK_STATUS", payload: task });

        const plan = generatePlan(
          payload.description,
          pageState,
          payload.data
        );
        task.plan = plan;
        task.totalSteps = plan.steps.length;

        // Step 3: Execute
        task.status = "executing";
        broadcast({ type: "TASK_STATUS", payload: task });

        let stepsCompleted = 0;
        for (const step of plan.steps) {
          task.currentStep = step.index;
          broadcast({ type: "TASK_STATUS", payload: task });

          const result = await handleExecuteAction(step.action);

          if (!result.success) {
            task.status = "failed";
            task.error = result.error || "Action failed";
            task.endTime = Date.now();
            broadcast({
              type: "TASK_COMPLETE",
              payload: { task },
            });
            return task;
          }

          stepsCompleted++;
          await sleep(500);
        }

        task.status = "completed";
        task.endTime = Date.now();
        task.result = `Completed ${stepsCompleted}/${plan.steps.length} steps`;
        broadcast({
          type: "TASK_COMPLETE",
          payload: { task },
        });
        return task;
      } catch (error) {
        task.status = "failed";
        task.endTime = Date.now();
        task.error =
          error instanceof Error ? error.message : "Unknown error";
        broadcast({
          type: "TASK_COMPLETE",
          payload: { task },
        });
        return task;
      }
    }

    // ── Plan Generator ───────────────────────────────────

    function generatePlan(
      description: string,
      pageState: PageState,
      data?: Record<string, string>
    ) {
      const steps: {
        index: number;
        action: any;
        reasoning: string;
        confidence: number;
        risk: string;
      }[] = [];
      let idx = 0;

      const lower = description.toLowerCase();

      if (
        lower.includes("fill") ||
        lower.includes("complete") ||
        lower.includes("submit")
      ) {
        const allFields = pageState.forms.flatMap((f) => f.fields);
        const unfilled = allFields.filter(
          (f) => !f.filledByUser && f.required
        );

        for (const field of unfilled) {
          const value =
            data?.[field.name] || data?.[field.label] || "";

          if (value) {
            steps.push({
              index: idx++,
              action: {
                id: `a-${idx}`,
                type: "click",
                target: field.id || field.name,
                retries: 0,
                maxRetries: 3,
              },
              reasoning: `Click "${field.label || field.name}"`,
              confidence: 0.9,
              risk: "low",
            });
            steps.push({
              index: idx++,
              action: {
                id: `a-${idx}`,
                type: "type",
                target: field.id || field.name,
                value,
                retries: 0,
                maxRetries: 3,
              },
              reasoning: `Type "${value}"`,
              confidence: 0.85,
              risk: "low",
            });
          }
        }
      }

      if (lower.includes("scroll")) {
        steps.push({
          index: idx++,
          action: { type: "scroll", value: "down" },
          reasoning: "Scroll down",
          confidence: 0.9,
          risk: "low",
        });
      }

      if (steps.length === 0) {
        steps.push({
          index: idx++,
          action: { type: "wait", timeout: 1000 },
          reasoning: `No specific actions for: "${description}"`,
          confidence: 0.3,
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

    // ── Page Perception ──────────────────────────────────

    async function handlePerceivePage(): Promise<PageState> {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) throw new Error("No active tab");

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const SELECTORS = [
            "a[href]", "button", "input", "select", "textarea",
            '[role="button"]', '[role="link"]', '[role="tab"]',
            '[role="checkbox"]', '[role="radio"]',
            '[contenteditable="true"]',
          ].join(", ");

          const elements = Array.from(
            document.querySelectorAll(SELECTORS)
          )
            .filter((el) => {
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return (
                r.width > 0 &&
                r.height > 0 &&
                s.display !== "none" &&
                s.visibility !== "hidden"
              );
            })
            .map((el, i) => {
              const r = el.getBoundingClientRect();
              return {
                id: el.id || `el-${i}`,
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute("role") || "",
                text: (el.textContent?.trim() || "").slice(0, 100),
                label:
                  el.getAttribute("aria-label") ||
                  el.getAttribute("placeholder") ||
                  "",
                type: el.getAttribute("type") || "",
                rect: {
                  x: r.x,
                  y: r.y,
                  width: r.width,
                  height: r.height,
                },
                isVisible: true,
                isInteractive: true,
                isDisabled: el.hasAttribute("disabled"),
                confidence: 0.95,
                source: "dom",
              };
            });

          const forms = Array.from(
            document.querySelectorAll("form")
          ).map((form, i) => ({
            id: form.id || `form-${i}`,
            action: form.action,
            method: form.method,
            fields: Array.from(
              form.querySelectorAll("input, select, textarea")
            ).map((input) => ({
              name: input.getAttribute("name") || "",
              id: input.id || "",
              type:
                input.getAttribute("type") ||
                input.tagName.toLowerCase(),
              value: (input as HTMLInputElement).value || "",
              required: input.hasAttribute("required"),
              maxLength: parseInt(
                input.getAttribute("maxlength") || "0"
              ),
              pattern: input.getAttribute("pattern") || "",
              options:
                input.tagName === "SELECT"
                  ? Array.from(
                      (input as HTMLSelectElement).options
                    ).map((o) => o.text)
                  : [],
              label:
                input.getAttribute("aria-label") ||
                input.getAttribute("placeholder") ||
                "",
              filledByUser: !!(input as HTMLInputElement).value,
            })),
          }));

          return {
            url: window.location.href,
            title: document.title,
            timestamp: Date.now(),
            elements,
            forms,
            textContent:
              document.body?.innerText?.slice(0, 5000) || "",
            metadata: {
              hasCAPTCHA:
                /recaptcha|hcaptcha|turnstile/i.test(
                  document.documentElement.outerHTML
                ),
              hasHoneypot: false,
              isSecure: window.location.protocol === "https:",
              hasFileUpload: elements.some(
                (e: any) => e.type === "file"
              ),
              hasPaymentForm:
                /payment|card|billing/i.test(
                  document.body.innerText
                ),
              formCount: forms.length,
              totalElements:
                document.querySelectorAll("*").length,
              interactiveElements: elements.length,
            },
            confidence: 0.85,
            perceptionTime: 0,
          };
        },
      });

      return (
        results?.[0]?.result || ({} as PageState)
      );
    }

    // ── Action Execution ─────────────────────────────────

    async function handleExecuteAction(
      action: any
    ): Promise<{ success: boolean; error?: string }> {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) throw new Error("No active tab");

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (a: any) => {
          const find = (t: string): Element | null => {
            if (document.getElementById(t))
              return document.getElementById(t);
            try {
              const e = document.querySelector(t);
              if (e) return e;
            } catch {}
            const n = document.querySelector(`[name="${t}"]`);
            if (n) return n;
            const ar = document.querySelector(
              `[aria-label="${t}"]`
            );
            if (ar) return ar;
            const ph = document.querySelector(
              `[placeholder="${t}"]`
            );
            if (ph) return ph;
            const btns = document.querySelectorAll(
              "button, a, [role='button']"
            );
            for (const b of btns) {
              if (
                b.textContent
                  ?.trim()
                  .toLowerCase()
                  .includes(t.toLowerCase())
              )
                return b;
            }
            return null;
          };

          try {
            switch (a.type) {
              case "click": {
                const el = a.coordinates
                  ? document.elementFromPoint(
                      a.coordinates.x,
                      a.coordinates.y
                    )
                  : find(a.target || "");
                if (!el)
                  return {
                    success: false,
                    error: `Not found: ${a.target}`,
                  };
                el.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
                const r = el.getBoundingClientRect();
                for (const e of [
                  "pointerdown",
                  "mousedown",
                  "pointerup",
                  "mouseup",
                  "click",
                ])
                  el.dispatchEvent(
                    new MouseEvent(e, {
                      bubbles: true,
                      cancelable: true,
                      clientX: r.x + r.width / 2,
                      clientY: r.y + r.height / 2,
                      button: 0,
                    })
                  );
                return { success: true };
              }
              case "type": {
                const el = find(a.target || "");
                if (!el)
                  return {
                    success: false,
                    error: `Not found: ${a.target}`,
                  };
                (el as HTMLInputElement).focus();
                el.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
                const inp = el as HTMLInputElement;
                inp.select();
                inp.value = "";
                inp.dispatchEvent(
                  new Event("input", { bubbles: true })
                );
                for (const c of a.value || "") {
                  inp.dispatchEvent(
                    new KeyboardEvent("keydown", {
                      key: c,
                      bubbles: true,
                    })
                  );
                  inp.value += c;
                  inp.dispatchEvent(
                    new InputEvent("input", {
                      data: c,
                      inputType: "insertText",
                      bubbles: true,
                    })
                  );
                  inp.dispatchEvent(
                    new KeyboardEvent("keyup", {
                      key: c,
                      bubbles: true,
                    })
                  );
                }
                inp.dispatchEvent(
                  new Event("change", { bubbles: true })
                );
                inp.blur();
                return { success: true };
              }
              case "scroll": {
                const d = (a.value || "down").toLowerCase();
                const m: Record<string, number> = {
                  up: -500,
                  down: 500,
                  top: -99999,
                  bottom: 99999,
                };
                window.scrollBy({
                  top: m[d] || 500,
                  behavior: "smooth",
                });
                return { success: true };
              }
              case "navigate": {
                window.location.href = a.value || "";
                return { success: true };
              }
              default:
                return {
                  success: false,
                  error: `Unknown: ${a.type}`,
                };
            }
          } catch (e: any) {
            return { success: false, error: e.message };
          }
        },
        args: [action],
      });

      return (
        results?.[0]?.result || {
          success: false,
          error: "Script execution failed",
        }
      );
    }

    // ── Memory ───────────────────────────────────────────

    async function handleGetMemory(payload: {
      domain: string;
    }): Promise<unknown> {
      const r = await chrome.storage.local.get(
        `memory_${payload.domain}`
      );
      return r[`memory_${payload.domain}`] || null;
    }

    async function handleSaveMemory(payload: {
      domain: string;
      data: unknown;
    }): Promise<void> {
      await chrome.storage.local.set({
        [`memory_${payload.domain}`]: payload.data,
      });
    }

    // ── Helpers ──────────────────────────────────────────

    function broadcast(message: {
      type: MessageType;
      payload: unknown;
    }): void {
      chrome.runtime.sendMessage(message).catch(() => {});
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    }
  },
});
