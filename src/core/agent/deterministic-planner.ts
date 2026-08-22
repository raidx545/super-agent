// ============================================================
// VLESS — Deterministic Form Planner
// For simple form-filling tasks, no LLM is needed.
// Maps field labels to user data locally using fuzzy matching.
//
// Why this matters:
//   - Works 100% offline (no LLM required)
//   - PII never leaves the device (no server call)
//   - Sub-100ms planning (vs 2-10s for LLM)
//   - Perfect for government forms with standard fields
//
// The planner:
//   1. Scans form fields and their labels
//   2. Matches labels to user data using fuzzy string matching
//   3. Generates a click-then-type plan for each field
//   4. Handles dropdowns, required fields, and skip logic
// ============================================================

import type { PlannedAction } from "../../types";

// ── Types ────────────────────────────────────────────────────

export interface FormFieldInfo {
  index: number;
  label: string;
  name: string;
  id: string;
  type: string;
  required: boolean;
  options?: string[];
  currentValue?: string;
  piiCategory?: string;
}

export interface DeterministicPlan {
  success: boolean;
  steps: PlannedAction[];
  reasoning: string;
  fieldMappings: Array<{
    fieldLabel: string;
    dataSource: string;
    value: string;
    confidence: number;
  }>;
  unmappedFields: string[];
}

// ── Label → Data Mapping ─────────────────────────────────────

/**
 * Known field label patterns mapped to standard data categories.
 * Supports Indian government forms (passport, Aadhaar, PAN, etc.).
 */
const FIELD_PATTERNS: Array<{
  category: string;
  patterns: RegExp[];
  dataSource: string;
}> = [
  // Name fields
  { category: "name", patterns: [/given\s*name/i, /first\s*name/i, /applicant.*name/i], dataSource: "firstName" },
  { category: "name", patterns: [/family\s*name/i, /last\s*name/i, /surname/i], dataSource: "lastName" },
  { category: "name", patterns: [/full\s*name/i, /name\s*as.*passport/i], dataSource: "fullName" },
  { category: "name", patterns: [/father.*name/i], dataSource: "fatherName" },
  { category: "name", patterns: [/mother.*name/i], dataSource: "motherName" },
  { category: "name", patterns: [/husband.*name/i, /spouse.*name/i], dataSource: "spouseName" },

  // Contact
  { category: "email", patterns: [/e?-?mail/i], dataSource: "email" },
  { category: "phone", patterns: [/mobile/i, /phone/i, /cell/i, /contact.*number/i], dataSource: "phone" },

  // Identity
  { category: "aadhaar", patterns: [/aadhaar/i, /aadhar/i, /uid/i], dataSource: "aadhaar" },
  { category: "pan", patterns: [/pan\s*card/i, /pan\s*number/i], dataSource: "pan" },
  { category: "dob", patterns: [/date\s*of\s*birth/i, /\bdob\b/i, /birth.*date/i], dataSource: "dob" },
  { category: "gender", patterns: [/gender/i, /\bsex\b/i], dataSource: "gender" },

  // Address
  { category: "address", patterns: [/address/i, /street/i, /road/i, /lane/i], dataSource: "address" },
  { category: "city", patterns: [/city/i, /town/i, /district/i], dataSource: "city" },
  { category: "state", patterns: [/state/i, /province/i], dataSource: "state" },
  { category: "pincode", patterns: [/pin\s*code/i, /pincode/i, /postal.*code/i, /zip/i], dataSource: "pincode" },

  // Financial
  { category: "account", patterns: [/account.*number/i, /a\/c/i], dataSource: "accountNumber" },
  { category: "ifsc", patterns: [/ifsc/i], dataSource: "ifsc" },
  { category: "upi", patterns: [/upi/i, /vpa/i], dataSource: "upiId" },

  // Education
  { category: "education", patterns: [/qualification/i, /degree/i, /education/i], dataSource: "education" },
  { category: "institution", patterns: [/institution/i, /college/i, /university/i, /school/i], dataSource: "institution" },

  // Occupation
  { category: "occupation", patterns: [/occupation/i, /profession/i, /job/i, /designation/i], dataSource: "occupation" },
  { category: "income", patterns: [/income/i, /salary/i, /annual.*income/i], dataSource: "income" },
];

/**
 * Fuzzy match a field label against known patterns.
 * Returns the best matching data source key and confidence.
 */
function matchFieldLabel(
  label: string,
  fieldName: string,
  fieldId: string,
  placeholder: string
): { dataSource: string; confidence: number } | null {
  const combined = `${label} ${fieldName} ${fieldId} ${placeholder}`.toLowerCase();

  let bestMatch: { dataSource: string; confidence: number } | null = null;

  for (const { patterns, dataSource } of FIELD_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(combined)) {
        // Exact match gets 0.95, partial gets lower
        const confidence = label.toLowerCase().includes(combined.split(" ").find((w) => pattern.test(w)) || "")
          ? 0.95
          : 0.85;

        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = { dataSource, confidence };
        }
      }
    }
  }

  return bestMatch;
}

// ── Plan Generation ──────────────────────────────────────────

/**
 * Generate a deterministic action plan for filling a form.
 *
 * @param fields - The form fields detected on the page
 * @param userData - The user's data to fill in (key-value pairs)
 * @returns A plan with click-then-type steps for each field
 */
export function generateDeterministicPlan(
  fields: FormFieldInfo[],
  userData: Record<string, string>
): DeterministicPlan {
  const steps: PlannedAction[] = [];
  const fieldMappings: DeterministicPlan["fieldMappings"] = [];
  const unmappedFields: string[] = [];
  let idx = 0;

  for (const field of fields) {
    // Skip non-fillable fields
    if (field.type === "submit" || field.type === "button" || field.type === "hidden") {
      continue;
    }

    // Skip already-filled fields
    if (field.currentValue && field.currentValue.trim().length > 0) {
      continue;
    }

    // Try to match this field to user data
    const match = matchFieldLabel(field.label, field.name, field.id, "");

    if (match && userData[match.dataSource]) {
      const value = userData[match.dataSource];

      // For dropdowns, try to select the matching option
      if (field.type === "select" && field.options) {
        const matchingOption = field.options.find(
          (opt) => opt.toLowerCase() === value.toLowerCase()
        );
        if (matchingOption) {
          steps.push({
            index: idx++,
            action: {
              id: `det-${idx}`,
              type: "select",
              target: field.id || field.name || `[${field.index}]`,
              value: matchingOption,
              retries: 0,
              maxRetries: 3,
            },
            reasoning: `Select "${matchingOption}" in "${field.label}"`,
            confidence: match.confidence,
            verification: `Field should show "${matchingOption}"`,
            risk: "low",
          });

          fieldMappings.push({
            fieldLabel: field.label,
            dataSource: match.dataSource,
            value: matchingOption,
            confidence: match.confidence,
          });
          continue;
        }
      }

      // For text fields: click to focus, then type
      const target = field.id ? `[${field.index}]` : field.name || `[${field.index}]`;

      // Step 1: Click to focus
      steps.push({
        index: idx++,
        action: {
          id: `det-${idx}`,
          type: "click",
          target,
          retries: 0,
          maxRetries: 3,
        },
        reasoning: `Focus "${field.label}"`,
        confidence: match.confidence,
        verification: `Field should be focused`,
        risk: "low",
      });

      // Step 2: Type value
      steps.push({
        index: idx++,
        action: {
          id: `det-${idx}`,
          type: "type",
          target,
          value,
          retries: 0,
          maxRetries: 3,
        },
        reasoning: `Type in "${field.label}"`,
        confidence: match.confidence,
        verification: `Field should contain value`,
        risk: field.piiCategory ? "high" : "low",
      });

      fieldMappings.push({
        fieldLabel: field.label,
        dataSource: match.dataSource,
        value: field.piiCategory ? `[PII:${field.piiCategory}]` : value.slice(0, 20),
        confidence: match.confidence,
      });
    } else {
      // No match found
      if (field.required) {
        unmappedFields.push(field.label || field.name || field.id);
      }
    }
  }

  return {
    success: steps.length > 0,
    steps,
    reasoning: `Deterministic plan: ${steps.length} steps for ${fields.length} fields. ` +
      `${fieldMappings.length} mapped, ${unmappedFields.length} unmapped.`,
    fieldMappings,
    unmappedFields,
  };
}

/**
 * Check if the current task is suitable for deterministic planning.
 * Returns true for simple form-filling tasks without complex navigation.
 */
export function isDeterministicEligible(
  taskDescription: string,
  formFieldCount: number
): boolean {
  const lower = taskDescription.toLowerCase();

  // Eligible: simple form fill/complete/submit tasks
  const formKeywords = ["fill", "complete", "submit", "apply", "form"];
  const hasFormKeyword = formKeywords.some((k) => lower.includes(k));

  // Not eligible: tasks requiring navigation, search, or complex reasoning
  const complexKeywords = ["search", "find", "navigate", "open", "go to", "compare", "analyze"];
  const hasComplexKeyword = complexKeywords.some((k) => lower.includes(k));

  return hasFormKeyword && !hasComplexKeyword && formFieldCount > 0;
}
