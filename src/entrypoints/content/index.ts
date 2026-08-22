// ============================================================
// VLESS — Content Script
// Runs on every web page in an isolated world
// Handles DOM extraction, action execution, and visual overlay
// ============================================================

import { defineContentScript } from "wxt/utils/define-content-script";
import type { Message, PageState } from "../../types";

export default defineContentScript({
  matches: ["<all_urls>"],

  main() {
    // ── Content Script State ─────────────────────────────

    let overlayActive = false;
    let overlayContainer: HTMLDivElement | null = null;

    // ── Message Listener ─────────────────────────────────

    chrome.runtime.onMessage.addListener(
      (
        message: Message,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: any) => void
      ) => {
        switch (message.type) {
          case "PERCEIVE_PAGE":
            sendResponse(extractPageState());
            break;

          case "EXECUTE_ACTION":
            executeAction(message.payload)
              .then(sendResponse)
              .catch((err: Error) =>
                sendResponse({ success: false, error: err.message })
              );
            return true;

          case "UPDATE_DEBUG_OVERLAY":
            updateDebugOverlay(message.payload);
            sendResponse({ success: true });
            break;

          case "TOGGLE_OVERLAY":
            toggleOverlay(message.payload?.active);
            sendResponse({ success: true, active: overlayActive });
            break;

          default:
            sendResponse({ error: "Unknown message type" });
        }
      }
    );

    // ── Page State Extraction ────────────────────────────

    function extractPageState(): PageState {
      const startTime = performance.now();

      const INTERACTIVE_SELECTORS = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="combobox"]',
        '[contenteditable="true"]',
        "[tabindex]",
      ].join(", ");

      const rawElements = document.querySelectorAll(INTERACTIVE_SELECTORS);
      const elements: any[] = [];
      const seen = new Set<Element>();

      rawElements.forEach((el, i) => {
        if (seen.has(el)) return;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        if (
          rect.width === 0 ||
          rect.height === 0 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          parseFloat(style.opacity) < 0.1
        )
          return;

        if (rect.bottom < -100 || rect.top > window.innerHeight + 100) return;

        const text =
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("placeholder") ||
          el.textContent?.trim()?.slice(0, 150) ||
          "";

        const label = getFieldLabel(el);

        elements.push({
          id: el.id || `el-${i}-${Date.now()}`,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || inferRole(el),
          text,
          label,
          ariaLabel: el.getAttribute("aria-label") || "",
          type: el.getAttribute("type") || "",
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
          },
          isVisible: true,
          isInteractive: true,
          isDisabled: el.hasAttribute("disabled"),
          confidence: 0.95,
          source: "dom",
        });
      });

      // Extract forms
      const formElements = document.querySelectorAll("form");
      const forms = Array.from(formElements).map((form, fi) => ({
        id: form.id || `form-${fi}`,
        action: form.action || window.location.href,
        method: form.method || "GET",
        fields: Array.from(
          form.querySelectorAll("input, select, textarea")
        ).map((input) => {
          const r = input.getBoundingClientRect();
          return {
            name: input.getAttribute("name") || "",
            id: input.id || "",
            type:
              input.getAttribute("type") || input.tagName.toLowerCase(),
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
            rect: {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
            },
            label: getFieldLabel(input),
            filledByUser: !!(input as HTMLInputElement).value,
          };
        }),
      }));

      const pageHTML = document.documentElement.outerHTML;
      const pageText = document.body?.innerText || "";

      return {
        url: window.location.href,
        title: document.title,
        timestamp: Date.now(),
        elements,
        forms,
        textContent: pageText.slice(0, 5000),
        metadata: {
          hasCAPTCHA:
            /recaptcha|hcaptcha|turnstile|cf-challenge/i.test(
              pageHTML
            ),
          hasHoneypot: detectHoneypots(),
          isSecure: window.location.protocol === "https:",
          hasFileUpload: elements.some(
            (e: any) => e.type === "file"
          ),
          hasPaymentForm:
            /payment|card number|cvv|expiry|billing/i.test(
              pageText
            ),
          formCount: forms.length,
          totalElements: document.querySelectorAll("*").length,
          interactiveElements: elements.length,
        },
        confidence: 0.85,
        perceptionTime: performance.now() - startTime,
      };
    }

    // ── Action Execution ─────────────────────────────────

    async function executeAction(
      action: any
    ): Promise<{ success: boolean; error?: string }> {
      return new Promise((resolve) => {
        try {
          switch (action.type) {
            case "click": {
              const el = action.coordinates
                ? document.elementFromPoint(
                    action.coordinates.x,
                    action.coordinates.y
                  )
                : findElement(action.target || "");
              if (!el) {
                resolve({
                  success: false,
                  error: `Element not found: ${action.target}`,
                });
                return;
              }
              el.scrollIntoView({
                behavior: "smooth",
                block: "center",
              });
              setTimeout(() => {
                const rect = el.getBoundingClientRect();
                const x = rect.x + rect.width / 2;
                const y = rect.y + rect.height / 2;
                for (const evt of [
                  "pointerdown",
                  "mousedown",
                  "pointerup",
                  "mouseup",
                  "click",
                ]) {
                  el.dispatchEvent(
                    new MouseEvent(evt, {
                      bubbles: true,
                      cancelable: true,
                      clientX: x,
                      clientY: y,
                      button: 0,
                    })
                  );
                }
                resolve({ success: true });
              }, 300);
              break;
            }

            case "type": {
              const el = findElement(action.target || "");
              if (!el) {
                resolve({
                  success: false,
                  error: `Element not found: ${action.target}`,
                });
                return;
              }
              (el as HTMLInputElement).focus();
              el.scrollIntoView({
                behavior: "smooth",
                block: "center",
              });
              const input = el as HTMLInputElement;
              input.select();
              input.value = "";
              input.dispatchEvent(
                new Event("input", { bubbles: true })
              );
              for (const char of action.value || "") {
                input.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: char,
                    bubbles: true,
                  })
                );
                input.value += char;
                input.dispatchEvent(
                  new InputEvent("input", {
                    data: char,
                    inputType: "insertText",
                    bubbles: true,
                  })
                );
                input.dispatchEvent(
                  new KeyboardEvent("keyup", {
                    key: char,
                    bubbles: true,
                  })
                );
              }
              input.dispatchEvent(
                new Event("change", { bubbles: true })
              );
              input.blur();
              resolve({ success: true });
              break;
            }

            case "scroll": {
              const dir = (action.value || "down").toLowerCase();
              const amounts: Record<string, number> = {
                up: -500,
                down: 500,
                top: -999999,
                bottom: 999999,
              };
              window.scrollBy({
                top: amounts[dir] || 500,
                behavior: "smooth",
              });
              resolve({ success: true });
              break;
            }

            case "navigate": {
              window.location.href = action.value || "";
              resolve({ success: true });
              break;
            }

            case "select": {
              const el = findElement(action.target || "");
              if (!el || el.tagName !== "SELECT") {
                resolve({
                  success: false,
                  error: "Select not found",
                });
                return;
              }
              const select = el as HTMLSelectElement;
              for (const opt of select.options) {
                if (
                  opt.value === action.value ||
                  opt.text.toLowerCase() ===
                    action.value?.toLowerCase()
                ) {
                  select.value = opt.value;
                  select.dispatchEvent(
                    new Event("change", { bubbles: true })
                  );
                  resolve({ success: true });
                  return;
                }
              }
              resolve({
                success: false,
                error: `Option not found: ${action.value}`,
              });
              break;
            }

            case "hover": {
              const el = findElement(action.target || "");
              if (!el) {
                resolve({
                  success: false,
                  error: "Element not found",
                });
                return;
              }
              el.dispatchEvent(
                new MouseEvent("mouseover", { bubbles: true })
              );
              el.dispatchEvent(
                new MouseEvent("mouseenter", { bubbles: true })
              );
              resolve({ success: true });
              break;
            }

            case "press_key": {
              const active =
                document.activeElement || document.body;
              active.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: action.key,
                  bubbles: true,
                })
              );
              active.dispatchEvent(
                new KeyboardEvent("keyup", {
                  key: action.key,
                  bubbles: true,
                })
              );
              resolve({ success: true });
              break;
            }

            case "go_back": {
              window.history.back();
              resolve({ success: true });
              break;
            }

            default:
              resolve({
                success: false,
                error: `Unknown action type: ${action.type}`,
              });
          }
        } catch (err: any) {
          resolve({ success: false, error: err.message });
        }
      });
    }

    // ── Visual Debug Overlay ─────────────────────────────

    function toggleOverlay(active?: boolean): void {
      overlayActive = active ?? !overlayActive;

      if (overlayActive) {
        createOverlayContainer();
        const state = extractPageState();
        renderBoundingBoxes(state.elements);
      } else {
        removeOverlay();
      }
    }

    function createOverlayContainer(): void {
      if (overlayContainer) return;

      overlayContainer = document.createElement("div");
      overlayContainer.id = "vless-overlay";
      overlayContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 2147483647;
      `;
      document.body.appendChild(overlayContainer);
    }

    function renderBoundingBoxes(elements: any[]): void {
      if (!overlayContainer) return;

      overlayContainer.innerHTML = "";

      elements.forEach((el) => {
        if (!el.rect || el.rect.width === 0) return;

        const box = document.createElement("div");
        const color =
          el.confidence > 0.9
            ? "#22c55e"
            : el.confidence > 0.7
              ? "#eab308"
              : el.confidence > 0.5
                ? "#f97316"
                : "#ef4444";

        box.style.cssText = `
          position: absolute;
          left: ${el.rect.x}px;
          top: ${el.rect.y}px;
          width: ${el.rect.width}px;
          height: ${el.rect.height}px;
          border: 2px solid ${color};
          border-radius: 3px;
          background: ${color}15;
          pointer-events: none;
        `;

        const lbl = document.createElement("span");
        lbl.textContent = el.label || el.text || el.tag;
        lbl.style.cssText = `
          position: absolute;
          top: -20px;
          left: 0;
          font-size: 11px;
          font-family: 'SF Mono', 'Consolas', monospace;
          color: white;
          background: ${color};
          padding: 1px 6px;
          border-radius: 3px;
          white-space: nowrap;
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
        `;
        box.appendChild(lbl);

        overlayContainer!.appendChild(box);
      });
    }

    function updateDebugOverlay(data: {
      elements?: any[];
    }): void {
      if (!overlayActive) return;
      if (data.elements) renderBoundingBoxes(data.elements);
    }

    function removeOverlay(): void {
      if (overlayContainer) {
        overlayContainer.remove();
        overlayContainer = null;
      }
    }

    // ── Helpers ──────────────────────────────────────────

    function findElement(target: string): Element | null {
      if (document.getElementById(target))
        return document.getElementById(target);
      try {
        const el = document.querySelector(target);
        if (el) return el;
      } catch {
        // invalid selector
      }
      const byName = document.querySelector(
        `[name="${target}"]`
      );
      if (byName) return byName;
      const byAria = document.querySelector(
        `[aria-label="${target}"]`
      );
      if (byAria) return byAria;
      const byPlaceholder = document.querySelector(
        `[placeholder="${target}"]`
      );
      if (byPlaceholder) return byPlaceholder;
      const byLabel = document.querySelector(
        `label[for="${target}"]`
      );
      if (byLabel) {
        const input =
          byLabel.querySelector("input, select, textarea") ||
          document.getElementById(
            byLabel.getAttribute("for") || ""
          );
        if (input) return input;
      }
      const buttons = document.querySelectorAll(
        "button, a, [role='button']"
      );
      for (const btn of buttons) {
        if (
          btn.textContent
            ?.trim()
            .toLowerCase()
            .includes(target.toLowerCase())
        )
          return btn;
      }
      return null;
    }

    function getFieldLabel(input: Element): string {
      if (input.id) {
        const label = document.querySelector(
          `label[for="${input.id}"]`
        );
        if (label) return label.textContent?.trim() || "";
      }
      const parentLabel = input.closest("label");
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true) as Element;
        clone
          .querySelectorAll("input, select, textarea")
          .forEach((c) => c.remove());
        const text = clone.textContent?.trim();
        if (text) return text;
      }
      return (
        input.getAttribute("aria-label") ||
        input.getAttribute("placeholder") ||
        ""
      );
    }

    function inferRole(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type")?.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "input") {
        if (type === "submit") return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        return "textbox";
      }
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      return "generic";
    }

    function detectHoneypots(): boolean {
      const inputs = document.querySelectorAll("input, textarea");
      return Array.from(inputs).some((el) => {
        const style = window.getComputedStyle(el);
        if (
          style.position === "absolute" &&
          (parseInt(style.left) < -9999 ||
            parseInt(style.top) < -9999)
        )
          return true;
        const name =
          el.getAttribute("name") || el.getAttribute("id") || "";
        if (/captcha|trap|bot|honeypot|cf-|wp-/i.test(name))
          return true;
        return false;
      });
    }

    console.log("🐾 VLESS content script loaded.");
  },
});
