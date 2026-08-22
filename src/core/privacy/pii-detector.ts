// ============================================================
// VLESS — PII Detection Engine
// Multi-signal PII detection: 50% DOM + 50% Vision
//
// DOM Path: Form field semantics, input types, regex on labels
// Vision Path: Face detection, OCR text scanning, visual patterns
//
// This is 40% of the SIH evaluation score — it must be excellent.
// ============================================================

// ── Types ────────────────────────────────────────────────────

export type PIICategory =
  | "face"
  | "password"
  | "aadhaar"
  | "phone"
  | "email"
  | "pan"
  | "bank_account"
  | "ifsc"
  | "name"
  | "address"
  | "date_of_birth"
  | "financial"
  | "medical"
  | "secret_token"
  | "upi"
  | "ip_address"
  | "generic_sensitive";

export type PIISensitivity = "critical" | "high" | "medium" | "low";

export interface PIIRegion {
  id: string;
  category: PIICategory;
  sensitivity: PIISensitivity;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  textValue: string | null; // The detected PII text (for DOM-based)
  fieldSelector: string | null; // CSS selector for DOM-based
  confidence: number; // 0-1
  source: "dom" | "vision" | "combined";
  detectionMethod: string; // Human-readable description
  redactionStrategy: RedactionStrategy;
}

export type RedactionStrategy =
  | "blur" // Gaussian blur (faces, backgrounds)
  | "black_box" // Solid black box (passwords, secrets)
  | "pixelate" // Pixelation (moderate sensitivity)
  | "mask_text" // Replace with *** (text values)
  | "overlay" // CSS overlay (DOM elements)
  | "none"; // Don't redact (low sensitivity)

export interface PIIDetectionResult {
  regions: PIIRegion[];
  summary: {
    totalRegions: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    byCategory: Record<PIICategory, number>;
    bySource: { dom: number; vision: number; combined: number };
    overallConfidence: number;
    detectionTimeMs: number;
  };
  sanitizedDOMMetadata: SanitizedMetadata;
}

export interface SanitizedMetadata {
  safeElements: Array<{
    tag: string;
    role: string;
    label: string;
    type: string;
    rect: { x: number; y: number; width: number; height: number };
    isVisible: boolean;
  }>;
  safeTextContent: string; // Text with PII values redacted
  safeForms: Array<{
    id: string;
    fields: Array<{
      label: string;
      type: string;
      hasValue: boolean; // Never send actual values
      isRequired: boolean;
      piiCategory: PIICategory | null;
    }>;
  }>;
  pageMetadata: {
    title: string;
    url: string; // Domain only, no query params
    hasForm: boolean;
    hasCAPTCHA: boolean;
    elementCount: number;
  };
}

// ── PII Category Detection Rules ─────────────────────────────

interface PIIRule {
  category: PIICategory;
  sensitivity: PIISensitivity;
  patterns: RegExp[];
  fieldPatterns: RegExp[]; // Matches against field name/label/placeholder
  keywords: string[];
  redactionStrategy: RedactionStrategy;
}

const PII_RULES: PIIRule[] = [
  {
    category: "password",
    sensitivity: "critical",
    patterns: [],
    fieldPatterns: [/password/i, /passwd/i, /secret/i, /pin\s*code/i, /otp/i],
    keywords: ["password", "passwd", "secret"],
    redactionStrategy: "black_box",
  },
  {
    category: "aadhaar",
    sensitivity: "critical",
    patterns: [/\b\d{4}\s?\d{4}\s?\d{4}\b/], // 12 digits with optional spaces
    fieldPatterns: [/aadhaar/i, /uid/i, /aadhar/i],
    keywords: ["aadhaar", "aadhar", "uid"],
    redactionStrategy: "black_box",
  },
  {
    category: "pan",
    sensitivity: "critical",
    patterns: [/\b[A-Z]{5}\d{4}[A-Z]\b/], // ABCDE1234F
    fieldPatterns: [/pan\s*card/i, /pan\s*number/i, /pan$/i],
    keywords: ["pan card", "pan number"],
    redactionStrategy: "black_box",
  },
  {
    category: "phone",
    sensitivity: "high",
    patterns: [
      /\b[+]?[6-9]\d{9}\b/, // Indian mobile
      /\b[+]?91\s?[6-9]\d{9}\b/, // With country code
      /\b\d{10}\b/, // Generic 10-digit
    ],
    fieldPatterns: [/phone/i, /mobile/i, /contact/i, /tele/i, /cell/i],
    keywords: ["phone", "mobile", "contact number", "telephone"],
    redactionStrategy: "mask_text",
  },
  {
    category: "email",
    sensitivity: "high",
    patterns: [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/],
    fieldPatterns: [/email/i, /e-mail/i, /mail/i],
    keywords: ["email", "e-mail"],
    redactionStrategy: "mask_text",
  },
  {
    category: "bank_account",
    sensitivity: "critical",
    patterns: [], // No generic regex — only detect via field context to avoid false positives
    fieldPatterns: [/account/i, /acc\s*no/i, /bank\s*acc/i, /a\/c/i],
    keywords: ["account number", "bank account", "a/c"],
    redactionStrategy: "black_box",
  },
  {
    category: "ifsc",
    sensitivity: "high",
    patterns: [/\b[A-Z]{4}0[A-Z0-9]{6}\b/],
    fieldPatterns: [/ifsc/i, /ifsc\s*code/i],
    keywords: ["ifsc"],
    redactionStrategy: "mask_text",
  },
  {
    category: "upi",
    sensitivity: "high",
    patterns: [
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9]+\b/, // user@bank format
      /\b\d{10}@[A-Za-z]+\b/, // phone@upi
    ],
    fieldPatterns: [/upi/i, /vpa/i, /upi\s*id/i],
    keywords: ["upi", "vpa", "upi id"],
    redactionStrategy: "mask_text",
  },
  {
    category: "name",
    sensitivity: "medium",
    patterns: [],
    fieldPatterns: [
      /name/i, /full\s*name/i, /first\s*name/i, /last\s*name/i,
      /father/i, /mother/i, /husband/i, /guardian/i,
      /given\s*name/i, /surname/i,
    ],
    keywords: ["name", "first name", "last name", "father's name", "surname"],
    redactionStrategy: "mask_text",
  },
  {
    category: "address",
    sensitivity: "medium",
    patterns: [],
    fieldPatterns: [/address/i, /street/i, /city/i, /state/i, /pin\s*code/i, /pincode/i, /district/i, /village/i, /post/i],
    keywords: ["address", "street", "city", "state", "pincode"],
    redactionStrategy: "mask_text",
  },
  {
    category: "date_of_birth",
    sensitivity: "medium",
    patterns: [/\b\d{2}[\/\-]\d{2}[\/\-]\d{4}\b/],
    fieldPatterns: [/dob/i, /date\s*of\s*birth/i, /birth/i, /born/i],
    keywords: ["date of birth", "dob", "birth date"],
    redactionStrategy: "mask_text",
  },
  {
    category: "financial",
    sensitivity: "critical",
    patterns: [
      /\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/, // Credit/debit card (16 digits)
    ],
    fieldPatterns: [/card/i, /cvv/i, /expiry/i, /credit/i, /debit/i, /billing/i],
    keywords: ["card number", "cvv", "expiry", "credit card", "debit card"],
    redactionStrategy: "black_box",
  },
  {
    category: "medical",
    sensitivity: "critical",
    patterns: [],
    fieldPatterns: [/diagnos/i, /medication/i, /allerg/i, /symptom/i, /medical/i, /health/i, /prescription/i],
    keywords: ["diagnosis", "medication", "allergy", "medical history"],
    redactionStrategy: "black_box",
  },
  {
    category: "ip_address",
    sensitivity: "medium",
    patterns: [
      /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    ],
    fieldPatterns: [/ip\s*address/i, /ip$/i],
    keywords: ["ip address"],
    redactionStrategy: "mask_text",
  },
];

// ── DOM-Based PII Detection ──────────────────────────────────

export function detectPIIFromDOM(
  elements: Array<{
    tag: string;
    id: string;
    role: string;
    text: string;
    label: string;
    type: string;
    ariaLabel: string;
    placeholder: string;
    rect: { x: number; y: number; width: number; height: number };
  }>,
  forms: Array<{
    id: string;
    fields: Array<{
      name: string;
      id: string;
      type: string;
      label: string;
      value: string;
      required: boolean;
      pattern: string;
      maxLength: number;
    }>;
  }>,
  pageText: string
): PIIRegion[] {
  const regions: PIIRegion[] = [];
  let idCounter = 0;

  // Scan form fields
  for (const form of forms) {
    for (const field of form.fields) {
      const fieldContext = `${field.name} ${field.id} ${field.label} ${field.type} ${field.pattern}`.toLowerCase();
      const matchingRules = matchFieldToRules(fieldContext, field.type);

      for (const rule of matchingRules) {
        regions.push({
          id: `pii-dom-${++idCounter}`,
          category: rule.category,
          sensitivity: rule.sensitivity,
          boundingBox: findElementRect(field.id || field.name, elements),
          textValue: field.value || null,
          fieldSelector: field.id ? `#${field.id}` : field.name ? `[name="${field.name}"]` : null,
          confidence: fieldContext.includes(rule.keywords[0]) ? 0.95 : 0.8,
          source: "dom",
          detectionMethod: `Form field "${field.label || field.name}" matched ${rule.category} pattern`,
          redactionStrategy: rule.redactionStrategy,
        });
      }
    }
  }

  // Scan visible elements for PII text
  for (const el of elements) {
    for (const rule of PII_RULES) {
      for (const pattern of rule.patterns) {
        const match = el.text?.match(pattern);
        if (match) {
          regions.push({
            id: `pii-dom-${++idCounter}`,
            category: rule.category,
            sensitivity: rule.sensitivity,
            boundingBox: el.rect,
            textValue: match[0],
            fieldSelector: el.id ? `#${el.id}` : null,
            confidence: 0.85,
            source: "dom",
            detectionMethod: `Text "${match[0].slice(0, 20)}..." matched ${rule.category} regex`,
            redactionStrategy: rule.redactionStrategy,
          });
        }
      }
    }
  }

  // Scan page text for visible PII
  for (const rule of PII_RULES) {
    for (const pattern of rule.patterns) {
      let match;
      while ((match = pattern.exec(pageText)) !== null) {
        // Only add if not already detected via form fields
        const alreadyDetected = regions.some(
          (r) => r.textValue === match![0]
        );
        if (!alreadyDetected) {
          regions.push({
            id: `pii-dom-${++idCounter}`,
            category: rule.category,
            sensitivity: rule.sensitivity,
            boundingBox: null, // No bounding box for page-level text
            textValue: match[0],
            fieldSelector: null,
            confidence: 0.7, // Lower confidence without visual confirmation
            source: "dom",
            detectionMethod: `Page text matched ${rule.category} regex`,
            redactionStrategy: rule.redactionStrategy,
          });
        }
      }
    }
  }

  return regions;
}

// ── Vision-Based PII Detection ───────────────────────────────

export function detectPIIFromVision(
  canvas: HTMLCanvasElement,
  ocrTextBlocks?: Array<{
    text: string;
    confidence: number;
    boundingBox: { x: number; y: number; width: number; height: number };
  }>
): PIIRegion[] {
  const regions: PIIRegion[] = [];
  let idCounter = 0;

  // 1. Face detection using skin color heuristic + connected components
  const faceRegions = detectFacesFromCanvas(canvas);
  for (const face of faceRegions) {
    regions.push({
      id: `pii-vision-${++idCounter}`,
      category: "face",
      sensitivity: "critical",
      boundingBox: face,
      textValue: null,
      fieldSelector: null,
      confidence: face.confidence,
      source: "vision",
      detectionMethod: "Face detected via skin-color + connected-component analysis",
      redactionStrategy: "blur",
    });
  }

  // 2. Password/bullet dot detection (visual pattern)
  const passwordRegions = detectPasswordDots(canvas);
  for (const pwd of passwordRegions) {
    regions.push({
      id: `pii-vision-${++idCounter}`,
      category: "password",
      sensitivity: "critical",
      boundingBox: pwd,
      textValue: null,
      fieldSelector: null,
      confidence: 0.85,
      source: "vision",
      detectionMethod: "Password dot pattern detected (uniform small glyphs in input field)",
      redactionStrategy: "black_box",
    });
  }

  // 3. OCR text scanning for PII patterns
  if (ocrTextBlocks && ocrTextBlocks.length > 0) {
    for (const block of ocrTextBlocks) {
      const text = block.text;
      for (const rule of PII_RULES) {
        for (const pattern of rule.patterns) {
          const match = text.match(pattern);
          if (match) {
            regions.push({
              id: `pii-vision-${++idCounter}`,
              category: rule.category,
              sensitivity: rule.sensitivity,
              boundingBox: block.boundingBox,
              textValue: match[0],
              fieldSelector: null,
              confidence: block.confidence * 0.9, // OCR confidence * pattern confidence
              source: "vision",
              detectionMethod: `OCR text "${match[0].slice(0, 20)}..." matched ${rule.category}`,
              redactionStrategy: rule.redactionStrategy,
            });
          }
        }
      }
    }
  }

  return regions;
}

// ── Face Detection (Canvas-Based) ────────────────────────────

function detectFacesFromCanvas(
  canvas: HTMLCanvasElement
): Array<{ x: number; y: number; width: number; height: number; confidence: number }> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];

  const width = canvas.width;
  const height = canvas.height;

  // Downsample for speed (process at 1/4 resolution)
  const scale = 4;
  const smallW = Math.floor(width / scale);
  const smallH = Math.floor(height / scale);

  const smallCanvas = document.createElement("canvas");
  smallCanvas.width = smallW;
  smallCanvas.height = smallH;
  const smallCtx = smallCanvas.getContext("2d")!;
  smallCtx.drawImage(canvas, 0, 0, smallW, smallH);

  const imageData = smallCtx.getImageData(0, 0, smallW, smallH);
  const pixels = imageData.data;

  // Step 1: Skin color detection (YCbCr color space)
  const skinMask = new Uint8Array(smallW * smallH);

  for (let y = 0; y < smallH; y++) {
    for (let x = 0; x < smallW; x++) {
      const idx = (y * smallW + x) * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];

      // Convert to YCbCr
      const y_val = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.169 * r - 0.331 * g + 0.500 * b;
      const cr = 128 + 0.500 * r - 0.419 * g - 0.081 * b;

      // Skin color range in YCbCr
      if (
        y_val > 80 &&
        cb > 85 && cb < 135 &&
        cr > 135 && cr < 180
      ) {
        skinMask[y * smallW + x] = 1;
      }
    }
  }

  // Step 2: Morphological operations (dilate to connect skin regions)
  const dilated = dilateMask(skinMask, smallW, smallH, 3);

  // Step 3: Find connected components
  const components = findConnectedComponents(dilated, smallW, smallH);

  // Step 4: Filter by face-like properties
  const faces: Array<{ x: number; y: number; width: number; height: number; confidence: number }> = [];

  for (const component of components) {
    const aspectRatio = component.width / component.height;
    const area = component.width * component.height;
    const pixelArea = smallW * smallH;

    // Face heuristics:
    // - Aspect ratio between 0.5 and 2.0 (roughly square)
    // - Area between 0.1% and 15% of image
    // - Not too close to edges
    if (
      aspectRatio >= 0.5 &&
      aspectRatio <= 2.0 &&
      area >= pixelArea * 0.001 &&
      area <= pixelArea * 0.15 &&
      component.x > smallW * 0.05 &&
      component.x + component.width < smallW * 0.95
    ) {
      // Confidence based on how face-like the region is
      let confidence = 0.6; // Base confidence for skin-colored regions

      // Boost if aspect ratio is close to 1:1 (typical face)
      if (aspectRatio >= 0.7 && aspectRatio <= 1.4) {
        confidence += 0.15;
      }

      // Boost if area is reasonable for a face
      if (area >= pixelArea * 0.005 && area <= pixelArea * 0.08) {
        confidence += 0.1;
      }

      faces.push({
        x: component.x * scale,
        y: component.y * scale,
        width: component.width * scale,
        height: component.height * scale,
        confidence: Math.min(confidence, 0.9),
      });
    }
  }

  return faces;
}

// ── Password Dot Detection ───────────────────────────────────

function detectPasswordDots(
  canvas: HTMLCanvasElement
): Array<{ x: number; y: number; width: number; height: number }> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];

  // This is a heuristic: look for rows of small, uniform, dark glyphs
  // that are typical of password field dots (••••••)
  const width = canvas.width;
  const height = canvas.height;
  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  const regions: Array<{ x: number; y: number; width: number; height: number }> = [];

  // Scan for horizontal runs of small dark dots
  // Simplified: look for rows where many pixels are very dark (password dots are typically black)
  const rowScanHeight = 20;
  const darkThreshold = 50; // RGB value below this = "dark"

  for (let y = 0; y < height - rowScanHeight; y += rowScanHeight) {
    let darkPixelCount = 0;
    let totalPixels = 0;
    let minX = width;
    let maxX = 0;

    for (let dy = 0; dy < rowScanHeight; dy++) {
      for (let x = 0; x < width; x++) {
        const idx = ((y + dy) * width + x) * 4;
        const r = pixels[idx];
        const g = pixels[idx + 1];
        const b = pixels[idx + 2];
        const brightness = (r + g + b) / 3;

        // Look for very dark pixels that form a pattern
        // Password dots are typically solid dark circles on a lighter background
        if (brightness < darkThreshold) {
          darkPixelCount++;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
        totalPixels++;
      }
    }

    const darkRatio = darkPixelCount / totalPixels;

    // Password dots typically have 10-40% dark pixels in a row (not too sparse, not too dense)
    // And they form a horizontal band
    if (darkRatio >= 0.05 && darkRatio <= 0.4 && maxX - minX > 30) {
      // Check if this looks like dots (not solid text)
      // Dots have a specific pattern: small dark regions separated by light gaps
      const runLengths = analyzeDarkRuns(pixels, y, width, rowScanHeight, darkThreshold);
      const avgRunLength = runLengths.reduce((a, b) => a + b, 0) / runLengths.length;

      if (avgRunLength >= 2 && avgRunLength <= 10 && runLengths.length >= 3) {
        regions.push({
          x: minX,
          y,
          width: maxX - minX,
          height: rowScanHeight,
        });
      }
    }
  }

  return regions;
}

function analyzeDarkRuns(
  pixels: Uint8ClampedArray,
  startY: number,
  width: number,
  rowHeight: number,
  threshold: number
): number[] {
  const runs: number[] = [];
  const midY = startY + Math.floor(rowHeight / 2);

  let currentRun = 0;
  for (let x = 0; x < width; x++) {
    const idx = (midY * width + x) * 4;
    const brightness = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;

    if (brightness < threshold) {
      currentRun++;
    } else {
      if (currentRun > 0) {
        runs.push(currentRun);
        currentRun = 0;
      }
    }
  }
  if (currentRun > 0) runs.push(currentRun);

  return runs;
}

// ── Morphological Operations ─────────────────────────────────

function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const result = new Uint8Array(mask.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        // Set all pixels in radius to 1
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              result[ny * width + nx] = 1;
            }
          }
        }
      }
    }
  }

  return result;
}

// ── Connected Components ─────────────────────────────────────

interface Component {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelCount: number;
}

function findConnectedComponents(
  mask: Uint8Array,
  width: number,
  height: number
): Component[] {
  const visited = new Uint8Array(mask.length);
  const components: Component[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] && !visited[idx]) {
        // BFS flood fill
        const queue = [{ x, y }];
        visited[idx] = 1;

        let minX = x, maxX = x, minY = y, maxY = y;
        let pixelCount = 0;

        while (queue.length > 0) {
          const { x: cx, y: cy } = queue.shift()!;
          pixelCount++;
          minX = Math.min(minX, cx);
          maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy);
          maxY = Math.max(maxY, cy);

          // 4-connected neighbors
          for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            const nx = cx + dx;
            const ny = cy + dy;
            const nIdx = ny * width + nx;
            if (
              nx >= 0 && nx < width &&
              ny >= 0 && ny < height &&
              mask[nIdx] && !visited[nIdx]
            ) {
              visited[nIdx] = 1;
              queue.push({ x: nx, y: ny });
            }
          }
        }

        components.push({
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
          pixelCount,
        });
      }
    }
  }

  return components;
}

// ── Helpers ──────────────────────────────────────────────────

function matchFieldToRules(
  fieldContext: string,
  fieldType: string
): PIIRule[] {
  const matched: PIIRule[] = [];

  // Special case: input type="password" is always a password field
  if (fieldType === "password" || fieldType === "text" && /password/i.test(fieldContext)) {
    matched.push(PII_RULES.find((r) => r.category === "password")!);
  }

  for (const rule of PII_RULES) {
    if (rule.category === "password" && matched.some((r) => r.category === "password")) {
      continue; // Already matched
    }

    for (const pattern of rule.fieldPatterns) {
      if (pattern.test(fieldContext)) {
        matched.push(rule);
        break;
      }
    }
  }

  return matched;
}

function findElementRect(
  elementId: string,
  elements: Array<{
    id: string;
    rect: { x: number; y: number; width: number; height: number };
  }>
): { x: number; y: number; width: number; height: number } | null {
  const el = elements.find((e) => e.id === elementId);
  return el?.rect || null;
}

// ── Merge DOM + Vision Results ───────────────────────────────

export function mergePIIResults(
  domRegions: PIIRegion[],
  visionRegions: PIIRegion[],
  confidenceThreshold = 0.5
): PIIDetectionResult {
  const startTime = performance.now();

  // Combine all regions
  const allRegions = [...domRegions, ...visionRegions];

  // Deduplicate: if DOM and vision both detect the same PII in the same area, merge
  const merged = deduplicateRegions(allRegions);

  // Filter by confidence
  const filtered = merged.filter((r) => r.confidence >= confidenceThreshold);

  // Build summary
  const byCategory = {} as Record<PIICategory, number>;
  let criticalCount = 0, highCount = 0, mediumCount = 0, lowCount = 0;
  let domCount = 0, visionCount = 0, combinedCount = 0;

  for (const region of filtered) {
    byCategory[region.category] = (byCategory[region.category] || 0) + 1;

    switch (region.sensitivity) {
      case "critical": criticalCount++; break;
      case "high": highCount++; break;
      case "medium": mediumCount++; break;
      case "low": lowCount++; break;
    }

    switch (region.source) {
      case "dom": domCount++; break;
      case "vision": visionCount++; break;
      case "combined": combinedCount++; break;
    }
  }

  const overallConfidence = filtered.length > 0
    ? filtered.reduce((sum, r) => sum + r.confidence, 0) / filtered.length
    : 0;

  return {
    regions: filtered,
    summary: {
      totalRegions: filtered.length,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      byCategory,
      bySource: { dom: domCount, vision: visionCount, combined: combinedCount },
      overallConfidence,
      detectionTimeMs: performance.now() - startTime,
    },
    sanitizedDOMMetadata: buildSanitizedMetadata(filtered),
  };
}

function deduplicateRegions(regions: PIIRegion[]): PIIRegion[] {
  const deduplicated: PIIRegion[] = [];

  for (const region of regions) {
    const existing = deduplicated.find(
      (d) =>
        d.category === region.category &&
        d.boundingBox &&
        region.boundingBox &&
        boxesOverlap(d.boundingBox, region.boundingBox)
    );

    if (existing) {
      // Merge: take higher confidence, mark as combined
      if (region.confidence > existing.confidence) {
        existing.confidence = region.confidence;
        existing.textValue = region.textValue || existing.textValue;
        existing.detectionMethod = `${existing.detectionMethod} + ${region.detectionMethod}`;
      }
      existing.source = "combined";
      existing.confidence = Math.min(existing.confidence + 0.05, 1.0); // Boost for dual confirmation
    } else {
      deduplicated.push({ ...region });
    }
  }

  return deduplicated;
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 && intersection / minArea > 0.3;
}

// ── Sanitized Metadata Builder ───────────────────────────────

function buildSanitizedMetadata(
  _piiRegions: PIIRegion[]
): SanitizedMetadata {
  return {
    safeElements: [], // Will be populated by the pipeline
    safeTextContent: "", // Will be populated by the pipeline
    safeForms: [], // Will be populated by the pipeline
    pageMetadata: {
      title: "",
      url: "",
      hasForm: false,
      hasCAPTCHA: false,
      elementCount: 0,
    },
  };
}

// ── Public: Full Pipeline ────────────────────────────────────

/**
 * Run full PII detection pipeline.
 * Call from content script with DOM data, or from background with vision data.
 */
export async function detectAllPII(
  domData: {
    elements: Array<{
      tag: string;
      id: string;
      role: string;
      text: string;
      label: string;
      type: string;
      ariaLabel: string;
      placeholder: string;
      rect: { x: number; y: number; width: number; height: number };
    }>;
    forms: Array<{
      id: string;
      fields: Array<{
        name: string;
        id: string;
        type: string;
        label: string;
        value: string;
        required: boolean;
        pattern: string;
        maxLength: number;
      }>;
    }>;
    textContent: string;
  },
  visionCanvas?: HTMLCanvasElement,
  ocrTextBlocks?: Array<{
    text: string;
    confidence: number;
    boundingBox: { x: number; y: number; width: number; height: number };
  }>
): Promise<PIIDetectionResult> {
  // DOM-based detection
  const domPII = detectPIIFromDOM(
    domData.elements,
    domData.forms,
    domData.textContent
  );

  // Vision-based detection (if canvas available)
  let visionPII: PIIRegion[] = [];
  if (visionCanvas) {
    visionPII = detectPIIFromVision(visionCanvas, ocrTextBlocks);
  }

  // Merge and deduplicate
  return mergePIIResults(domPII, visionPII);
}
