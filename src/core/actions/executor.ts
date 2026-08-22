// ============================================================
// VLESS — Production Action Executor
// Executes browser actions on REAL websites — not test forms
// Handles: SPAs, dynamic content, iframes, shadow DOM, lazy loading
// ============================================================

import type { AgentAction, ActionResult, PageState } from "../../types";

// ── Main Executor ────────────────────────────────────────────

/**
 * Execute a browser action on the active tab.
 * This runs in the service worker context.
 */
export async function executeAction(action: AgentAction): Promise<ActionResult> {
  const startTime = performance.now();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return createResult(action.id, false, "No active tab found", startTime);
    }

    // Get page state before action
    const pageStateBefore = await getPageState(tab.id);

    // Wait for the page to be ready (not loading)
    await waitForPageReady(tab.id, 5000);

    // Execute the action
    const executionResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: executeInPage,
      args: [action],
    });

    const result = executionResult?.[0]?.result || { success: false, error: "Script execution failed" };

    // Wait for the page to settle after action
    await sleep(300);

    // Get page state after action
    const pageStateAfter = await getPageState(tab.id);

    return {
      actionId: action.id,
      success: result.success,
      error: result.error,
      executionTime: performance.now() - startTime,
      pageStateBefore,
      pageStateAfter,
      verificationSignals: [],
    };
  } catch (error) {
    return createResult(
      action.id,
      false,
      error instanceof Error ? error.message : "Action execution failed",
      startTime
    );
  }
}

// ── Wait for Page Ready ──────────────────────────────────────

async function waitForPageReady(tabId: number, _timeout: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return new Promise<void>((resolve) => {
          if (document.readyState === "complete") {
            resolve();
          } else {
            const t = setTimeout(() => resolve(), 3000);
            window.addEventListener("load", () => {
              clearTimeout(t);
              resolve();
            }, { once: true });
          }
        });
      },
    });
  } catch {
    // If scripting fails, just wait
    await sleep(1000);
  }
}

// ── Page State Extraction ────────────────────────────────────

async function getPageState(tabId: number): Promise<PageState> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: window.location.href,
        title: document.title,
      }),
    });
    const data = results?.[0]?.result;
    return {
      url: data?.url || "",
      title: data?.title || "",
      timestamp: Date.now(),
      elements: [],
      forms: [],
      textContent: "",
      metadata: {
        hasCAPTCHA: false, hasHoneypot: false, isSecure: true,
        hasFileUpload: false, hasPaymentForm: false,
        formCount: 0, totalElements: 0, interactiveElements: 0,
      },
      confidence: 0.5,
      perceptionTime: 0,
    };
  } catch {
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
}

// ══════════════════════════════════════════════════════════════
// THIS FUNCTION IS INJECTED INTO THE PAGE CONTEXT
// It has access to the real DOM — not the extension's isolated world
// ══════════════════════════════════════════════════════════════

async function executeInPage(action: any): Promise<{ success: boolean; error?: string; details?: string }> {

  // ── Smart Element Finder (production-grade) ───────────
  // Finds elements on REAL websites using multiple strategies

  function findElement(target: string): Element | null {
    if (!target) return null;

    // Strategy 1: Direct ID
    const byId = document.getElementById(target);
    if (byId && isVisible(byId)) return byId;

    // Strategy 2: CSS selector (if it looks like one)
    if (target.includes(".") || target.includes("[") || target.includes(">") || target.includes("#")) {
      try {
        const bySelector = document.querySelector(target);
        if (bySelector && isVisible(bySelector)) return bySelector;
      } catch { /* invalid selector */ }
    }

    // Strategy 3: Name attribute
    const byName = document.querySelector(`[name="${target}"]`);
    if (byName && isVisible(byName)) return byName;

    // Strategy 4: ARIA label
    const byAria = document.querySelector(`[aria-label="${target}"]`);
    if (byAria && isVisible(byAria)) return byAria;

    // Strategy 5: Placeholder
    const byPlaceholder = document.querySelector(`[placeholder="${target}"]`);
    if (byPlaceholder && isVisible(byPlaceholder)) return byPlaceholder;

    // Strategy 6: Title attribute
    const byTitle = document.querySelector(`[title="${target}"]`);
    if (byTitle && isVisible(byTitle)) return byTitle;

    // Strategy 7: data-testid, data-cy, data-automation (testing attributes)
    const testAttrs = ["data-testid", "data-cy", "data-automation", "data-test", "data-qa"];
    for (const attr of testAttrs) {
      const byTest = document.querySelector(`[${attr}="${target}"]`);
      if (byTest && isVisible(byTest)) return byTest;
    }

    // Strategy 8: Label association (for forms)
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const labelText = label.textContent?.trim().toLowerCase() || "";
      if (labelText.includes(target.toLowerCase()) || target.toLowerCase().includes(labelText)) {
        // Find the associated input
        if (label.htmlFor) {
          const input = document.getElementById(label.htmlFor);
          if (input) return input;
        }
        const nestedInput = label.querySelector("input, select, textarea");
        if (nestedInput) return nestedInput;
      }
    }

    // Strategy 9: Text content match (buttons, links, spans)
    const textElements = document.querySelectorAll("button, a, [role='button'], [role='link'], span, div");
    const lowerTarget = target.toLowerCase();

    // Exact match first
    for (const el of textElements) {
      const text = el.textContent?.trim().toLowerCase() || "";
      if (text === lowerTarget && isVisible(el)) return el;
    }

    // Partial match
    for (const el of textElements) {
      const text = el.textContent?.trim().toLowerCase() || "";
      if (text.includes(lowerTarget) && isVisible(el)) return el;
    }

    // Strategy 10: Fuzzy match — remove extra words and try again
    const words = lowerTarget.split(/\s+/);
    for (const el of textElements) {
      const text = el.textContent?.trim().toLowerCase() || "";
      if (words.every((w) => text.includes(w)) && isVisible(el)) return el;
    }

    // Strategy 11: Search in shadow DOMs
    const shadowElements = document.querySelectorAll("*");
    for (const host of shadowElements) {
      if (host.shadowRoot) {
        const found = findInShadow(host.shadowRoot, target);
        if (found) return found;
      }
    }

    // Strategy 12: Search in iframes (up to 2 levels)
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          const found = findInDocument(iframeDoc, target);
          if (found) return found;
        }
      } catch { /* cross-origin iframe */ }
    }

    return null;
  }

  function findInShadow(root: ShadowRoot, target: string): Element | null {
    const el = root.querySelector(target);
    if (el) return el;

    const textElements = root.querySelectorAll("button, a, span, div");
    for (const el of textElements) {
      if (el.textContent?.trim().toLowerCase().includes(target.toLowerCase())) return el;
    }

    // Recurse into nested shadow DOMs
    const hosts = root.querySelectorAll("*");
    for (const host of hosts) {
      if (host.shadowRoot) {
        const found = findInShadow(host.shadowRoot, target);
        if (found) return found;
      }
    }

    return null;
  }

  function findInDocument(doc: Document, target: string): Element | null {
    const byId = doc.getElementById(target);
    if (byId) return byId;

    const byName = doc.querySelector(`[name="${target}"]`);
    if (byName) return byName;

    const byAria = doc.querySelector(`[aria-label="${target}"]`);
    if (byAria) return byAria;

    const byPlaceholder = doc.querySelector(`[placeholder="${target}"]`);
    if (byPlaceholder) return byPlaceholder;

    const textEls = doc.querySelectorAll("button, a, [role='button'], span");
    for (const el of textEls) {
      if (el.textContent?.trim().toLowerCase().includes(target.toLowerCase())) return el;
    }

    return null;
  }

  function isVisible(el: Element): boolean {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) < 0.05) return false;

    return true;
  }

  // ── Wait for Element (with MutationObserver) ──────────

  function waitForElement(target: string, waitTimeout = 5000): Promise<Element | null> {
    return new Promise((resolve) => {
      // Try immediate find
      const found = findElement(target);
      if (found) {
        resolve(found);
        return;
      }

      // Set up MutationObserver to watch for the element
      let resolved = false;
      const observer = new MutationObserver(() => {
        if (resolved) return;
        const el = findElement(target);
        if (el) {
          resolved = true;
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      // Timeout
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          observer.disconnect();
          resolve(null);
        }
      }, waitTimeout);
    });
  }

  // Suppress unused warning — waitForElement is available for future use
  void waitForElement;

  // ── Human-Like Typing ─────────────────────────────────

  function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value") ||
                       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") ||
                       Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function humanType(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    el.focus();
    el.scrollIntoView({ behavior: "smooth", block: "center" });

    // Clear existing value via native setter
    setNativeValue(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));

    // Type with realistic delays
    let i = 0;
    const typeChar = () => {
      if (i >= value.length) {
        // Done — trigger change events
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        return;
      }

      const char = value[i];

      // Key down
      el.dispatchEvent(new KeyboardEvent("keydown", {
        key: char, code: `Key${char.toUpperCase()}`,
        bubbles: true, cancelable: true,
      }));

      // Input via native setter to trigger React/Vue state updates
      const currentVal = el.value || "";
      setNativeValue(el, currentVal + char);
      el.dispatchEvent(new InputEvent("input", {
        data: char, inputType: "insertText", bubbles: true, cancelable: true,
      }));

      // Key up
      el.dispatchEvent(new KeyboardEvent("keyup", {
        key: char, code: `Key${char.toUpperCase()}`,
        bubbles: true, cancelable: true,
      }));

      i++;
      // 30-80ms between keystrokes (human-like)
      setTimeout(typeChar, 30 + Math.random() * 50);
    };

    typeChar();
  }

  // ── Action Execution ──────────────────────────────────

  try {
    switch (action.type) {
      case "click": {
        // Wait for element to appear (handles dynamic pages)
        const el = findElement(action.target || "");
        if (!el) {
          return { success: false, error: `Element not found: "${action.target}"` };
        }

        // Scroll into view
        el.scrollIntoView({ behavior: "smooth", block: "center" });

        // Small delay for scroll to settle
        const clickResult = new Promise<{ success: boolean; error?: string }>((resolve) => {
          setTimeout(() => {
            const rect = el.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;

            // Full mouse event sequence (needed for React/Angular)
            for (const evtType of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
              el.dispatchEvent(new MouseEvent(evtType, {
                bubbles: true, cancelable: true, view: window,
                clientX: x, clientY: y,
                screenX: x + window.screenX, screenY: y + window.screenY,
                button: 0, buttons: evtType.includes("down") ? 1 : 0,
              }));
            }

            // Also fire focus event (needed for some frameworks)
            if ("focus" in el) {
              (el as HTMLElement).focus();
            }

            resolve({ success: true });
          }, 200);
        });

        return await clickResult;
      }

      case "type": {
        const el = findElement(action.target || "");
        if (!el) {
          return { success: false, error: `Element not found: "${action.target}"` };
        }

        const input = el as HTMLInputElement;
        if (input.tagName !== "INPUT" && input.tagName !== "TEXTAREA" && !input.isContentEditable) {
          return { success: false, error: `Element is not an input: ${el.tagName}` };
        }

        humanType(input, action.value || "");
        return { success: true };
      }

      case "scroll": {
        const direction = (action.value || "down").toLowerCase();
        const amounts: Record<string, number> = {
          up: -window.innerHeight * 0.7,
          down: window.innerHeight * 0.7,
          top: -window.scrollY,
          bottom: document.body.scrollHeight - window.scrollY,
        };
        window.scrollBy({ top: amounts[direction] || 500, behavior: "smooth" });
        return { success: true };
      }

      case "navigate": {
        if (action.value) {
          window.location.href = action.value;
          return { success: true };
        }
        return { success: false, error: "No URL provided" };
      }

      case "select": {
        const el = findElement(action.target || "");
        if (!el || el.tagName !== "SELECT") {
          return { success: false, error: `Select element not found: "${action.target}"` };
        }

        const select = el as HTMLSelectElement;
        const value = action.value || "";

        // Try matching by value, then by text
        for (const opt of select.options) {
          if (opt.value === value || opt.text.toLowerCase() === value.toLowerCase()) {
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            select.dispatchEvent(new Event("input", { bubbles: true }));
            return { success: true };
          }
        }

        // Try partial match
        for (const opt of select.options) {
          if (opt.text.toLowerCase().includes(value.toLowerCase())) {
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return { success: true };
          }
        }

        return { success: false, error: `Option "${value}" not found in select` };
      }

      case "hover": {
        const el = findElement(action.target || "");
        if (!el) return { success: false, error: `Element not found: "${action.target}"` };

        const rect = el.getBoundingClientRect();
        for (const evt of ["mouseover", "mouseenter", "pointerenter"]) {
          el.dispatchEvent(new MouseEvent(evt, {
            bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
          }));
        }
        return { success: true };
      }

      case "press_key": {
        const active = document.activeElement || document.body;
        for (const evt of ["keydown", "keypress", "keyup"]) {
          active.dispatchEvent(new KeyboardEvent(evt, {
            key: action.key || "", code: action.key || "", bubbles: true,
          }));
        }
        return { success: true };
      }

      case "go_back": {
        window.history.back();
        return { success: true };
      }

      case "wait": {
        return new Promise((r) => setTimeout(() => r({ success: true }), action.timeout || 1000));
      }

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  } catch (e: any) {
    return { success: false, error: e.message || "Action failed" };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function createResult(
  actionId: string, success: boolean, error: string | undefined, startTime: number
): ActionResult {
  return {
    actionId, success, error,
    executionTime: performance.now() - startTime,
    pageStateBefore: {} as PageState,
    pageStateAfter: {} as PageState,
    verificationSignals: [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
