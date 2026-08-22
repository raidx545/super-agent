// ============================================================
// VLESS — Action Executor
// Performs browser actions by injecting into the active tab
// All actions are executed in the content script context
// ============================================================

import type { AgentAction, ActionResult, PageState } from "../../types";

// ── Main Executor ────────────────────────────────────────────

/**
 * Execute a browser action by injecting into the active tab.
 * This is called from the service worker.
 */
export async function executeAction(action: AgentAction): Promise<ActionResult> {
  const startTime = performance.now();

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return createResult(action.id, false, "No active tab found", startTime);
    }

    // Get page state before action
    const pageStateBefore = await getPageState(tab.id);

    // Inject and execute the action
    const executionResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: executeInContentScript,
      args: [action],
    });

    const success = executionResult?.[0]?.result?.success ?? false;
    const error = executionResult?.[0]?.result?.error;

    // Small delay to let the page settle
    await sleep(200);

    // Get page state after action
    const pageStateAfter = await getPageState(tab.id);

    return {
      actionId: action.id,
      success,
      error,
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

// ── Content Script Execution ─────────────────────────────────

/**
 * This function is injected into the content script context.
 * It runs in the page's DOM, not in the extension's isolated world.
 */
function executeInContentScript(action: {
  type: string;
  target?: string;
  value?: string;
  coordinates?: { x: number; y: number };
  key?: string;
  timeout?: number;
}): { success: boolean; error?: string } {
  try {
    switch (action.type) {
      case "click":
        return performClick(action.target, action.coordinates);

      case "type":
        return performType(action.target, action.value || "");

      case "scroll":
        return performScroll(action.value || "down");

      case "navigate":
        return performNavigate(action.value || "");

      case "select":
        return performSelect(action.target, action.value || "");

      case "hover":
        return performHover(action.target, action.coordinates);

      case "press_key":
        return performKeyPress(action.key || "");

      case "go_back":
        window.history.back();
        return { success: true };

      case "wait":
        return new Promise((resolve) =>
          setTimeout(() => resolve({ success: true }), action.timeout || 1000)
        ) as unknown as { success: boolean };

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Action failed",
    };
  }
}

// ── Click ────────────────────────────────────────────────────

function performClick(
  target?: string,
  coordinates?: { x: number; y: number }
): { success: boolean; error?: string } {
  // If coordinates provided, click at exact position
  if (coordinates) {
    const element = document.elementFromPoint(coordinates.x, coordinates.y);
    if (!element) {
      return { success: false, error: `No element at coordinates (${coordinates.x}, ${coordinates.y})` };
    }
    simulateClick(element, coordinates.x, coordinates.y);
    return { success: true };
  }

  // Find element by selector or ID
  if (!target) {
    return { success: false, error: "No click target specified" };
  }

  const element = findElement(target);
  if (!element) {
    return { success: false, error: `Element not found: ${target}` };
  }

  if ((element as HTMLInputElement).disabled) {
    return { success: false, error: `Element is disabled: ${target}` };
  }

  const rect = element.getBoundingClientRect();
  simulateClick(element, rect.x + rect.width / 2, rect.y + rect.height / 2);
  return { success: true };
}

function simulateClick(element: Element, x: number, y: number): void {
  // Scroll element into view first
  element.scrollIntoView({ behavior: "smooth", block: "center" });

  // Dispatch mouse events in order (mousedown, mouseup, click)
  const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const eventType of events) {
    const event = new MouseEvent(eventType, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
      button: 0,
      buttons: eventType.includes("down") ? 1 : 0,
    });
    element.dispatchEvent(event);
  }
}

// ── Type ─────────────────────────────────────────────────────

function performType(
  target?: string,
  value?: string
): { success: boolean; error?: string } {
  if (!target) return { success: false, error: "No type target specified" };
  if (!value) return { success: false, error: "No value to type" };

  const element = findElement(target);
  if (!element) return { success: false, error: `Element not found: ${target}` };

  // Focus the element
  (element as HTMLInputElement).focus();
  element.scrollIntoView({ behavior: "smooth", block: "center" });

  // Clear existing value
  const input = element as HTMLInputElement;
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));

  // Type character by character (simulates real typing)
  for (const char of value) {
    // Key down
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: char,
        code: `Key${char.toUpperCase()}`,
        bubbles: true,
      })
    );

    // Input event
    input.value += char;
    input.dispatchEvent(
      new InputEvent("input", {
        data: char,
        inputType: "insertText",
        bubbles: true,
        cancelable: true,
      })
    );

    // Key up
    input.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: char,
        code: `Key${char.toUpperCase()}`,
        bubbles: true,
      })
    );
  }

  // Blur to trigger validation
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();

  return { success: true };
}

// ── Scroll ───────────────────────────────────────────────────

function performScroll(
  direction: string
): { success: boolean; error?: string } {
  const amount = 500; // pixels

  switch (direction.toLowerCase()) {
    case "up":
      window.scrollBy({ top: -amount, behavior: "smooth" });
      break;
    case "down":
      window.scrollBy({ top: amount, behavior: "smooth" });
      break;
    case "left":
      window.scrollBy({ left: -amount, behavior: "smooth" });
      break;
    case "right":
      window.scrollBy({ left: amount, behavior: "smooth" });
      break;
    case "top":
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    case "bottom":
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      break;
    default:
      return { success: false, error: `Unknown scroll direction: ${direction}` };
  }

  return { success: true };
}

// ── Navigate ─────────────────────────────────────────────────

function performNavigate(
  url: string
): { success: boolean; error?: string } {
  try {
    window.location.href = url;
    return { success: true };
  } catch (error) {
    return { success: false, error: `Navigation failed: ${error}` };
  }
}

// ── Select ───────────────────────────────────────────────────

function performSelect(
  target?: string,
  value?: string
): { success: boolean; error?: string } {
  if (!target) return { success: false, error: "No select target" };

  const element = findElement(target);
  if (!element || element.tagName !== "SELECT") {
    return { success: false, error: `Select element not found: ${target}` };
  }

  const select = element as HTMLSelectElement;

  // Try to find by value, then by text
  let found = false;
  for (const option of select.options) {
    if (option.value === value || option.text.toLowerCase() === value?.toLowerCase()) {
      select.value = option.value;
      found = true;
      break;
    }
  }

  if (!found) {
    return { success: false, error: `Option not found: ${value}` };
  }

  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { success: true };
}

// ── Hover ────────────────────────────────────────────────────

function performHover(
  target?: string,
  coordinates?: { x: number; y: number }
): { success: boolean; error?: string } {
  const element = coordinates
    ? document.elementFromPoint(coordinates.x, coordinates.y)
    : target
      ? findElement(target)
      : null;

  if (!element) {
    return { success: false, error: "Element not found for hover" };
  }

  const rect = element.getBoundingClientRect();
  const x = coordinates?.x || rect.x + rect.width / 2;
  const y = coordinates?.y || rect.y + rect.height / 2;

  element.dispatchEvent(
    new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y })
  );
  element.dispatchEvent(
    new MouseEvent("mouseenter", { bubbles: true, clientX: x, clientY: y })
  );

  return { success: true };
}

// ── Key Press ────────────────────────────────────────────────

function performKeyPress(
  key: string
): { success: boolean; error?: string } {
  const activeElement = document.activeElement || document.body;

  activeElement.dispatchEvent(
    new KeyboardEvent("keydown", { key, code: key, bubbles: true })
  );
  activeElement.dispatchEvent(
    new KeyboardEvent("keypress", { key, code: key, bubbles: true })
  );
  activeElement.dispatchEvent(
    new KeyboardEvent("keyup", { key, code: key, bubbles: true })
  );

  return { success: true };
}

// ── Element Finding ──────────────────────────────────────────

function findElement(target: string): Element | null {
  // Try ID first
  if (document.getElementById(target)) {
    return document.getElementById(target);
  }

  // Try CSS selector
  try {
    const el = document.querySelector(target);
    if (el) return el;
  } catch {
    // Invalid selector
  }

  // Try by name attribute
  const byName = document.querySelector(`[name="${target}"]`);
  if (byName) return byName;

  // Try by aria-label
  const byAria = document.querySelector(`[aria-label="${target}"]`);
  if (byAria) return byAria;

  // Try by placeholder
  const byPlaceholder = document.querySelector(`[placeholder="${target}"]`);
  if (byPlaceholder) return byPlaceholder;

  // Try by text content (for buttons/links)
  const allButtons = document.querySelectorAll("button, a, [role='button']");
  for (const btn of allButtons) {
    if (btn.textContent?.trim().toLowerCase() === target.toLowerCase()) {
      return btn;
    }
  }

  // Try partial text match
  for (const btn of allButtons) {
    if (btn.textContent?.trim().toLowerCase().includes(target.toLowerCase())) {
      return btn;
    }
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────

async function getPageState(tabId: number): Promise<PageState> {
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
      hasCAPTCHA: false,
      hasHoneypot: false,
      isSecure: true,
      hasFileUpload: false,
      hasPaymentForm: false,
      formCount: 0,
      totalElements: 0,
      interactiveElements: 0,
    },
    confidence: 0.5,
    perceptionTime: 0,
  };
}

function createResult(
  actionId: string,
  success: boolean,
  error: string | undefined,
  startTime: number
): ActionResult {
  return {
    actionId,
    success,
    error,
    executionTime: performance.now() - startTime,
    pageStateBefore: {} as PageState,
    pageStateAfter: {} as PageState,
    verificationSignals: [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
