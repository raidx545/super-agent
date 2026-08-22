// ============================================================
// VLESS — Orchestrator Tests
// Tests for the multi-tab orchestrator
// ============================================================

import { describe, it, expect } from "vitest";
import {
  storeCrossTabData,
  getCrossTabData,
  getAllCrossTabData,
} from "../src/core/tab/orchestrator";

describe("Multi-Tab Orchestrator", () => {
  describe("cross-tab data flow", () => {
    it("should store and retrieve cross-tab data", () => {
      storeCrossTabData("user_email", "test@example.com");
      const value = getCrossTabData("user_email");
      expect(value).toBe("test@example.com");
    });

    it("should return undefined for missing keys", () => {
      const value = getCrossTabData("nonexistent");
      expect(value).toBeUndefined();
    });

    it("should get all cross-tab data", () => {
      storeCrossTabData("key1", "value1");
      storeCrossTabData("key2", 42);
      storeCrossTabData("key3", { nested: true });

      const all = getAllCrossTabData();
      expect(all.key1).toBe("value1");
      expect(all.key2).toBe(42);
      expect(all.key3).toEqual({ nested: true });
    });

    it("should overwrite existing data", () => {
      storeCrossTabData("key", "old");
      storeCrossTabData("key", "new");
      expect(getCrossTabData("key")).toBe("new");
    });

    it("should store complex objects", () => {
      const data = {
        name: "Shashank",
        email: "shashank@example.com",
        forms: ["passport", "aadhaar"],
      };
      storeCrossTabData("user_profile", data);
      expect(getCrossTabData("user_profile")).toEqual(data);
    });
  });
});
