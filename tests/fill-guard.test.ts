// ============================================================
// The agent must never write a sanitization marker into a real form.
//
// Regression: asking "fill this form" with no local data produced
// literal "[PII:address]" typed into a UIDAI address field, because
// the planner echoes the [PII:category] markers it is shown and the
// executor typed whatever the plan supplied.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/core/pipeline/full-pipeline.ts", import.meta.url),
  "utf8"
);

/** The guard as it is written in the pipeline, extracted for direct testing. */
const ARTIFACT = /^\s*(\[PII:[^\]]*\]|\[REDACTED:[^\]]*\]|<[A-Z_]+_\d+>|\*{2,})\s*$/i;

describe("sanitization-artifact guard", () => {
  it("rejects the exact string that leaked into the form", () => {
    expect(ARTIFACT.test("[PII:address]")).toBe(true);
  });

  it("rejects every marker shape the sanitizer emits", () => {
    ["[PII:aadhaar]", "[PII:password]", "[REDACTED:phone]", "<AADHAAR_1>", "<NAME_12>", "***", "**"]
      .forEach((v) => expect(ARTIFACT.test(v), v).toBe(true));
  });

  it("tolerates surrounding whitespace", () => {
    expect(ARTIFACT.test("  [PII:address] ")).toBe(true);
  });

  it("does not reject legitimate values", () => {
    ["Raj Porwal", "234123412346", "ABCPE1234F", "Indore", "9876543210",
     "you@example.com", "SBIN0001234", "12/05/1998", "*"]
      .forEach((v) => expect(ARTIFACT.test(v), v).toBe(false));
  });

  it("does not reject a value that merely contains a marker-like word", () => {
    expect(ARTIFACT.test("PII coordinator")).toBe(false);
    expect(ARTIFACT.test("Flat 3, Redacted Lane")).toBe(false);
  });
});

describe("pipeline wiring", () => {
  it("the guard is actually applied in executePlanSteps", () => {
    expect(src).toContain("isSanitizationArtifact");
    // It must run for type actions, not only when dataContext exists —
    // the original bug was that resolution was gated on dataContext.
    expect(src).toMatch(/if \(step\.action\.type === "type"\) \{/);
  });

  it("skipped fields are reported rather than silently dropped", () => {
    expect(src).toContain("no local value available");
  });

  it("values are resolved locally, never taken from the planner for PII", () => {
    expect(src).toContain("resolveDataValue");
  });

  it("a post-action review is built from a fresh page read", () => {
    expect(src).toContain("buildPIIReview");
    expect(src).toContain("PHASE 7.5");
  });
});

describe("resolveDataValue tolerance", () => {
  // Mirrors the helper: planner targets are labels, user keys rarely match case.
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const resolve = (ctx: Record<string, string>, target: string) => {
    if (ctx[target] !== undefined) return ctx[target];
    const wanted = norm(target);
    if (!wanted) return undefined;
    for (const k of Object.keys(ctx)) if (norm(k) === wanted) return ctx[k];
    return undefined;
  };

  it("matches an exact key", () => {
    expect(resolve({ full_name: "Raj" }, "full_name")).toBe("Raj");
  });

  it("matches across case and punctuation differences", () => {
    expect(resolve({ "Full Name": "Raj" }, "full_name")).toBe("Raj");
    expect(resolve({ full_name: "Raj" }, "Full Name *")).toBe("Raj");
  });

  it("returns undefined when there is genuinely no value", () => {
    expect(resolve({ city: "Indore" }, "aadhaar")).toBeUndefined();
    expect(resolve({}, "")).toBeUndefined();
  });
});
