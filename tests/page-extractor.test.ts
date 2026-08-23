import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  isExtractionTask,
  extractPageData,
  extractedDataToJSON,
} from "../src/core/extraction/page-extractor";

const VALID_AADHAAR = "234123412346";

function makePageState(overrides: any = {}): any {
  return {
    url: "https://example.gov.in/apply",
    title: "Passport Application",
    timestamp: Date.now(),
    elements: [],
    forms: [],
    textContent: "",
    metadata: {},
    confidence: 1,
    perceptionTime: 10,
    ...overrides,
  };
}

function makeForm(fields: any[]) {
  return {
    id: "applicationForm",
    action: "",
    method: "post",
    fields: fields.map((f) => ({
      name: f.name ?? "",
      id: f.id ?? "",
      type: f.type ?? "text",
      value: f.value ?? "",
      required: false,
      maxLength: 0,
      pattern: "",
      options: [],
      rect: {},
      label: f.label ?? "",
      checked: f.checked,
      filledByUser: false,
    })),
  };
}

describe("isExtractionTask", () => {
  it("recognizes the Extract data quick action", () => {
    expect(
      isExtractionTask("Extract all visible data from this page into structured format")
    ).toBe(true);
  });

  it("recognizes other read phrasings", () => {
    expect(isExtractionTask("scrape this page")).toBe(true);
    expect(isExtractionTask("read this page")).toBe(true);
    expect(isExtractionTask("what's on this page?")).toBe(true);
  });

  it("does not claim action tasks", () => {
    expect(isExtractionTask("fill this form")).toBe(false);
    expect(isExtractionTask("click the submit button")).toBe(false);
    expect(isExtractionTask("scroll down")).toBe(false);
  });

  it("yields to the action when a task mixes both", () => {
    // The fill is the deliverable; extraction is incidental phrasing.
    expect(isExtractionTask("extract my details and fill this form")).toBe(false);
  });

  it("handles empty input", () => {
    expect(isExtractionTask("")).toBe(false);
    expect(isExtractionTask("   ")).toBe(false);
  });
});

describe("extractPageData", () => {
  it("returns filled form values", () => {
    const page = makePageState({
      forms: [makeForm([
        { label: "Given Name", name: "given_name", value: "Raj" },
        { label: "Surname", name: "surname", value: "Porwal" },
      ])],
    });

    const data = extractPageData(page, null);
    const fields = data.sections.flatMap((s) => s.fields);

    expect(fields.find((f) => f.label === "Given Name")?.value).toBe("Raj");
    expect(data.summary.filledFieldCount).toBe(2);
  });

  it("masks a value flagged by PII detection but keeps it revealable", () => {
    const page = makePageState({
      forms: [makeForm([
        { label: "Aadhaar Number", id: "aadhaar", value: VALID_AADHAAR },
      ])],
    });
    const detection: any = {
      regions: [{ fieldSelector: "#aadhaar", category: "aadhaar" }],
    };

    const data = extractPageData(page, detection);
    const field = data.sections[0].fields[0];

    expect(field.masked).toBe(true);
    expect(field.value).not.toBe(VALID_AADHAAR);
    expect(field.rawValue).toBe(VALID_AADHAAR);
    expect(field.piiCategory).toBe("aadhaar");
  });

  it("masks a PII value even when its field was not flagged", () => {
    // The region detectors can miss a field; the value itself is still scanned.
    const page = makePageState({
      forms: [makeForm([{ label: "Reference", name: "ref", value: VALID_AADHAAR }])],
    });

    const field = extractPageData(page, null).sections[0].fields[0];
    expect(field.masked).toBe(true);
    expect(field.piiCategory).toBe("aadhaar");
  });

  it("never carries a password value, even as rawValue", () => {
    const page = makePageState({
      forms: [makeForm([{ label: "Password", name: "pw", type: "password", value: "hunter2" }])],
    });

    const field = extractPageData(page, null).sections[0].fields[0];
    expect(field.rawValue).toBeUndefined();
    expect(JSON.stringify(field)).not.toContain("hunter2");
  });

  it("leaves non-PII values unmasked", () => {
    const page = makePageState({
      forms: [makeForm([{ label: "City", name: "city", value: "Indore" }])],
    });

    const field = extractPageData(page, null).sections[0].fields[0];
    expect(field.masked).toBe(false);
    expect(field.value).toBe("Indore");
    expect(field.piiCategory).toBeNull();
  });

  it("handles a page with no forms", () => {
    const data = extractPageData(makePageState(), null);
    expect(data.summary.fieldCount).toBe(0);
    expect(data.sections).toEqual([]);
  });
});

describe("extractedDataToJSON", () => {
  const page = makePageState({
    forms: [makeForm([
      { label: "Aadhaar", id: "aadhaar", value: VALID_AADHAAR },
      { label: "City", name: "city", value: "Indore" },
    ])],
  });
  const detection: any = { regions: [{ fieldSelector: "#aadhaar", category: "aadhaar" }] };

  it("keeps PII masked by default", () => {
    const json = extractedDataToJSON(extractPageData(page, detection));
    expect(json).not.toContain(VALID_AADHAAR);
    expect(json).toContain("Indore");
  });

  it("includes real values only when explicitly requested", () => {
    const json = extractedDataToJSON(extractPageData(page, detection), {
      includeRawValues: true,
    });
    expect(json).toContain(VALID_AADHAAR);
  });
});

describe("architectural guard: extraction never reaches a provider", () => {
  // These invariants are the whole privacy claim for extraction. They are
  // easy to break with a well-meaning refactor ("just pass the page data
  // to the planner for context"), so assert them against the source.
  const read = (p: string) =>
    readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

  const providerModules = [
    "core/agent/llm-providers.ts",
    "core/agent/server-bridge.ts",
    "core/agent/llm-bridge.ts",
  ];

  it("no provider module imports the extractor", () => {
    for (const mod of providerModules) {
      expect(read(mod), mod).not.toContain("page-extractor");
    }
  });

  it("no provider module references extractedData", () => {
    for (const mod of providerModules) {
      expect(read(mod), mod).not.toContain("extractedData");
    }
  });

  it("SanitizedContext carries no user data values", () => {
    const src = read("core/agent/server-bridge.ts");
    const typeStart = src.indexOf("export interface SanitizedContext");
    const typeEnd = src.indexOf("export interface PlanResult");
    const typeBody = src.slice(typeStart, typeEnd);
    // Field NAMES may be exposed; values must not be.
    expect(typeBody).toContain("dataFieldNames");
    expect(typeBody).not.toMatch(/^\s*dataContext\??:/m);
  });
});

describe("control inputs are not treated as secrets", () => {
  it("collapses a radio group to its selected option", () => {
    // Real case from myaadhaar.uidai.gov.in: four radios sharing a name,
    // each reporting its own option token as `.value`.
    const page = makePageState({
      forms: [makeForm([
        { label: "Aadhaar Number", name: "idType", type: "radio", value: "uid", checked: true },
        { label: "Enrolment ID Number", name: "idType", type: "radio", value: "eid" },
        { label: "Virtual ID Number", name: "idType", type: "radio", value: "vid" },
        { label: "SID", name: "idType", type: "radio", value: "sid" },
      ])],
    });

    const fields = extractPageData(page, null).sections[0].fields;
    expect(fields).toHaveLength(1);
    expect(fields[0].value).toBe("Aadhaar Number");
    expect(fields[0].masked).toBe(false);
  });

  it("reports an unselected radio group plainly", () => {
    const page = makePageState({
      forms: [makeForm([
        { label: "Aadhaar Number", name: "idType", type: "radio", value: "uid" },
        { label: "SID", name: "idType", type: "radio", value: "sid" },
      ])],
    });
    expect(extractPageData(page, null).sections[0].fields[0].value).toBe("(none selected)");
  });

  it("never masks a radio token even when the label matches a PII rule", () => {
    // "Aadhaar Number" matches the aadhaar field rule, but "uid" is not PII.
    const page = makePageState({
      forms: [makeForm([
        { label: "Aadhaar Number", id: "uidRadio", name: "idType", type: "radio", value: "uid", checked: true },
      ])],
    });
    const detection: any = { regions: [{ fieldSelector: "#uidRadio", category: "aadhaar" }] };

    const field = extractPageData(page, detection).sections[0].fields[0];
    expect(field.masked).toBe(false);
    expect(field.value).not.toContain("*");
  });

  it("shows checkbox state rather than its value token", () => {
    const page = makePageState({
      forms: [makeForm([
        { label: "I authorize UIDAI", name: "consent", type: "checkbox", value: "on", checked: true },
      ])],
    });
    const field = extractPageData(page, null).sections[0].fields[0];
    expect(field.value).toBe("checked");
    expect(field.masked).toBe(false);
  });

  it("still masks a real value in a flagged text field", () => {
    const page = makePageState({
      forms: [makeForm([
        { label: "Enter Aadhaar Number", id: "aadhaar", value: VALID_AADHAAR },
      ])],
    });
    const detection: any = { regions: [{ fieldSelector: "#aadhaar", category: "aadhaar" }] };

    const field = extractPageData(page, detection).sections[0].fields[0];
    expect(field.masked).toBe(true);
    expect(field.rawValue).toBe(VALID_AADHAAR);
  });
});
