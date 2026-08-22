// ============================================================
// VLESS — Form Validator Tests
// Tests for Indian government form validation rules
// ============================================================

import { describe, it, expect } from "vitest";
import { validateForm } from "../src/core/agent/validator";

describe("validateForm", () => {
  describe("required field validation", () => {
    it("should flag empty required fields", () => {
      const result = validateForm([
        { name: "email", id: "email", label: "Email", type: "email", value: "", required: true },
      ]);

      expect(result.allValid).toBe(false);
      expect(result.fields[0].valid).toBe(false);
      expect(result.fields[0].rule).toBe("required");
      expect(result.riskLevel).toBe("high");
    });

    it("should pass filled required fields", () => {
      const result = validateForm([
        { name: "email", id: "email", label: "Email", type: "email", value: "test@example.com", required: true },
      ]);

      expect(result.allValid).toBe(true);
      expect(result.fields[0].valid).toBe(true);
    });

    it("should allow empty optional fields", () => {
      const result = validateForm([
        { name: "nickname", id: "nick", label: "Nickname", type: "text", value: "", required: false },
      ]);

      expect(result.allValid).toBe(true);
      expect(result.fields[0].valid).toBe(true);
      expect(result.fields[0].rule).toBe("optional");
    });
  });

  describe("Aadhaar validation", () => {
    it("should accept valid 12-digit Aadhaar", () => {
      const result = validateForm([
        { name: "aadhaar", id: "aadhaar", label: "Aadhaar Number", type: "text", value: "123456789012", required: true },
      ]);

      expect(result.allValid).toBe(true);
      expect(result.fields[0].valid).toBe(true);
    });

    it("should reject non-12-digit Aadhaar", () => {
      const result = validateForm([
        { name: "aadhaar", id: "aadhaar", label: "Aadhaar Number", type: "text", value: "12345", required: true },
      ]);

      expect(result.allValid).toBe(false);
      expect(result.fields[0].valid).toBe(false);
    });

    it("should reject Aadhaar with letters", () => {
      const result = validateForm([
        { name: "aadhaar", id: "aadhaar", label: "Aadhaar Number", type: "text", value: "12345abcDEF", required: true },
      ]);

      expect(result.allValid).toBe(false);
    });
  });

  describe("PAN validation", () => {
    it("should accept valid PAN format", () => {
      const result = validateForm([
        { name: "pan", id: "pan", label: "PAN Card Number", type: "text", value: "ABCDE1234F", required: true },
      ]);

      expect(result.allValid).toBe(true);
    });

    it("should reject invalid PAN format", () => {
      const result = validateForm([
        { name: "pan", id: "pan", label: "PAN Card Number", type: "text", value: "abcde1234f", required: true },
      ]);

      expect(result.allValid).toBe(false);
    });
  });

  describe("PIN code validation", () => {
    it("should accept valid 6-digit PIN", () => {
      const result = validateForm([
        { name: "pincode", id: "pin", label: "PIN Code", type: "text", value: "110001", required: true },
      ]);

      expect(result.allValid).toBe(true);
    });

    it("should reject non-6-digit PIN", () => {
      const result = validateForm([
        { name: "pincode", id: "pin", label: "PIN Code", type: "text", value: "1234", required: true },
      ]);

      expect(result.allValid).toBe(false);
    });
  });

  describe("phone validation", () => {
    it("should accept valid Indian phone number", () => {
      const result = validateForm([
        { name: "phone", id: "phone", label: "Mobile Number", type: "tel", value: "9876543210", required: true },
      ]);

      expect(result.allValid).toBe(true);
    });

    it("should accept phone starting with 6", () => {
      const result = validateForm([
        { name: "phone", id: "phone", label: "Mobile Number", type: "tel", value: "6876543210", required: true },
      ]);

      expect(result.allValid).toBe(true);
    });

    it("should reject phone starting with 5", () => {
      const result = validateForm([
        { name: "phone", id: "phone", label: "Mobile Number", type: "tel", value: "5876543210", required: true },
      ]);

      expect(result.allValid).toBe(false);
    });
  });

  describe("email validation", () => {
    it("should accept valid email", () => {
      const result = validateForm([
        { name: "email", id: "email", label: "Email Address", type: "email", value: "user@example.com", required: true },
      ]);

      expect(result.allValid).toBe(true);
    });

    it("should reject invalid email", () => {
      const result = validateForm([
        { name: "email", id: "email", label: "Email Address", type: "email", value: "not-an-email", required: true },
      ]);

      expect(result.allValid).toBe(false);
    });
  });

  describe("maxLength validation", () => {
    it("should reject values exceeding maxLength", () => {
      const result = validateForm([
        { name: "name", id: "name", label: "Name", type: "text", value: "This is a very long name that exceeds limit", required: true, maxLength: 20 },
      ]);

      expect(result.allValid).toBe(false);
      expect(result.fields[0].rule).toBe("maxLength");
    });

    it("should accept values within maxLength", () => {
      const result = validateForm([
        { name: "name", id: "name", label: "Name", type: "text", value: "Shashank", required: true, maxLength: 50 },
      ]);

      expect(result.allValid).toBe(true);
    });
  });

  describe("IFSC validation", () => {
    it("should accept valid IFSC code", () => {
      const result = validateForm([
        { name: "ifsc", id: "ifsc", label: "IFSC Code", type: "text", value: "SBIN0001234", required: true },
      ]);

      expect(result.allValid).toBe(true);
    });

    it("should reject invalid IFSC code", () => {
      const result = validateForm([
        { name: "ifsc", id: "ifsc", label: "IFSC Code", type: "text", value: "INVALID", required: true },
      ]);

      expect(result.allValid).toBe(false);
    });
  });

  describe("mixed field validation", () => {
    it("should validate multiple fields correctly", () => {
      const result = validateForm([
        { name: "name", id: "name", label: "Name", type: "text", value: "Shashank", required: true },
        { name: "email", id: "email", label: "Email", type: "email", value: "test@example.com", required: true },
        { name: "aadhaar", id: "aadhaar", label: "Aadhaar", type: "text", value: "123456789012", required: true },
        { name: "phone", id: "phone", label: "Phone", type: "tel", value: "9876543210", required: true },
        { name: "pin", id: "pin", label: "PIN", type: "text", value: "110001", required: true },
      ]);

      expect(result.allValid).toBe(true);
      expect(result.fields).toHaveLength(5);
      expect(result.fields.every((f) => f.valid)).toBe(true);
    });

    it("should report blocking issues for invalid required fields", () => {
      const result = validateForm([
        { name: "name", id: "name", label: "Name", type: "text", value: "Shashank", required: true },
        { name: "aadhaar", id: "aadhaar", label: "Aadhaar", type: "text", value: "123", required: true },
        { name: "phone", id: "phone", label: "Phone", type: "tel", value: "", required: true },
      ]);

      expect(result.allValid).toBe(false);
      expect(result.blockingIssues.length).toBeGreaterThan(0);
      expect(result.riskLevel).toBe("high");
    });
  });
});
