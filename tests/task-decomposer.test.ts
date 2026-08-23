import { describe, it, expect } from "vitest";
import {
  decomposeTask,
  isCompoundTask,
  actionDescription,
} from "../src/core/agent/task-decomposer";

describe("decomposeTask — simple requests", () => {
  it("returns one sub-task for a plain action", () => {
    const st = decomposeTask("fill this form");
    expect(st).toHaveLength(1);
    expect(st[0].kind).toBe("action");
  });

  it("returns one sub-task for a plain read", () => {
    const st = decomposeTask("extract all visible data from this page");
    expect(st).toHaveLength(1);
    expect(st[0].kind).toBe("extract");
  });

  it("handles empty input", () => {
    expect(decomposeTask("")).toEqual([]);
    expect(decomposeTask("   ")).toEqual([]);
  });
});

describe("decomposeTask — compound requests", () => {
  it("splits read + action on 'and'", () => {
    const st = decomposeTask("extract the data and fill the form");
    expect(st).toHaveLength(2);
    expect(st[0].kind).toBe("extract");
    expect(st[1].kind).toBe("action");
  });

  it("splits on 'then'", () => {
    const st = decomposeTask("fill the form then submit it");
    expect(st).toHaveLength(2);
    expect(st.every((s) => s.kind === "action")).toBe(true);
  });

  it("splits on a semicolon", () => {
    const st = decomposeTask("extract the data; click submit");
    expect(st).toHaveLength(2);
  });

  it("splits three-part sequences", () => {
    const st = decomposeTask("extract the data then fill the form then click submit");
    expect(st).toHaveLength(3);
  });

  it("preserves order", () => {
    const st = decomposeTask("fill the form and then extract the data");
    expect(st[0].kind).toBe("action");
    expect(st[1].kind).toBe("extract");
  });
});

describe("decomposeTask — 'and' that is not a separator", () => {
  it("keeps a field list as one task", () => {
    // "address" carries no verb, so this must not split.
    const st = decomposeTask("fill the name and address fields");
    expect(st).toHaveLength(1);
  });

  it("keeps a single noun phrase intact", () => {
    const st = decomposeTask("click the terms and conditions checkbox");
    expect(st).toHaveLength(1);
  });
});

describe("dedupe", () => {
  it("collapses repeated extraction clauses", () => {
    // Extraction is page-wide; running it twice yields identical output.
    const st = decomposeTask("extract the data and read this page and click submit");
    expect(st.filter((s) => s.kind === "extract")).toHaveLength(1);
    expect(st.filter((s) => s.kind === "action")).toHaveLength(1);
  });
});

describe("isCompoundTask", () => {
  it("is false for simple requests", () => {
    expect(isCompoundTask("fill this form")).toBe(false);
  });

  it("is true for compound requests", () => {
    expect(isCompoundTask("extract the data and fill the form")).toBe(true);
  });
});

describe("actionDescription", () => {
  it("keeps only action clauses, in order", () => {
    const st = decomposeTask("extract the data then fill the form then click submit");
    const desc = actionDescription(st);
    expect(desc).not.toContain("extract");
    expect(desc).toContain("fill the form");
    expect(desc).toContain("click submit");
    expect(desc.indexOf("fill")).toBeLessThan(desc.indexOf("click"));
  });

  it("is empty when nothing is an action", () => {
    expect(actionDescription(decomposeTask("extract the data"))).toBe("");
  });
});

describe("submit is not fill", () => {
  // Mirrors the intent split in generateRuleBasedPlan. Regression: the rule
  // planner used lower.includes("submit") to trigger the FILL branch, so
  // "submit form" re-entered every field instead of pressing the button.
  const intents = (t: string) => {
    const lower = t.toLowerCase();
    const wantsSubmit = /\b(submit|send|confirm)\b/.test(lower);
    const wantsFill =
      /\b(fill|complete|enter|populate)\b/.test(lower) ||
      (wantsSubmit && /\b(fill|complete|enter)\b/.test(lower));
    return { wantsFill, wantsSubmit };
  };

  it("'submit form' submits and does NOT fill", () => {
    expect(intents("submit form")).toEqual({ wantsFill: false, wantsSubmit: true });
  });

  it("'fill this form' fills and does NOT submit", () => {
    expect(intents("fill this form")).toEqual({ wantsFill: true, wantsSubmit: false });
  });

  it("'fill the form and submit' does both", () => {
    expect(intents("fill the form and submit")).toEqual({ wantsFill: true, wantsSubmit: true });
  });

  it("'complete and send the application' does both", () => {
    expect(intents("complete and send the application")).toEqual({ wantsFill: true, wantsSubmit: true });
  });

  it("does not fire on a word that merely contains a keyword", () => {
    // "resubmitted" must not read as a submit instruction.
    expect(intents("show me the resubmitted entries").wantsSubmit).toBe(false);
  });
});
