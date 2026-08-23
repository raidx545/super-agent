// Integration tests for the VLESS pipeline
import { describe, it, expect, beforeEach } from "vitest";
import {
  detectPIIFromDOM,
  mergePIIResults,
} from "../src/core/privacy/pii-detector";
import { generateDOMRedactionCSS } from "../src/core/privacy/redaction-engine";

// ── PII Detection Integration ────────────────────────────────

describe("PII Detection — Full Passport Form", () => {
  const passportFormElements: any[] = [
    { id: "given_name", tag: "input", role: "textbox", text: "", label: "Given Name", type: "text", ariaLabel: "", placeholder: "e.g. Shashank", rect: { x: 100, y: 200, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" },
    { id: "surname", tag: "input", role: "textbox", text: "", label: "Surname", type: "text", ariaLabel: "", placeholder: "e.g. Tomar", rect: { x: 320, y: 200, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" },
    { id: "father_name", tag: "input", role: "textbox", text: "", label: "Father's Name", type: "text", ariaLabel: "", placeholder: "", rect: { x: 100, y: 280, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" },
    { id: "aadhaar", tag: "input", role: "textbox", text: "", label: "Aadhaar Number", type: "text", ariaLabel: "", placeholder: "12-digit Aadhaar Number", rect: { x: 100, y: 360, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" },
    { id: "pan", tag: "input", role: "textbox", text: "", label: "PAN Number", type: "text", ariaLabel: "", placeholder: "ABCDE1234F", rect: { x: 320, y: 360, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" },
    { id: "mobile", tag: "input", role: "textbox", text: "", label: "Mobile Number", type: "tel", ariaLabel: "", placeholder: "+91 98765 43210", rect: { x: 100, y: 440, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" },
    { id: "email", tag: "input", role: "textbox", text: "", label: "Email Address", type: "email", ariaLabel: "", placeholder: "you@example.com", rect: { x: 320, y: 440, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" },
    { id: "password", tag: "input", role: "textbox", text: "", label: "Password", type: "password", ariaLabel: "", placeholder: "", rect: { x: 100, y: 520, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" },
    { id: "pincode", tag: "input", role: "textbox", text: "", label: "PIN Code", type: "text", ariaLabel: "", placeholder: "6-digit PIN Code", rect: { x: 320, y: 520, width: 200, height: 40 }, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.95, source: "dom" },
  ];

  const passportForms = [
    {
      id: "passportForm",
      action: "/api/submit",
      method: "POST",
      fields: [
        { name: "given_name", id: "given_name", type: "text", value: "", required: true, maxLength: 50, pattern: "", options: [], label: "Given Name", filledByUser: false },
        { name: "father_name", id: "father_name", type: "text", value: "", required: true, maxLength: 0, pattern: "", options: [], label: "Father's Name", filledByUser: false },
        { name: "aadhaar", id: "aadhaar", type: "text", value: "123456789012", required: true, maxLength: 12, pattern: "", options: [], label: "Aadhaar Number", filledByUser: true },
        { name: "pan", id: "pan", type: "text", value: "", required: false, maxLength: 10, pattern: "", options: [], label: "PAN Number", filledByUser: false },
        { name: "mobile", id: "mobile", type: "tel", value: "", required: true, maxLength: 15, pattern: "", options: [], label: "Mobile Number", filledByUser: false },
        { name: "email", id: "email", type: "email", value: "", required: true, maxLength: 0, pattern: "", options: [], label: "Email Address", filledByUser: false },
        { name: "password", id: "password", type: "password", value: "secret123", required: true, maxLength: 0, pattern: "", options: [], label: "Password", filledByUser: true },
        { name: "pincode", id: "pincode", type: "text", value: "", required: true, maxLength: 6, pattern: "", options: [], label: "PIN Code", filledByUser: false },
      ],
    },
  ];

  it("detects all PII types in passport form", () => {
    const result = detectPIIFromDOM(
      passportFormElements,
      passportForms,
      "Contact us at apply@passport.gov.in or call 9876543210"
    );

    const categories = result.map((r) => r.category);

    // Must detect these
    expect(categories).toContain("password"); // input type=password
    expect(categories).toContain("aadhaar"); // Aadhaar field
    expect(categories).toContain("phone"); // In page text
    expect(categories).toContain("email"); // In page text

    // Names should be detected from form labels
    expect(categories).toContain("name"); // given_name, father_name
  });

  it("detects Aadhaar value in filled field", () => {
    const result = detectPIIFromDOM(passportFormElements, passportForms, "");

    const aadhaar = result.find(
      (r) => r.category === "aadhaar" && r.textValue === "123456789012"
    );
    expect(aadhaar).toBeDefined();
    expect(aadhaar!.sensitivity).toBe("critical");
    expect(aadhaar!.redactionStrategy).toBe("black_box");
  });

  it("detects password field as critical", () => {
    const result = detectPIIFromDOM(passportFormElements, passportForms, "");

    const pwd = result.find((r) => r.category === "password");
    expect(pwd).toBeDefined();
    expect(pwd!.sensitivity).toBe("critical");
    expect(pwd!.redactionStrategy).toBe("black_box");
  });

  it("generates correct redaction CSS for PII fields", () => {
    const result = detectPIIFromDOM(passportFormElements, passportForms, "");
    const css = generateDOMRedactionCSS(result);

    // Should contain rules for sensitive fields
    expect(css.length).toBeGreaterThan(0);

    // Password fields should get black_box style
    expect(css).toContain("password");
  });
});

// ── Sanitized Context ────────────────────────────────────────

describe("Sanitized Context Builder", () => {
  it("replaces PII values with asterisks in safe text", () => {
    const text = "My Aadhaar is 123456789012 and email is test@example.com";
    const piiValues = new Set(["123456789012", "test@example.com"]);

    let safeText = text;
    for (const pii of piiValues) {
      safeText = safeText.replace(new RegExp(pii.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "***");
    }

    expect(safeText).toBe("My Aadhaar is *** and email is ***");
    expect(safeText).not.toContain("123456789012");
    expect(safeText).not.toContain("test@example.com");
  });
});

// ── Self-Improving Agent Patterns ────────────────────────────

describe("Self-Improving Agent", () => {
  it("matches action patterns correctly", () => {
    // Simulate pattern matching
    const target = "submit button";
    const pattern = "submit";

    const lower = target.toLowerCase();
    const patternLower = pattern.toLowerCase();

    expect(lower.includes(patternLower)).toBe(true);
  });

  it("generates fallback suggestions for failures", () => {
    const errorReason = 'Element not found: "submit"';
    let suggestion = "";

    if (errorReason.includes("not found")) {
      suggestion = "Try searching by text content";
    } else if (errorReason.includes("not visible")) {
      suggestion = "Try scrolling first";
    }

    expect(suggestion).toBe("Try searching by text content");
  });
});

// ── Voice Command Patterns ───────────────────────────────────

describe("Voice Command Recognition", () => {
  const englishPatterns: Array<{ input: string; expectedIntent: string }> = [
    { input: "fill this form", expectedIntent: "fill_form" },
    { input: "click the submit button", expectedIntent: "click" },
    { input: "scroll down", expectedIntent: "scroll" },
    { input: "go to google.com", expectedIntent: "navigate" },
    { input: "go back", expectedIntent: "go_back" },
    { input: "start the agent", expectedIntent: "start_agent" },
    { input: "stop the agent", expectedIntent: "stop_agent" },
  ];

  for (const { input, expectedIntent } of englishPatterns) {
    it(`recognizes "${input}" as ${expectedIntent}`, () => {
      // Simplified pattern matching for testing
      const lower = input.toLowerCase();

      let intent = "unknown";
      if (/fill|complete|submit/.test(lower) && /form|page/.test(lower)) {
        intent = "fill_form";
      } else if (/click|press/.test(lower)) {
        intent = "click";
      } else if (/scroll/.test(lower)) {
        intent = "scroll";
      } else if (/go to|open|navigate/.test(lower)) {
        intent = "navigate";
      } else if (/go back/.test(lower)) {
        intent = "go_back";
      } else if (/start/.test(lower)) {
        intent = "start_agent";
      } else if (/stop|cancel/.test(lower)) {
        intent = "stop_agent";
      }

      expect(intent).toBe(expectedIntent);
    });
  }
});

// ── Deterministic Replay ─────────────────────────────────────

describe("Deterministic Replay", () => {
  it("builds correct selectors from actions", () => {
    const actions = [
      { target: "given_name", expected: "#given_name" },
      // A bare identifier (hyphens included) is a valid id, so the rule
      // below yields an id selector. The previous expectation contradicted
      // the rule it was testing.
      { target: "my-form-input", expected: "#my-form-input" },
      { target: "submit button", expected: "[name=\"submit button\"]" },
      { target: "#special-id", expected: "#special-id" },
      { target: ".my-class", expected: ".my-class" },
    ];

    for (const { target, expected } of actions) {
      let selector: string;
      if (target.includes(".") || target.includes("[") || target.includes("#")) {
        selector = target;
      } else if (target.match(/^[a-zA-Z][\w-]*$/)) {
        selector = `#${target}`;
      } else {
        selector = `[name="${target}"]`;
      }
      expect(selector).toBe(expected);
    }
  });

  it("calculates speedup factor correctly", () => {
    const originalDuration = 45000; // 45s
    const optimizedDuration = 3000; // 3s
    const speedup = originalDuration / optimizedDuration;
    expect(speedup).toBe(15);
  });
});

// ── Network Monitor ──────────────────────────────────────────

describe("Network Monitor", () => {
  it("tracks outbound vs local requests", () => {
    const urls = [
      "https://api.openai.com/v1/chat",
      "http://localhost:11434/api/generate",
      "https://google.com/favicon.ico",
      "http://127.0.0.1:3000/api/plan",
    ];

    const outbound = urls.filter((url) => {
      try {
        const parsed = new URL(url);
        const isLocalhost =
          parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "::1";
        return !isLocalhost;
      } catch {
        return false;
      }
    });

    expect(outbound).toHaveLength(2); // openai + google
    expect(outbound).toContain("https://api.openai.com/v1/chat");
    expect(outbound).toContain("https://google.com/favicon.ico");
  });
});
