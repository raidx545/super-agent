// ============================================================
// VLESS — Form Validation Agent
// Validates every field before submission
// Catches errors BEFORE they happen — not after
// ============================================================

export interface FieldValidation {
  fieldName: string;
  value: string;
  valid: boolean;
  rule: string;
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  allValid: boolean;
  fields: FieldValidation[];
  riskLevel: "low" | "medium" | "high";
  blockingIssues: string[];
}

// ── Indian Government Form Rules ─────────────────────────────

const VALIDATION_RULES: Record<
  string,
  { pattern: RegExp; message: string; suggestion?: string }[]
> = {
  // Identity
  "aadhaar": [
    { pattern: /^\d{12}$/, message: "Aadhaar must be exactly 12 digits", suggestion: "Remove spaces and dashes" },
  ],
  "pan": [
    { pattern: /^[A-Z]{5}\d{4}[A-Z]$/, message: "PAN must be ABCDE1234F format", suggestion: "5 letters + 4 digits + 1 letter" },
  ],
  "pin": [
    { pattern: /^\d{6}$/, message: "PIN code must be exactly 6 digits", suggestion: "Check your area PIN code" },
  ],
  "phone": [
    { pattern: /^[+]?[6-9]\d{9}$/, message: "Invalid Indian phone number", suggestion: "Start with 6-9, total 10 digits" },
  ],
  "mobile": [
    { pattern: /^[+]?[6-9]\d{9}$/, message: "Invalid mobile number", suggestion: "Start with 6-9, total 10 digits" },
  ],
  "email": [
    { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: "Invalid email format", suggestion: "user@example.com" },
  ],
  "ifsc": [
    { pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/, message: "IFSC must be 11 characters", suggestion: "First 4 letters + 0 + 6 alphanumeric" },
  ],
  "account": [
    { pattern: /^\d{9,18}$/, message: "Account number must be 9-18 digits", suggestion: "Check your bank passbook" },
  ],
  "gst": [
    { pattern: /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/, message: "Invalid GST format", suggestion: "2 digits + 5 letters + 4 digits + 1 letter + Z + 1 char" },
  ],
  "date": [
    { pattern: /^\d{2}[\/-]\d{2}[\/-]\d{4}$/, message: "Date must be DD/MM/YYYY", suggestion: "Use format: 01/01/2000" },
  ],
  "pincode": [
    { pattern: /^\d{6}$/, message: "PIN code must be 6 digits", suggestion: "Check your area PIN code" },
  ],
};

// ── Semantic Category Detection ──────────────────────────────

function detectFieldCategory(
  name: string,
  label: string,
  placeholder: string,
  type: string
): string {
  const combined = `${name} ${label} ${placeholder}`.toLowerCase();

  if (/aadhaar|uid/i.test(combined)) return "aadhaar";
  if (/pan\s*card|pan\s*number/i.test(combined)) return "pan";
  if (/pin\s*code|pincode|postal/i.test(combined)) return "pincode";
  if (/phone|mobile|contact|tele/i.test(combined)) return "phone";
  if (/email|e-mail|mail/i.test(combined)) return "email";
  if (/ifsc/i.test(combined)) return "ifsc";
  if (/account|acc\s*no/i.test(combined)) return "account";
  if (/gst/i.test(combined)) return "gst";
  if (/date|dob|birth/i.test(combined)) return "date";

  return type;
}

// ── Main Validation Function ─────────────────────────────────

export function validateForm(
  fields: { name: string; id: string; label: string; type: string; value: string; placeholder?: string; required?: boolean; maxLength?: number; pattern?: string }[]
): ValidationResult {
  const validations: FieldValidation[] = [];
  const blockingIssues: string[] = [];
  let riskLevel: "low" | "medium" | "high" = "low";

  for (const field of fields) {
    const category = detectFieldCategory(
      field.name,
      field.label,
      field.placeholder || "",
      field.type
    );

    const rules = VALIDATION_RULES[category] || [];

    // Check required
    if (field.required && !field.value.trim()) {
      const v: FieldValidation = {
        fieldName: field.label || field.name || field.id,
        value: field.value,
        valid: false,
        rule: "required",
        message: "This field is required",
      };
      validations.push(v);
      blockingIssues.push(`${v.fieldName}: required but empty`);
      riskLevel = "high";
      continue;
    }

    // Skip empty non-required fields
    if (!field.value.trim()) {
      validations.push({
        fieldName: field.label || field.name || field.id,
        value: "",
        valid: true,
        rule: "optional",
        message: "Optional field, empty is OK",
      });
      continue;
    }

    // Check max length
    if (field.maxLength && field.maxLength > 0 && field.value.length > field.maxLength) {
      const v: FieldValidation = {
        fieldName: field.label || field.name || field.id,
        value: field.value,
        valid: false,
        rule: "maxLength",
        message: `Maximum ${field.maxLength} characters (currently ${field.value.length})`,
        suggestion: `Trim ${field.value.length - field.maxLength} characters`,
      };
      validations.push(v);
      blockingIssues.push(`${v.fieldName}: too long`);
      riskLevel = "high";
      continue;
    }

    // Check custom pattern from field
    if (field.pattern) {
      try {
        const regex = new RegExp(field.pattern);
        if (!regex.test(field.value)) {
          const v: FieldValidation = {
            fieldName: field.label || field.name || field.id,
            value: field.value,
            valid: false,
            rule: "pattern",
            message: `Value doesn't match required format`,
            suggestion: field.pattern,
          };
          validations.push(v);
          blockingIssues.push(`${v.fieldName}: format mismatch`);
          riskLevel = Math.max(riskLevel === "high" ? 2 : riskLevel === "medium" ? 1 : 0, 1) as any;
          continue;
        }
      } catch {
        // Invalid regex, skip
      }
    }

    // Check category-specific rules
    let matched = false;
    for (const rule of rules) {
      if (rule.pattern.test(field.value)) {
        validations.push({
          fieldName: field.label || field.name || field.id,
          value: field.value,
          valid: true,
          rule: category,
          message: `Valid ${category} format`,
        });
        matched = true;
        break;
      }
    }

    if (!matched && rules.length > 0) {
      const rule = rules[0];
      const v: FieldValidation = {
        fieldName: field.label || field.name || field.id,
        value: field.value,
        valid: false,
        rule: category,
        message: rule.message,
        suggestion: rule.suggestion,
      };
      validations.push(v);
      blockingIssues.push(`${v.fieldName}: ${rule.message}`);
      riskLevel = "high";
    } else if (!matched) {
      // No rules for this field type — assume valid
      validations.push({
        fieldName: field.label || field.name || field.id,
        value: field.value,
        valid: true,
        rule: "none",
        message: "No validation rules for this field",
      });
    }
  }

  return {
    allValid: blockingIssues.length === 0,
    fields: validations,
    riskLevel,
    blockingIssues,
  };
}
