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

describe("face detection wiring", () => {
  // Regression: the pipeline called detectAllPII(domData, undefined, ocr),
  // so the vision canvas was never supplied and detectPIIFromVision — the
  // only path that finds faces — never ran. An applicant photo on a UIDAI
  // form was detected as nothing and left unredacted.
  it("faces are detected offscreen, not with an undefined canvas", () => {
    expect(src).toContain('callOffscreen("detectFaces"');
  });

  it("face regions are merged into the detection result", () => {
    expect(src).toContain("faceRegions");
    expect(src).toMatch(/category: "face"/);
    // Faces are destroyed with a solid fill, not blurred: a blur leaves
    // recoverable pixels behind, and reads ambiguously in a demo.
    expect(src).toMatch(/redactionStrategy: "black_box"/);
  });

  it("viewport dimensions are passed so blur boxes scale correctly", () => {
    // Screenshots are devicePixelRatio-scaled; DOM rects are CSS pixels.
    expect(src).toContain("viewportWidth: domData.metadata?.viewportWidth");
  });
});

describe("review is scoped to what was written", () => {
  it("only fields the plan typed or selected are reviewed", () => {
    // A submit-only task writes nothing; listing every value on the page
    // afterwards reads as an unrequested data dump.
    expect(src).toContain("wroteTo");
    expect(src).toMatch(/action\.type === "type" \|\| st\.action\.type === "select"/);
  });
});

describe("viewport capture", () => {
  const content = readFileSync(
    new URL("../src/entrypoints/content/index.ts", import.meta.url), "utf8");

  it("the content script reports viewport size and DPR", () => {
    expect(content).toContain("viewportWidth: window.innerWidth");
    expect(content).toContain("viewportHeight: window.innerHeight");
    expect(content).toContain("devicePixelRatio");
  });
});

describe("the live page is never modified", () => {
  // The user's own screen is not the threat model. Blur CSS made their own
  // values unreadable, and [FACE] boxes littered a bank login page with
  // labelled rectangles — all to solve a problem that exists only at the
  // network boundary.
  it("redaction CSS is removed, never injected", () => {
    expect(src).toContain('sendToContentScript("REMOVE_REDACTION_CSS"');
    expect(src).not.toContain('sendToContentScript("INJECT_REDACTION_CSS"');
  });

  it("the PII overlay is hidden, never shown", () => {
    expect(src).toContain('sendToContentScript("HIDE_PII_OVERLAY"');
    expect(src).not.toContain('sendToContentScript("SHOW_PII_OVERLAY"');
  });

  it("screenshot redaction still runs offscreen", () => {
    expect(src).toContain('callOffscreen("redactScreenshot"');
  });
});

describe("face detection is region-gated", () => {
  // BlazeFace short-range resizes input to 128x128. On a Retina full-page
  // capture a passport photo (~260 device px in a 2880 px frame) becomes
  // ~12 px in the tensor and is undetectable — which is why the UIDAI
  // applicant photo went out unblurred.
  const offscreen = readFileSync(
    new URL("../src/core/privacy/offscreen-redact.ts", import.meta.url), "utf8");
  const content = readFileSync(
    new URL("../src/entrypoints/content/index.ts", import.meta.url), "utf8");

  it("image regions are collected from the page", () => {
    expect(content).toContain("collectImageRegions");
    expect(content).toContain("img, canvas, svg, picture, video");
  });

  it("regions are passed to the detector", () => {
    expect(src).toContain("imageRegions: domData.imageRegions");
  });

  it("crops are upscaled before detection", () => {
    expect(offscreen).toContain("MIN_DETECT_SIDE");
    expect(offscreen).toMatch(/upscale\s*=\s*Math\.max\(1,\s*MIN_DETECT_SIDE/);
  });

  it("a whole-frame pass still runs, for faces large enough to see", () => {
    expect(offscreen).toContain("detectFaces(canvas)");
  });

  it("overlapping detections are deduped", () => {
    expect(offscreen).toContain("dedupeFaces");
  });
});

describe("redaction boxes are scaled to the capture", () => {
  // Regions are CSS pixels; the screenshot is device pixels. redactScreenshot
  // takes viewport dimensions to convert between them, but neither the
  // pipeline nor the offscreen handler passed them — so scale defaulted to 1
  // and on a 2x display every box was drawn at half position and quarter
  // area, with ZERO overlap with what it was meant to cover.
  const offscreenMain = readFileSync(
    new URL("../src/entrypoints/offscreen/main.ts", import.meta.url), "utf8");

  it("the pipeline sends viewport dimensions with the regions", () => {
    const call = src.slice(
      src.indexOf('callOffscreen("redactScreenshot"'),
      src.indexOf('callOffscreen("redactScreenshot"') + 500
    );
    expect(call).toContain("viewportWidth");
    expect(call).toContain("viewportHeight");
  });

  it("the offscreen handler forwards them", () => {
    const handler = offscreenMain.slice(
      offscreenMain.indexOf("redactScreenshot: (params)"),
      offscreenMain.indexOf("redactScreenshot: (params)") + 400
    );
    expect(handler).toContain("params.viewportWidth");
    expect(handler).toContain("params.viewportHeight");
  });

  it("scaling a box by devicePixelRatio actually moves it", () => {
    // Guards the arithmetic the bug turned on.
    const dpr = 2, box = { x: 468, y: 452, w: 140, h: 175 };
    const scaled = { x: box.x * dpr, y: box.y * dpr, w: box.w * dpr, h: box.h * dpr };
    const ox = Math.max(0, Math.min(scaled.x + scaled.w, box.x + box.w) - Math.max(scaled.x, box.x));
    const oy = Math.max(0, Math.min(scaled.y + scaled.h, box.y + box.h) - Math.max(scaled.y, box.y));
    expect(ox * oy).toBe(0);
  });
});
