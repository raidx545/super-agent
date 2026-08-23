// Tests for the PII detection engine
import { describe, it, expect } from "vitest";
import {
  detectPIIFromDOM,
  detectPIIFromVision,
  mergePIIResults,
} from "../src/core/privacy/pii-detector";

describe("PII Detector — DOM-based", () => {
  it("detects password fields", () => {
    const elements: any[] = [];
    const forms = [
      {
        id: "login",
        fields: [
          {
            name: "password",
            id: "password",
            type: "password",
            label: "Password",
            value: "secret123",
            required: true,
            pattern: "",
            maxLength: 50,
          },
        ],
      },
    ];

    const result = detectPIIFromDOM(elements, forms, "");

    expect(result.length).toBeGreaterThan(0);
    const pwd = result.find((r) => r.category === "password");
    expect(pwd).toBeDefined();
    expect(pwd!.sensitivity).toBe("critical");
    expect(pwd!.redactionStrategy).toBe("black_box");
  });

  it("detects Aadhaar numbers in form fields", () => {
    const elements: any[] = [];
    const forms = [
      {
        id: "identity",
        fields: [
          {
            name: "aadhaar",
            id: "aadhaar",
            type: "text",
            label: "Aadhaar Number",
            value: "123456789012",
            required: true,
            pattern: "",
            maxLength: 12,
          },
        ],
      },
    ];

    const result = detectPIIFromDOM(elements, forms, "");

    const aadhaar = result.find((r) => r.category === "aadhaar");
    expect(aadhaar).toBeDefined();
    expect(aadhaar!.sensitivity).toBe("critical");
    expect(aadhaar!.textValue).toBe("123456789012");
  });

  it("detects phone numbers in page text", () => {
    const elements: any[] = [];
    const forms: any[] = [];
    const pageText = "Contact us at +91 9876543210 or call 8765432109";

    const result = detectPIIFromDOM(elements, forms, pageText);

    const phones = result.filter((r) => r.category === "phone");
    expect(phones.length).toBeGreaterThan(0);
  });

  it("detects email addresses in page text", () => {
    const elements: any[] = [];
    const forms: any[] = [];
    const pageText = "Send your application to apply@passport.gov.in";

    const result = detectPIIFromDOM(elements, forms, pageText);

    const emails = result.filter((r) => r.category === "email");
    expect(emails.length).toBeGreaterThan(0);
    expect(emails[0].textValue).toContain("@");
  });

  it("detects PAN card numbers", () => {
    const elements: any[] = [];
    const forms: any[] = [];
    // 4th character must be a valid holder type (P = individual).
    // The old fixture "ABCDE1234F" has "D" there, which is not a real PAN
    // and is correctly rejected by the format validator.
    const pageText = "PAN: ABCPE1234F is required for tax filing";

    const result = detectPIIFromDOM(elements, forms, pageText);

    const pan = result.find((r) => r.category === "pan");
    expect(pan).toBeDefined();
    expect(pan!.textValue).toBe("ABCPE1234F");
  });

  it("detects name fields", () => {
    const elements: any[] = [];
    const forms = [
      {
        id: "personal",
        fields: [
          {
            name: "given_name",
            id: "given_name",
            type: "text",
            label: "Given Name",
            value: "Shashank",
            required: true,
            pattern: "",
            maxLength: 50,
          },
          {
            name: "father_name",
            id: "father_name",
            type: "text",
            label: "Father's Name",
            value: "Rajesh Kumar",
            required: true,
            pattern: "",
            maxLength: 50,
          },
        ],
      },
    ];

    const result = detectPIIFromDOM(elements, forms, "");

    const names = result.filter((r) => r.category === "name");
    expect(names.length).toBe(2);
    expect(names.every((n) => n.sensitivity === "medium")).toBe(true);
  });

  it("detects financial fields", () => {
    const elements: any[] = [];
    const forms = [
      {
        id: "payment",
        fields: [
          {
            name: "card_number",
            id: "card_number",
            type: "text",
            label: "Card Number",
            value: "4111111111111111",
            required: true,
            pattern: "",
            maxLength: 16,
          },
          {
            name: "cvv",
            id: "cvv",
            type: "text",
            label: "CVV",
            value: "123",
            required: true,
            pattern: "",
            maxLength: 3,
          },
        ],
      },
    ];

    const result = detectPIIFromDOM(elements, forms, "");

    const financial = result.filter((r) => r.category === "financial");
    expect(financial.length).toBeGreaterThan(0);
  });
});

describe("PII Detector — Merging", () => {
  it("deduplicates overlapping regions from DOM and vision", () => {
    const domRegions = [
      {
        id: "dom-1",
        category: "phone" as const,
        sensitivity: "high" as const,
        boundingBox: { x: 100, y: 200, width: 200, height: 30 },
        textValue: "9876543210",
        fieldSelector: null,
        confidence: 0.9,
        source: "dom" as const,
        detectionMethod: "DOM regex",
        redactionStrategy: "mask_text" as const,
      },
    ];

    const visionRegions = [
      {
        id: "vis-1",
        category: "phone" as const,
        sensitivity: "high" as const,
        boundingBox: { x: 105, y: 202, width: 190, height: 28 },
        textValue: "9876543210",
        fieldSelector: null,
        confidence: 0.85,
        source: "vision" as const,
        detectionMethod: "OCR scan",
        redactionStrategy: "mask_text" as const,
      },
    ];

    const result = mergePIIResults(domRegions, visionRegions);

    // Should merge into one region with "combined" source and boosted confidence
    expect(result.regions.length).toBe(1);
    expect(result.regions[0].source).toBe("combined");
    expect(result.regions[0].confidence).toBeGreaterThan(0.9);
  });

  it("generates correct summary statistics", () => {
    const domRegions = [
      {
        id: "dom-1",
        category: "password" as const,
        sensitivity: "critical" as const,
        boundingBox: null,
        textValue: null,
        fieldSelector: "#pwd",
        confidence: 0.95,
        source: "dom" as const,
        detectionMethod: "type=password",
        redactionStrategy: "black_box" as const,
      },
      {
        id: "dom-2",
        category: "name" as const,
        sensitivity: "medium" as const,
        boundingBox: null,
        textValue: "John",
        fieldSelector: "#name",
        confidence: 0.8,
        source: "dom" as const,
        detectionMethod: "field label",
        redactionStrategy: "mask_text" as const,
      },
    ];

    const result = mergePIIResults(domRegions, []);

    expect(result.summary.totalRegions).toBe(2);
    expect(result.summary.criticalCount).toBe(1);
    expect(result.summary.mediumCount).toBe(1);
    expect(result.summary.bySource.dom).toBe(2);
  });
});

describe("PII Detector — Edge Cases", () => {
  it("handles empty DOM data", () => {
    const result = detectPIIFromDOM([], [], "");
    expect(result).toEqual([]);
  });

  it("handles elements without bounding boxes", () => {
    const elements: any[] = [
      { id: "el-1", tag: "div", role: "", text: "Call 9876543210", label: "", type: "", ariaLabel: "", placeholder: "", rect: { x: 0, y: 0, width: 100, height: 20 } },
    ];

    const result = detectPIIFromDOM(elements, [], "");
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters low-confidence results below threshold", () => {
    const domRegions = [
      {
        id: "low-1",
        category: "phone" as const,
        sensitivity: "medium" as const,
        boundingBox: null,
        textValue: "12345",
        fieldSelector: null,
        confidence: 0.3,
        source: "dom" as const,
        detectionMethod: "weak match",
        redactionStrategy: "mask_text" as const,
      },
    ];

    const result = mergePIIResults(domRegions, [], 0.5);
    expect(result.regions.length).toBe(0);
  });
});

describe("PII Detector — false positives from real UIDAI form", () => {
  const field = (label: string, name: string, type = "text") => ({
    name, id: name, type, label, value: "", required: false,
    maxLength: 0, pattern: "", options: [], rect: {}, filledByUser: false,
  });
  const form = (fields: any[]) => [{ id: "f", action: "", method: "post", fields }];
  const cats = (fields: any[]) =>
    detectPIIFromDOM([], form(fields) as any, "").map((r) => r.category);

  it("does not call an IFSC field an Aadhaar field", () => {
    // The label contains "Aadhaar", but the field is an IFSC code.
    const c = cats([field("IFSC Code (for Aadhaar-Bank linking)", "ifsc")]);
    expect(c).toContain("ifsc");
    expect(c).not.toContain("aadhaar");
  });

  it("does not treat a UIDAI consent checkbox as PII", () => {
    // "UIDAI" contains "uid"; the sentence contains "address".
    const c = cats([
      field(
        "I authorize UIDAI to update my address based on the documents uploaded. I confirm the information is correct.",
        "consent",
        "checkbox"
      ),
    ]);
    expect(c).toHaveLength(0);
  });

  it("treats PIN Code as an address field, never a password", () => {
    const c = cats([field("PIN Code", "pincode")]);
    expect(c).toContain("address");
    expect(c).not.toContain("password");
  });

  it("still catches a genuine OTP field as a credential", () => {
    expect(cats([field("OTP received on registered mobile", "otp")])).toContain("password");
  });

  it("assigns one category per field, not every keyword match", () => {
    const regions = detectPIIFromDOM([], form([
      field("Aadhaar Number", "aadhaar"),
      field("PAN Number", "pan"),
      field("Full Name", "name"),
      field("Mobile Number", "mobile"),
    ]) as any, "");
    // Four fields in, at most four field-derived regions out.
    expect(regions.length).toBeLessThanOrEqual(4);
    expect(regions.map((r) => r.category).sort()).toEqual(["aadhaar", "name", "pan", "phone"]);
  });

  it("ignores radio and submit inputs entirely", () => {
    expect(cats([
      field("Aadhaar Number", "idType", "radio"),
      field("Submit Update Request", "submit", "submit"),
    ])).toHaveLength(0);
  });
});
