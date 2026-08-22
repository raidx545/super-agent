// ============================================================
// VLESS — DOM Extraction Engine
// The fast path: extracts page structure from the DOM in ~10ms
// Falls back to vision only when DOM is insufficient
// ============================================================

import type {
  PageElement,
  PageState,
  FormData,
  FormField,
  PageMetadata,
} from "../../types";

/** Interactive element selectors — covers 99% of usable UI elements */
const INTERACTIVE_SELECTORS = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="treeitem"]',
  '[contenteditable="true"]',
  "[tabindex]",
  "[onclick]",
].join(", ");

/** Anti-patterns that indicate honeypot fields */
const HONEYPOT_INDICATORS = {
  hiddenByCSS: (el: Element) => {
    const style = window.getComputedStyle(el);
    return (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0" ||
      parseInt(style.height) <= 0 ||
      parseInt(style.width) <= 0
    );
  },
  suspiciousNames: /captcha|trap|bot|honeypot|cf-|wp-/i,
  positionOffScreen: (rect: DOMRect) => {
    return rect.top < -100 || rect.left < -100 || rect.top > window.innerHeight + 100;
  },
};

/** CAPTCHA detection patterns */
const CAPTCHA_PATTERNS = [
  /recaptcha/i,
  /hcaptcha/i,
  /turnstile/i,
  /grecaptcha/i,
  /captcha/i,
  /challenge-platform/i,
  /cf-challenge/i,
];

// ── Main Extraction ──────────────────────────────────────────

/**
 * Extract complete page state from the DOM.
 * This is the FAST PATH (~10ms for most pages).
 * Returns null if the DOM is insufficient (falls through to vision).
 */
export function extractPageState(): PageState {
  const startTime = performance.now();

  const elements = extractInteractiveElements();
  const forms = extractForms();
  const textContent = extractVisibleText();
  const metadata = analyzePageMetadata(elements, forms);

  const confidence = calculateDOMConfidence(elements, metadata);

  return {
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    elements,
    forms,
    textContent,
    metadata,
    confidence,
    perceptionTime: performance.now() - startTime,
  };
}

/**
 * Check if DOM extraction is sufficient (high enough confidence).
 * If not, the system should fall through to visual perception.
 */
export function isDOMSufficient(state: PageState): boolean {
  return (
    state.confidence >= 0.7 &&
    state.elements.length >= 2 &&
    !state.metadata.hasCAPTCHA
  );
}

// ── Element Extraction ───────────────────────────────────────

function extractInteractiveElements(): PageElement[] {
  const rawElements = document.querySelectorAll(INTERACTIVE_SELECTORS);
  const elements: PageElement[] = [];
  const seen = new Set<Element>(); // deduplicate

  rawElements.forEach((el, index) => {
    if (seen.has(el)) return;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    const isVisible = isElementVisible(el, rect);
    const isDisabled = isElementDisabled(el);

    // Skip invisible elements (unless they're important like modals)
    if (!isVisible && !isModalElement(el)) return;

    const text = getElementText(el);
    const label = getElementLabel(el);
    const ariaLabel = el.getAttribute("aria-label") || "";
    const role = el.getAttribute("role") || inferRole(el);

    elements.push({
      id: el.id || `el-${index}-${Date.now()}`,
      tag: el.tagName.toLowerCase(),
      role,
      text,
      label,
      ariaLabel,
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
        toJSON: rect.toJSON.bind(rect),
      } as DOMRect,
      isVisible,
      isInteractive: true,
      isDisabled,
      confidence: 0.95, // DOM elements have high confidence
      source: "dom",
    });
  });

  return elements;
}

// ── Form Extraction ──────────────────────────────────────────

function extractForms(): FormData[] {
  const formElements = document.querySelectorAll("form");
  const forms: FormData[] = [];

  formElements.forEach((form, formIndex) => {
    const fields: FormField[] = [];
    const inputs = form.querySelectorAll(
      "input, select, textarea, [contenteditable]"
    );

    inputs.forEach((input) => {
      const rect = input.getBoundingClientRect();
      if (!isElementVisible(input, rect)) return;

      // Check for honeypot
      if (isHoneypot(input)) return;

      const label = getFieldLabel(input);

      fields.push({
        name: input.getAttribute("name") || "",
        id: input.id || "",
        type: input.getAttribute("type") || input.tagName.toLowerCase(),
        value: getInputValue(input),
        required: input.hasAttribute("required"),
        maxLength: parseInt(input.getAttribute("maxlength") || "0"),
        pattern: input.getAttribute("pattern") || "",
        options:
          input.tagName === "SELECT"
            ? Array.from((input as HTMLSelectElement).options).map(
                (o) => o.text
              )
            : [],
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          toJSON: rect.toJSON.bind(rect),
        } as DOMRect,
        label,
        filledByUser: !!getInputValue(input),
      });
    });

    if (fields.length > 0) {
      forms.push({
        id: form.id || `form-${formIndex}`,
        action: form.action || window.location.href,
        method: form.method || "GET",
        fields,
      });
    }
  });

  return forms;
}

// ── Text Extraction ──────────────────────────────────────────

function extractVisibleText(): string {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const texts: string[] = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 1) {
      texts.push(text);
    }
  }

  // Deduplicate and limit size
  return [...new Set(texts)].slice(0, 500).join(" ");
}

// ── Metadata Analysis ────────────────────────────────────────

function analyzePageMetadata(
  elements: PageElement[],
  forms: FormData[]
): PageMetadata {
  const pageHTML = document.documentElement.outerHTML;

  return {
    hasCAPTCHA: CAPTCHA_PATTERNS.some((p) => p.test(pageHTML)),
    hasHoneypot: detectHoneypots(),
    isSecure: window.location.protocol === "https:",
    hasFileUpload: elements.some((e) => e.type === "file"),
    hasPaymentForm: detectPaymentForm(),
    formCount: forms.length,
    totalElements: document.querySelectorAll("*").length,
    interactiveElements: elements.length,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function isElementVisible(el: Element, rect: DOMRect): boolean {
  if (rect.width === 0 || rect.height === 0) return false;

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (parseFloat(style.opacity) < 0.1) return false;

  // Check if element is in viewport (with some margin)
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  if (rect.bottom < -100 || rect.top > viewportHeight + 100) return false;
  if (rect.right < -100 || rect.left > viewportWidth + 100) return false;

  return true;
}

function isElementDisabled(el: Element): boolean {
  return (
    el.hasAttribute("disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    (el as HTMLInputElement).readOnly
  );
}

function isModalElement(el: Element): boolean {
  let parent = el.parentElement;
  while (parent) {
    const role = parent.getAttribute("role");
    const ariaModal = parent.getAttribute("aria-modal");
    if (role === "dialog" || role === "alertdialog" || ariaModal === "true") {
      return true;
    }
    if (parent.classList.contains("modal")) return true;
    parent = parent.parentElement;
  }
  return false;
}

function getElementText(el: Element): string {
  // Priority: aria-label > textContent > title > placeholder
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  const title = el.getAttribute("title");
  if (title) return title;

  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder;

  // For buttons and links, use textContent
  const text = el.textContent?.trim();
  if (text && text.length < 200) return text;

  return "";
}

function getElementLabel(el: Element): string {
  // Try to find associated label
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.textContent?.trim() || "";
  }

  // Check parent label
  const parentLabel = el.closest("label");
  if (parentLabel) {
    // Get text that isn't the input itself
    const clone = parentLabel.cloneNode(true) as Element;
    clone.querySelectorAll("input, select, textarea").forEach((c) => c.remove());
    return clone.textContent?.trim() || "";
  }

  // ARIA label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  // ARIA labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim() || "";
  }

  return "";
}

function getFieldLabel(input: Element): string {
  // ID-based label lookup
  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) return label.textContent?.trim() || "";
  }

  // Parent label
  const parentLabel = input.closest("label");
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as Element;
    clone.querySelectorAll("input, select, textarea").forEach((c) => c.remove());
    const text = clone.textContent?.trim();
    if (text) return text;
  }

  // Previous sibling text
  const prev = input.previousElementSibling;
  if (prev && ["LABEL", "SPAN", "DIV", "P"].includes(prev.tagName)) {
    return prev.textContent?.trim() || "";
  }

  // ARIA
  return input.getAttribute("aria-label") || input.getAttribute("placeholder") || "";
}

function getInputValue(input: Element): string {
  if (input.tagName === "SELECT") {
    const select = input as HTMLSelectElement;
    return select.options[select.selectedIndex]?.text || "";
  }
  if (input.getAttribute("type") === "checkbox" || input.getAttribute("type") === "radio") {
    return (input as HTMLInputElement).checked ? "checked" : "unchecked";
  }
  return (input as HTMLInputElement).value || "";
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
    if (type === "range") return "slider";
    return "textbox";
  }
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  return "generic";
}

function isHoneypot(el: Element): boolean {
  // Check CSS-based hiding
  const style = window.getComputedStyle(el);
  if (
    style.position === "absolute" &&
    (parseInt(style.left) < -9999 || parseInt(style.top) < -9999)
  ) {
    return true;
  }

  // Check suspicious names
  const name = el.getAttribute("name") || el.getAttribute("id") || "";
  if (HONEYPOT_INDICATORS.suspiciousNames.test(name)) return true;

  // Check if off-screen while parent form is visible
  const rect = el.getBoundingClientRect();
  if (HONEYPOT_INDICATORS.positionOffScreen(rect)) {
    const form = el.closest("form");
    if (form) {
      const formRect = form.getBoundingClientRect();
      if (isElementVisible(form, formRect)) {
        return true;
      }
    }
  }

  return false;
}

function detectHoneypots(): boolean {
  const allInputs = document.querySelectorAll("input, textarea");
  return Array.from(allInputs).some((el) => isHoneypot(el));
}

function detectPaymentForm(): boolean {
  const indicators = [
    /card\s*number/i,
    /cvv/i,
    /expiry/i,
    /credit\s*card/i,
    /debit\s*card/i,
    /upi/i,
    /payment/i,
    /billing/i,
  ];

  const pageText = document.body.innerText;
  return indicators.some((p) => p.test(pageText));
}

function calculateDOMConfidence(
  elements: PageElement[],
  metadata: PageMetadata
): number {
  let confidence = 0.5; // Base confidence

  // More elements = more complete extraction
  if (elements.length > 5) confidence += 0.15;
  if (elements.length > 15) confidence += 0.1;

  // Having labels increases confidence
  const labeledCount = elements.filter(
    (e) => e.label || e.ariaLabel || e.text
  ).length;
  const labelRatio = elements.length > 0 ? labeledCount / elements.length : 0;
  confidence += labelRatio * 0.15;

  // Forms with fields increase confidence
  if (metadata.formCount > 0) confidence += 0.1;

  // CAPTCHA decreases confidence (need visual)
  if (metadata.hasCAPTCHA) confidence -= 0.3;

  // Honeypot present = suspicious page
  if (metadata.hasHoneypot) confidence -= 0.1;

  // HTTPS increases trust
  if (metadata.isSecure) confidence += 0.05;

  return Math.max(0, Math.min(1, confidence));
}
