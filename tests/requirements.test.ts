// ============================================================
// The agent must report what it needs, not guess or stay silent.
//
// Regression: a required State <select> was left on "-- Select State --",
// so the browser rejected the submit with "Please select an item in the
// list" and the user had no idea which field was at fault.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  computeRequirements,
  isPlaceholderOption,
  summarizeOutcome,
} from "../src/core/agent/requirements";

function field(o: any) {
  return {
    name: o.name ?? "", id: o.id ?? o.name ?? "", type: o.type ?? "text",
    value: o.value ?? "", required: o.required ?? true, maxLength: 0,
    pattern: "", options: o.options ?? [], rect: {}, label: o.label ?? "",
    filledByUser: !!o.value,
  };
}
function page(fields: any[]): any {
  return {
    url: "https://uidai.gov.in/update", title: "Address Update", timestamp: 0,
    elements: [], textContent: "", metadata: {}, confidence: 1, perceptionTime: 1,
    forms: [{ id: "f", action: "", method: "post", fields }],
  };
}

describe("isPlaceholderOption", () => {
  it("recognises the placeholder that caused the failed submit", () => {
    expect(isPlaceholderOption("-- Select State --")).toBe(true);
  });
  it("recognises common placeholder shapes", () => {
    ["", "  ", "Select", "Select State", "Choose one", "Please select an option", "None", "---"]
      .forEach((o) => expect(isPlaceholderOption(o), o).toBe(true));
  });
  it("does not swallow real options", () => {
    ["Uttar Pradesh", "Delhi", "Karnataka", "Selected Works"]
      .forEach((o) => expect(isPlaceholderOption(o), o).toBe(false));
  });
});

describe("computeRequirements", () => {
  it("reports a required select still on its placeholder", () => {
    const needs = computeRequirements(
      page([field({ label: "State", name: "state", type: "select",
        value: "-- Select State --", options: ["-- Select State --", "Delhi", "Uttar Pradesh"] })]),
      null, undefined
    );
    expect(needs).toHaveLength(1);
    expect(needs[0].label).toBe("State");
    expect(needs[0].reason).toBe("no_local_value");
    // The user must be offered the real choices, minus the placeholder.
    expect(needs[0].options).toEqual(["Delhi", "Uttar Pradesh"]);
  });

  it("ignores fields that are already filled", () => {
    expect(computeRequirements(
      page([field({ label: "House No.", name: "house", value: "123 Main St" })]), null, undefined
    )).toHaveLength(0);
  });

  it("ignores optional empty fields", () => {
    expect(computeRequirements(
      page([field({ label: "Landmark", name: "landmark", required: false })]), null, undefined
    )).toHaveLength(0);
  });

  it("ignores checkboxes and submit buttons", () => {
    expect(computeRequirements(
      page([
        field({ label: "I authorize UIDAI…", name: "consent", type: "checkbox" }),
        field({ label: "Submit", name: "go", type: "submit" }),
      ]), null, undefined
    )).toHaveLength(0);
  });

  it("distinguishes 'no saved value' from 'saved but not applied'", () => {
    const needs = computeRequirements(
      page([
        field({ label: "PIN Code", name: "pincode" }),
        field({ label: "District", name: "district" }),
      ]),
      null,
      { pincode: "452001" }
    );
    const byLabel = Object.fromEntries(needs.map((n) => [n.label, n.reason]));
    expect(byLabel["PIN Code"]).toBe("still_empty_after_run");
    expect(byLabel["District"]).toBe("no_local_value");
  });

  it("matches saved keys tolerantly across case and punctuation", () => {
    const needs = computeRequirements(
      page([field({ label: "Full Name *", name: "full_name" })]),
      null,
      { "Full Name": "Raj" }
    );
    expect(needs[0].reason).toBe("still_empty_after_run");
  });

  it("carries the PII category through for the UI", () => {
    const needs = computeRequirements(
      page([field({ label: "Aadhaar Number", id: "aadhaar" })]),
      { regions: [{ fieldSelector: "#aadhaar", category: "aadhaar" }] } as any,
      undefined
    );
    expect(needs[0].category).toBe("aadhaar");
  });
});

describe("summarizeOutcome", () => {
  it("says so when nothing is outstanding", () => {
    expect(summarizeOutcome(5, 5, [])).toContain("nothing outstanding");
  });
  it("names how many values it still needs", () => {
    const s = summarizeOutcome(4, 5, [
      { reason: "no_local_value" } as any,
      { reason: "no_local_value" } as any,
    ]);
    expect(s).toContain("4/5 steps done");
    expect(s).toContain("2 required fields still need a value from you");
  });
  it("uses singular wording for one field", () => {
    expect(summarizeOutcome(1, 1, [{ reason: "no_local_value" } as any]))
      .toContain("1 required field still needs a value");
  });
});
