// ============================================================
// VLESS — LLM Bridge Tests
// Tests for the Ollama LLM bridge
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkOllamaAvailability,
  isLLMAvailable,
  getLLMStatus,
  generatePlanWithLLM,
  explainPageState,
} from "../src/core/agent/llm-bridge";

describe("LLM Bridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Ollama availability", () => {
    it("should detect when Ollama is not running", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

      const result = await checkOllamaAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should detect when Ollama is running", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ version: "0.3.0" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [{ name: "qwen2.5:3b" }],
          }),
        })
      );

      const result = await checkOllamaAvailability();
      expect(result.available).toBe(true);
      expect(result.version).toBe("0.3.0");
      expect(result.model).toBe("qwen2.5:3b");
    });

    it("should get LLM status", () => {
      const status = getLLMStatus();
      expect(status).toHaveProperty("available");
      expect(status).toHaveProperty("model");
    });

    it("should report availability correctly", async () => {
      // After failed check
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Not running")));
      await checkOllamaAvailability();
      expect(isLLMAvailable()).toBe(false);
    });
  });

  describe("plan generation fallback", () => {
    it("should fall back to rule-based when LLM is unavailable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Not running")));
      await checkOllamaAvailability();

      const result = await generatePlanWithLLM(
        "Fill the form",
        {
          url: "https://example.com",
          title: "Test",
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
          confidence: 0.85,
          perceptionTime: 10,
        },
      );

      expect(result.usedLLM).toBe(false);
      expect(result.steps).toHaveLength(0);
    });
  });

  describe("page explanation fallback", () => {
    it("should generate simple summary when LLM unavailable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Not running")));
      await checkOllamaAvailability();

      const explanation = await explainPageState({
        url: "https://example.com",
        title: "Test Page",
        timestamp: Date.now(),
        elements: [{ id: "1", tag: "button", role: "button", text: "Submit", label: "", placeholder: "", ariaLabel: "", type: "", rect: {} as DOMRect, isVisible: true, isInteractive: true, isDisabled: false, confidence: 0.9, source: "dom" }],
        forms: [],
        textContent: "",
        metadata: {
          hasCAPTCHA: false,
          hasHoneypot: false,
          isSecure: true,
          hasFileUpload: false,
          hasPaymentForm: false,
          formCount: 0,
          totalElements: 10,
          interactiveElements: 1,
        },
        confidence: 0.85,
        perceptionTime: 10,
      });

      expect(explanation).toContain("Test Page");
      expect(explanation).toContain("1 interactive elements");
    });
  });
});
