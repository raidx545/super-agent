// ============================================================
// Egress guard + shared text scanner.
//
// These cover the two properties the privacy claim rests on:
//   1. Validated PII in an outbound body stops the request.
//   2. Ordinary traffic is NOT stopped — the false-positive case is
//      what makes blocking safe to turn on at all.
// ============================================================

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  scanTextForPII,
  maskPIIInText,
  verifyIndianPhone,
  verifyPANFormat,
} from "../src/core/privacy/pii-detector";
import {
  guardedFetch,
  EgressBlockedError,
  getEgressStats,
  resetEgressStats,
  recordPageObservations,
  sanitizeUrl,
} from "../src/core/privacy/egress-guard";

// A Verhoeff-valid Aadhaar and a Luhn-valid card, so the validators fire.
const VALID_AADHAAR = "234123412346";
const VALID_CARD = "4539578763621486";
const VALID_PAN = "ABCPE1234F";
const VALID_PHONE = "9876543210";

describe("scanTextForPII — validated detection", () => {
  it("detects a Verhoeff-valid Aadhaar", () => {
    const hits = scanTextForPII(`aadhaar is ${VALID_AADHAAR} ok`);
    expect(hits.some((h) => h.category === "aadhaar")).toBe(true);
  });

  it("detects a Luhn-valid card number", () => {
    const hits = scanTextForPII(`card ${VALID_CARD}`);
    expect(hits.some((h) => h.category === "financial")).toBe(true);
  });

  it("detects a valid PAN and a valid Indian mobile", () => {
    const hits = scanTextForPII(`${VALID_PAN} and ${VALID_PHONE}`);
    const categories = hits.map((h) => h.category);
    expect(categories).toContain("pan");
    expect(categories).toContain("phone");
  });

  it("returns nothing for empty input", () => {
    expect(scanTextForPII("")).toEqual([]);
  });
});

describe("scanTextForPII — false positives", () => {
  it("ignores a 12-digit number that fails the Verhoeff checksum", () => {
    const hits = scanTextForPII("order reference 123456789012");
    expect(hits.some((h) => h.category === "aadhaar")).toBe(false);
  });

  it("ignores a 16-digit number that fails Luhn", () => {
    const hits = scanTextForPII("tracking 1234567812345678");
    expect(hits.some((h) => h.category === "financial")).toBe(false);
  });

  it("ignores a 10-digit number that is not an Indian mobile", () => {
    // Starts with 1 — outside the 6-9 subscriber range.
    const hits = scanTextForPII("sku 1234567890");
    expect(hits.some((h) => h.category === "phone")).toBe(false);
  });

  it("does not report email unless explicitly asked", () => {
    const text = "contact user@example.com";
    expect(scanTextForPII(text).some((h) => h.category === "email")).toBe(false);
    expect(
      scanTextForPII(text, { includeUnvalidated: true }).some((h) => h.category === "email")
    ).toBe(true);
  });

  it("reports a card number once, not also as an Aadhaar", () => {
    const hits = scanTextForPII(VALID_CARD);
    expect(hits).toHaveLength(1);
    expect(hits[0].category).toBe("financial");
  });

  it("terminates on pathological input", () => {
    // Regression guard: a non-global regex driven by exec() hangs forever.
    const hits = scanTextForPII("a@b.com ".repeat(500), { includeUnvalidated: true });
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("maskPIIInText", () => {
  it("replaces validated PII with a category tag", () => {
    const masked = maskPIIInText(`my aadhaar is ${VALID_AADHAAR}`);
    expect(masked).not.toContain(VALID_AADHAAR);
    expect(masked).toContain("[REDACTED:aadhaar]");
  });

  it("leaves clean text untouched", () => {
    const text = "Submit the passport application form";
    expect(maskPIIInText(text)).toBe(text);
  });

  it("handles several matches in one string", () => {
    const masked = maskPIIInText(`${VALID_PAN} / ${VALID_PHONE}`);
    expect(masked).not.toContain(VALID_PAN);
    expect(masked).not.toContain(VALID_PHONE);
  });
});

describe("validators", () => {
  it("accepts real Indian mobile numbers and rejects short ones", () => {
    expect(verifyIndianPhone("9876543210")).toBe(true);
    expect(verifyIndianPhone("+91 9876543210")).toBe(true);
    expect(verifyIndianPhone("987654321")).toBe(false);
    expect(verifyIndianPhone("1876543210")).toBe(false);
  });

  it("constrains the PAN holder-type character, not the series", () => {
    expect(verifyPANFormat("ABCPE1234F")).toBe(true);
    // Series outside the old hard-coded set is still a valid PAN.
    expect(verifyPANFormat("ZZZPE1234F")).toBe(true);
    // "D" is not a holder type.
    expect(verifyPANFormat("ABCDE1234F")).toBe(false);
  });
});

describe("guardedFetch", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    resetEgressStats();
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("blocks a request whose body carries a validated Aadhaar", async () => {
    await expect(
      guardedFetch("https://api.example.com/v1/plan", {
        method: "POST",
        body: JSON.stringify({ prompt: `fill aadhaar ${VALID_AADHAAR}` }),
      })
    ).rejects.toBeInstanceOf(EgressBlockedError);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(getEgressStats().blockedRequests).toBe(1);
  });

  it("lets a sanitized planning payload through", async () => {
    const res = await guardedFetch("https://api.example.com/v1/plan", {
      method: "POST",
      body: JSON.stringify({ prompt: "Fill the form. Field 0: [PII:aadhaar]" }),
    });

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getEgressStats().blockedRequests).toBe(0);
    expect(getEgressStats().cleanRequests).toBe(1);
  });

  it("does not block on an email alone", async () => {
    await guardedFetch("https://api.example.com/v1/plan", {
      method: "POST",
      body: JSON.stringify({ prompt: "reply to user@example.com" }),
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes GET requests straight through", async () => {
    await guardedFetch("https://api.example.com/v1/models");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("never stores the raw matched value in the ledger", async () => {
    await guardedFetch("https://api.example.com/v1/plan", {
      method: "POST",
      body: JSON.stringify({ prompt: VALID_AADHAAR }),
    }).catch(() => undefined);

    const serialized = JSON.stringify(getEgressStats());
    expect(serialized).not.toContain(VALID_AADHAAR);
    expect(serialized).toContain("aadhaar");
  });

  it("strips query strings from ledger URLs", () => {
    expect(sanitizeUrl("https://x.com/a?token=secret#frag")).toBe("https://x.com/a");
  });
});

describe("page observations", () => {
  beforeEach(() => resetEgressStats());

  it("records page traffic without marking it blocked", () => {
    recordPageObservations([
      { url: "https://site.com/login", method: "POST", bytes: 120, matches: [
        { category: "phone", matchedText: "98****10", position: 4 },
      ] },
    ]);

    const stats = getEgressStats();
    expect(stats.blockedRequests).toBe(0);
    expect(stats.events).toHaveLength(1);
    expect(stats.events[0].blocked).toBe(false);
    expect(stats.events[0].origin).toBe("page");
  });

  it("counts clean page traffic without creating an event", () => {
    recordPageObservations([
      { url: "https://site.com/ping", method: "POST", bytes: 10, matches: [] },
    ]);
    const stats = getEgressStats();
    expect(stats.cleanRequests).toBe(1);
    expect(stats.events).toHaveLength(0);
  });
});
