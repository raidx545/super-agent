// ============================================================
// VLESS — CTC greedy decode for PP-OCR recognition
//
// PP-OCR recognition heads emit a [T, C] score matrix per strip. The charset
// is built exactly as PaddleOCR does:  ['<blank>'] + dictLines + [' ' if space]
// with the CTC blank at index 0. Decoding is greedy: argmax per timestep, drop
// blanks, collapse runs of the same index (compared against the raw previous
// index, blank included — matching PaddleOCR's is_remove_duplicate).
//
// Confidence is the mean per-step probability over the kept timesteps. The
// score matrix may or may not be softmaxed depending on the export, so we
// detect per row (sum≈1 & in-range ⇒ already probabilities) and only apply a
// numerically-stable softmax when it isn't — never a softmax-of-softmax.
// ============================================================

export interface Charset {
  /** index → token; index 0 is the CTC blank. length === numClasses. */
  chars: string[];
  hasSpace: boolean;
  /** True when the dict line count didn't reconcile with numClasses. */
  mismatch: boolean;
}

const BLANK_INDEX = 0;

/**
 * Parse a PaddleOCR character dictionary the way its Python loader does:
 * one token per line, `\r`/`\n` stripped, and a file-final newline does NOT
 * yield a trailing empty token (Python readlines semantics).
 */
export function parseDictLines(dictText: string): string[] {
  const lines = dictText.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * Build the decode charset from a dict and the model's class count.
 * charset = ['<blank>'] + dictLines + (space if numClasses leaves room).
 * Always returns an array of length `numClasses` so argmax indices align.
 */
export function buildCharset(dictText: string, numClasses: number): Charset {
  const lines = parseDictLines(dictText);
  const chars: string[] = ["<blank>", ...lines];
  const extra = numClasses - chars.length; // classes beyond blank + dict
  let hasSpace = false;
  let mismatch = false;

  if (extra === 1) {
    chars.push(" "); // use_space_char (the PP-OCR default)
    hasSpace = true;
  } else if (extra === 0) {
    // no space char in this model
  } else if (extra > 1) {
    // Dict shorter than the head expects: keep the conventional space, then
    // pad unknown tail classes with empty tokens so indices stay aligned.
    chars.push(" ");
    hasSpace = true;
    while (chars.length < numClasses) chars.push("");
    mismatch = true;
  } else {
    // Dict longer than the head: truncate to the head width.
    chars.length = numClasses;
    mismatch = true;
  }
  return { chars, hasSpace, mismatch };
}

export interface CtcDecodeResult {
  text: string;
  /** Mean per-step probability over kept timesteps; 0 for empty output. */
  score: number;
}

/**
 * Greedy CTC decode of one strip's score matrix.
 * @param logits Row-major [T, C] scores for a single recognition strip.
 * @param T      Number of timesteps.
 * @param C      Number of classes (=== charset.chars.length).
 */
export function ctcGreedyDecode(
  logits: Float32Array,
  T: number,
  C: number,
  charset: Charset,
): CtcDecodeResult {
  const out: string[] = [];
  let scoreSum = 0;
  let kept = 0;
  let prevIdx = -1;

  for (let t = 0; t < T; t++) {
    const base = t * C;

    // One pass: argmax, value, and row sum (for the normalized-detection test).
    let maxVal = -Infinity;
    let maxIdx = 0;
    let rowSum = 0;
    for (let c = 0; c < C; c++) {
      const v = logits[base + c];
      rowSum += v;
      if (v > maxVal) {
        maxVal = v;
        maxIdx = c;
      }
    }

    const isRepeat = maxIdx === prevIdx;
    prevIdx = maxIdx;
    if (maxIdx === BLANK_INDEX || isRepeat) continue;

    // Probability at the argmax: use directly if the row is already a
    // distribution, else numerically-stable softmax.
    let prob: number;
    if (rowSum > 0.9 && rowSum < 1.1 && maxVal >= 0 && maxVal <= 1.0001) {
      prob = maxVal;
    } else {
      let denom = 0;
      for (let c = 0; c < C; c++) denom += Math.exp(logits[base + c] - maxVal);
      prob = denom > 0 ? 1 / denom : 0;
    }

    const tok = charset.chars[maxIdx];
    if (tok && tok !== "<blank>") out.push(tok);
    scoreSum += prob;
    kept++;
  }

  return { text: out.join(""), score: kept > 0 ? scoreSum / kept : 0 };
}
