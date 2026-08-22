// ============================================================
// VLESS — Network Monitor Tests
// Tests for the privacy network monitor
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  startMonitoring,
  stopMonitoring,
  resetStats,
  getStats,
  isClean,
  getPrivacyScore,
  generatePrivacyProof,
  onStatsChange,
  trackOutboundRequest,
  recordBlockedRequest,
} from "../src/core/privacy/network-monitor";

describe("Network Monitor", () => {
  beforeEach(() => {
    stopMonitoring();
    resetStats();
  });

  describe("monitoring lifecycle", () => {
    it("should start monitoring", () => {
      startMonitoring();
      const stats = getStats();
      expect(stats.isMonitoring).toBe(true);
      expect(stats.startedAt).toBeGreaterThan(0);
    });

    it("should stop monitoring", () => {
      startMonitoring();
      const finalStats = stopMonitoring();
      expect(finalStats.isMonitoring).toBe(false);
      expect(getStats().isMonitoring).toBe(false);
    });

    it("should not double-start", () => {
      startMonitoring();
      startMonitoring();
      const stats = getStats();
      expect(stats.isMonitoring).toBe(true);
    });

    it("should reset stats", () => {
      startMonitoring();
      trackOutboundRequest("https://example.com", 100);
      resetStats();

      const stats = getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.outboundRequests).toBe(0);
      expect(stats.bytesSent).toBe(0);
    });
  });

  describe("request tracking", () => {
    it("should track outbound requests", () => {
      startMonitoring();
      trackOutboundRequest("https://example.com/api", 512);

      const stats = getStats();
      expect(stats.totalRequests).toBe(1);
      expect(stats.outboundRequests).toBe(1);
      expect(stats.bytesSent).toBe(512);
    });

    it("should track multiple requests", () => {
      startMonitoring();
      trackOutboundRequest("https://example.com/1", 100);
      trackOutboundRequest("https://example.com/2", 200);
      trackOutboundRequest("https://google.com/search", 50);

      const stats = getStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.outboundRequests).toBe(3);
      expect(stats.bytesSent).toBe(350);
    });

    it("should track requests by domain", () => {
      startMonitoring();
      trackOutboundRequest("https://example.com/1", 100);
      trackOutboundRequest("https://example.com/2", 200);
      trackOutboundRequest("https://google.com/search", 50);

      const stats = getStats();
      expect(stats.requestsByDomain.get("example.com")).toBe(2);
      expect(stats.requestsByDomain.get("google.com")).toBe(1);
    });

    it("should record blocked requests", () => {
      startMonitoring();
      recordBlockedRequest("https://tracker.com/pixel", "privacy");

      const stats = getStats();
      expect(stats.blockedRequests).toHaveLength(1);
      expect(stats.blockedRequests[0]).toContain("tracker.com");
    });
  });

  describe("privacy status", () => {
    it("should be clean when no outbound requests", () => {
      startMonitoring();
      expect(isClean()).toBe(true);
    });

    it("should not be clean when outbound requests exist", () => {
      startMonitoring();
      trackOutboundRequest("https://example.com", 100);
      expect(isClean()).toBe(false);
    });

    it("should not be clean when blocked requests exist", () => {
      startMonitoring();
      recordBlockedRequest("https://tracker.com", "privacy");
      expect(isClean()).toBe(false);
    });

    it("should return perfect privacy score when clean", () => {
      startMonitoring();
      const score = getPrivacyScore();
      expect(score.score).toBe(100);
      expect(score.label).toBe("Perfect Privacy");
      expect(score.color).toBe("#22c55e");
    });

    it("should return lower score with outbound requests", () => {
      startMonitoring();
      trackOutboundRequest("https://example.com", 100);
      const score = getPrivacyScore();
      expect(score.score).toBeLessThan(100);
    });
  });

  describe("privacy proof", () => {
    it("should generate privacy proof text", () => {
      startMonitoring();
      const proof = generatePrivacyProof();
      expect(proof).toContain("PRIVACY PROOF");
      expect(proof).toContain("ZERO outbound requests");
    });

    it("should show outbound requests when they exist", () => {
      startMonitoring();
      trackOutboundRequest("https://example.com/api", 100);
      const proof = generatePrivacyProof();
      expect(proof).toContain("outbound request(s) detected");
    });
  });

  describe("listeners", () => {
    it("should notify listeners on stats change", () => {
      const received: any[] = [];
      const unsub = onStatsChange((stats) => {
        received.push({ ...stats });
      });

      startMonitoring();
      trackOutboundRequest("https://example.com", 100);

      expect(received.length).toBeGreaterThanOrEqual(2);
      unsub();
    });

    it("should unsubscribe correctly", () => {
      let count = 0;
      const unsub = onStatsChange(() => { count++; });

      startMonitoring();
      unsub();
      trackOutboundRequest("https://example.com", 100);

      expect(count).toBe(1); // Only the start
    });
  });
});
