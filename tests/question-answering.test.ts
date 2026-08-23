// ============================================================
// A question must get an ANSWER, never an action plan.
//
// Regression: "check whether i upload photo or not" was routed to the
// action planner, which responded by typing into unrelated fields.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  isQuestionTask,
  answerFromPageState,
  buildVisionQuestionPrompt,
} from "../src/core/agent/question-answering";

function field(o: any) {
  return {
    name: o.name ?? "", id: o.id ?? o.name ?? "", type: o.type ?? "text",
    value: o.value ?? "", required: o.required ?? false, maxLength: 0,
    pattern: "", options: [], rect: {}, label: o.label ?? "", filledByUser: !!o.value,
  };
}
function page(fields: any[]): any {
  return {
    url: "https://uidai.gov.in/update", title: "Address Update", timestamp: 0,
    elements: [], textContent: "", metadata: {}, confidence: 1, perceptionTime: 1,
    forms: [{ id: "f", action: "", method: "post", fields }],
  };
}

describe("isQuestionTask", () => {
  it("recognises the exact phrasing that broke", () => {
    expect(isQuestionTask("check whether i upload photo or not")).toBe(true);
  });

  it("recognises other question forms", () => {
    ["Is my PAN filled in?", "did i upload the document", "what is missing",
     "do i have a photo attached", "tell me if the form is complete",
     "confirm whether my address is set"]
      .forEach((q) => expect(isQuestionTask(q), q).toBe(true));
  });

  it("does not claim plain action instructions", () => {
    ["fill this form", "submit form", "click the submit button",
     "upload my photo", "select Delhi in state"]
      .forEach((t) => expect(isQuestionTask(t), t).toBe(false));
  });

  it("handles empty input", () => {
    expect(isQuestionTask("")).toBe(false);
    expect(isQuestionTask("   ")).toBe(false);
  });
});

describe("upload questions are answered on-device", () => {
  it("says yes and names the file when one is attached", () => {
    const a = answerFromPageState(
      "check whether i upload photo or not",
      page([field({ label: "Applicant Photo", name: "photo", type: "file",
        value: "C:\\fakepath\\Raj_Photo_reduced.jpg" })]),
      null
    );
    expect(a.source).toBe("on-device");
    expect(a.text).toMatch(/^Yes/);
    // The fake path is stripped — the user sees a filename.
    expect(a.detail).toBe("Raj_Photo_reduced.jpg");
    expect(a.detail).not.toContain("fakepath");
  });

  it("says no when the upload field is empty", () => {
    const a = answerFromPageState(
      "did i upload my photo?",
      page([field({ label: "Applicant Photo", name: "photo", type: "file" })]),
      null
    );
    expect(a.text).toMatch(/^No/);
    expect(a.text).toContain("Applicant Photo");
  });

  it("reports partial completion across several uploads", () => {
    const a = answerFromPageState(
      "have i uploaded all documents",
      page([
        field({ label: "Photo", name: "photo", type: "file", value: "a.jpg" }),
        field({ label: "Address Proof", name: "proof", type: "file" }),
      ]),
      null
    );
    expect(a.text).toMatch(/^Partly/);
    expect(a.text).toContain("Address Proof");
  });

  it("flags that pixels are needed when there is no upload field", () => {
    const a = answerFromPageState("is there a photo on this page?", page([]), null);
    expect(a.needsVision).toBe(true);
  });
});

describe("other local answers", () => {
  it("answers completeness questions", () => {
    const a = answerFromPageState(
      "is the form complete?",
      page([
        field({ label: "Name", name: "name", required: true, value: "Raj" }),
        field({ label: "PIN Code", name: "pin", required: true }),
      ]),
      null
    );
    expect(a.text).toMatch(/^Not yet/);
    expect(a.detail).toContain("PIN Code");
  });

  it("answers about a specific named field", () => {
    const a = answerFromPageState(
      "is my PAN Number filled in?",
      page([field({ label: "PAN Number", name: "pan", value: "ABCPE1234F" })]),
      null
    );
    expect(a.text).toMatch(/^Yes/);
  });

  it("answers sensitivity questions from the detection summary", () => {
    const a = answerFromPageState("is there anything sensitive here?", page([]), {
      summary: { totalRegions: 3, byCategory: { aadhaar: 1, phone: 2 } },
    } as any);
    expect(a.text).toContain("3 sensitive region");
    expect(a.source).toBe("on-device");
  });

  it("returns unanswered rather than inventing something", () => {
    const a = answerFromPageState("what is the capital of France?", page([]), null);
    expect(a.source).toBe("unanswered");
    expect(a.text).toBe("");
  });
});

describe("vision prompt safety", () => {
  it("tells the model that redacted areas are removed data, not content", () => {
    const { system } = buildVisionQuestionPrompt("is a photo present?");
    expect(system).toMatch(/redact/i);
    expect(system).toMatch(/never guess/i);
  });
});

describe("pipeline + provider wiring", () => {
  const pipeline = readFileSync(
    new URL("../src/core/pipeline/full-pipeline.ts", import.meta.url), "utf8");
  const providers = readFileSync(
    new URL("../src/core/agent/llm-providers.ts", import.meta.url), "utf8");

  it("questions short-circuit before the action planner", () => {
    expect(pipeline).toContain("isQuestionTask(input.taskDescription)");
    expect(pipeline.indexOf("isQuestionTask")).toBeLessThan(pipeline.indexOf("const planStep"));
  });

  it("only the REDACTED frame is ever sent for a vision answer", () => {
    expect(pipeline).toMatch(/askWithImage\(system, user, redactedScreenshotUrl!?\)/);
    expect(pipeline).not.toContain("askWithImage(system, user, screenshotDataUrl)");
  });

  it("askWithImage refuses anything that is not an inline image", () => {
    expect(providers).toContain("askWithImage requires an inline data: image");
  });
});

describe("the transmitted frame is inspectable and always redacted", () => {
  const pipeline = readFileSync(
    new URL("../src/core/pipeline/full-pipeline.ts", import.meta.url), "utf8");
  const panel = readFileSync(
    new URL("../src/ui/components/AnswerPanel.tsx", import.meta.url), "utf8");

  it("records the redacted frame, never the raw capture", () => {
    expect(pipeline).toContain("frameSent: redactedScreenshotUrl");
    expect(pipeline).not.toContain("frameSent: screenshotDataUrl");
  });

  it("the UI can show the user exactly what was sent", () => {
    expect(panel).toContain("answer.frameSent");
    expect(panel).toContain("See exactly what was sent");
  });

  it("full-size opens via a blob URL, since Chrome blocks data: navigation", () => {
    expect(panel).toContain("createObjectURL");
    expect(panel).not.toMatch(/href=\{answer\.frameSent/);
  });
});

describe("pixels are only sent when redaction was VERIFIED", () => {
  const pipeline = readFileSync(
    new URL("../src/core/pipeline/full-pipeline.ts", import.meta.url), "utf8");

  it("requires a frame, a passing re-OCR verification, AND a face check", () => {
    // Re-OCR proves no readable TEXT survived. A face is not text, so an
    // unavailable face model means the frame cannot be vouched for.
    expect(pipeline).toContain("const canSendPixels");
    expect(pipeline).toMatch(
      /canSendPixels\s*=\s*[\s\S]{0,120}redactionVerified\s*&&\s*faceDetectionRan/
    );
  });

  it("explains each refusal rather than shrugging", () => {
    expect(pipeline).toContain("re-OCR could not confirm");
    expect(pipeline).toContain("the face model is not installed");
  });

  it("a clean page still produces a verifiable frame", () => {
    // Gating redaction on "regions > 0" made every clean page unsendable.
    expect(pipeline).not.toContain("if (redactRegions.length > 0) {");
    expect(pipeline).not.toContain("redactionSummary.redacted > 0");
  });
});

describe("interrogative form beats an action verb", () => {
  // Regression from a PNB login page: "what i have to fill here" contains
  // "fill", was classified as an instruction, and the planner started
  // clicking around a bank page instead of answering.
  it("classifies the exact phrasing that broke as a question", () => {
    expect(isQuestionTask("what i have to fill here")).toBe(true);
  });

  it("treats wh-openers as questions regardless of later verbs", () => {
    ["what do i have to fill", "what should i enter here",
     "which fields do i need to complete", "how do i submit this",
     "where do i type my user id"]
      .forEach((q) => expect(isQuestionTask(q), q).toBe(true));
  });

  it("still treats bare imperatives as actions", () => {
    ["fill this form", "submit form", "click continue",
     "do this now", "select Delhi in state", "type my name"]
      .forEach((t) => expect(isQuestionTask(t), t).toBe(false));
  });

  it("an auxiliary opener needs a subject to be a question", () => {
    expect(isQuestionTask("do i have a photo attached")).toBe(true);
    expect(isQuestionTask("do this now")).toBe(false);
  });
});

describe("answering 'what do I have to fill here'", () => {
  it("names the single required field on a login page", () => {
    const a = answerFromPageState(
      "what i have to fill here",
      page([
        field({ label: "User ID", name: "userid", required: true }),
        field({ label: "Continue", name: "go", type: "submit" }),
      ]),
      null
    );
    expect(a.source).toBe("on-device");
    expect(a.text).toContain("User ID");
    expect(a.text).toMatch(/One required field/);
  });

  it("lists several required fields", () => {
    const a = answerFromPageState(
      "what do i need to fill",
      page([
        field({ label: "Full Name *", name: "name", required: true }),
        field({ label: "PIN Code *", name: "pin", required: true }),
        field({ label: "Landmark", name: "lm" }),
      ]),
      null
    );
    expect(a.text).toContain("2 required fields");
    // The asterisk is presentation, not part of the field name.
    expect(a.text).toContain("Full Name");
    expect(a.text).not.toContain("*");
  });

  it("says so when everything is already filled", () => {
    const a = answerFromPageState(
      "what should i fill",
      page([field({ label: "User ID", name: "u", required: true, value: "raj" })]),
      null
    );
    expect(a.text).toMatch(/^Nothing/);
  });

  it("handles a page with no inputs", () => {
    const a = answerFromPageState("what do i have to fill", page([]), null);
    expect(a.text).toContain("no input fields");
  });
});
