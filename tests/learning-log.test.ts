// ============================================================
// VLESS — Learning Log Tests
// Tests for the real-time agent learning log
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  log,
  getEntries,
  getRecentEntries,
  clearEntries,
  onLogEntry,
  narratePerception,
  narrateAction,
  narrateResult,
  narrateLearning,
} from "../src/core/agent/learning-log";

describe("Learning Log", () => {
  beforeEach(() => {
    clearEntries();
  });

  describe("basic logging", () => {
    it("should add entries", () => {
      log("discovery", "Found a form on the page");

      const entries = getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("Found a form on the page");
      expect(entries[0].phase).toBe("discovery");
      expect(entries[0].icon).toBe("🔍");
    });

    it("should add entries with different phases", () => {
      log("analysis", "Analyzing page structure");
      log("action", "Clicking submit button");
      log("success", "Form submitted");
      log("warning", "CAPTCHA detected");
      log("error", "Element not found");
      log("learning", "Learned that submit is at bottom");

      const entries = getEntries();
      expect(entries).toHaveLength(6);
      expect(entries.map((e) => e.phase)).toEqual([
        "analysis", "action", "success", "warning", "error", "learning"
      ]);
    });

    it("should auto-generate IDs", () => {
      const entry1 = log("discovery", "First");
      const entry2 = log("discovery", "Second");

      expect(entry1.id).toBeDefined();
      expect(entry2.id).toBeDefined();
      expect(entry1.id).not.toBe(entry2.id);
    });

    it("should include timestamps", () => {
      const before = Date.now();
      const entry = log("discovery", "Test");
      const after = Date.now();

      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(after);
    });

    it("should include details and confidence", () => {
      const entry = log("analysis", "Found 5 fields", "All fields are text inputs", 0.85);

      expect(entry.details).toBe("All fields are text inputs");
      expect(entry.confidence).toBe(0.85);
    });
  });

  describe("clearing entries", () => {
    it("should clear all entries", () => {
      log("discovery", "One");
      log("analysis", "Two");
      clearEntries();

      expect(getEntries()).toHaveLength(0);
    });
  });

  describe("recent entries", () => {
    it("should return entries from last N seconds", () => {
      log("discovery", "Old entry");
      const entries = getRecentEntries(10); // last 10 seconds

      expect(entries.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("listeners", () => {
    it("should notify listeners on new entries", () => {
      const received: any[][] = [];
      const unsub = onLogEntry((entries) => {
        received.push(entries);
      });

      log("discovery", "Test 1");
      log("analysis", "Test 2");

      expect(received).toHaveLength(2);
      expect(received[0]).toHaveLength(1);
      expect(received[1]).toHaveLength(2);

      unsub();
    });

    it("should unsubscribe correctly", () => {
      let count = 0;
      const unsub = onLogEntry(() => { count++; });

      log("discovery", "Test 1");
      unsub();
      log("analysis", "Test 2");

      expect(count).toBe(1); // Only the first log
    });
  });

  describe("narration helpers", () => {
    it("narratePerception should log page analysis", () => {
      narratePerception({
        url: "https://example.com",
        title: "Test Page",
        elements: [
          { tag: "button", text: "Submit" },
          { tag: "input", label: "Email" },
        ],
        forms: [{
          id: "form-1",
          fields: [
            { label: "Email", required: true, filledByUser: false },
            { label: "Name", required: false, filledByUser: true },
          ],
        }],
        metadata: {
          hasCAPTCHA: false,
          hasHoneypot: false,
          hasPaymentForm: false,
        },
      });

      const entries = getEntries();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e.message.includes("Test Page"))).toBe(true);
    });

    it("narratePerception should warn about CAPTCHA", () => {
      narratePerception({
        url: "https://example.com",
        title: "Test",
        elements: [],
        forms: [],
        metadata: {
          hasCAPTCHA: true,
          hasHoneypot: false,
          hasPaymentForm: false,
        },
      });

      const entries = getEntries();
      expect(entries.some((e) => e.phase === "warning" && e.message.includes("CAPTCHA"))).toBe(true);
    });

    it("narrateAction should log different action types", () => {
      narrateAction({ type: "click", target: "Submit" });
      narrateAction({ type: "type", target: "email", value: "test@example.com" });
      narrateAction({ type: "scroll", value: "down" });
      narrateAction({ type: "navigate", value: "https://example.com" });

      const entries = getEntries();
      expect(entries).toHaveLength(4);
      expect(entries.every((e) => e.phase === "action")).toBe(true);
    });

    it("narrateResult should log success and failure", () => {
      narrateResult(true);
      narrateResult(false, "Element not found");

      const entries = getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].phase).toBe("success");
      expect(entries[1].phase).toBe("error");
    });

    it("narrateLearning should log learning events", () => {
      narrateLearning("Submit button is always at bottom-right");

      const entries = getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].phase).toBe("learning");
      expect(entries[0].message.includes("Learned")).toBe(true);
    });
  });
});
