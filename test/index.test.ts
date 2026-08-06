import { describe, expect, it } from "vitest";
import { formatAdvisories } from "../src/index.ts";
import type { Proposal } from "../src/types.ts";

const p = (observer: string, text: string): Proposal => ({
  observer,
  kind: "advisory",
  text,
  fingerprint: `${observer}-1`,
  priority: 50,
  deliver: "next_prompt",
});

describe("formatAdvisories", () => {
  it("labels each advisory with its observer", () => {
    const out = formatAdvisories([p("memory-recall", "see note X")]);
    expect(out).toContain("memory-recall");
    expect(out).toContain("see note X");
  });

  it("puts each advisory on its own line", () => {
    const out = formatAdvisories([p("a", "one"), p("b", "two")]);
    expect(out.split("\n").filter((l) => l.trim() !== "").length).toBeGreaterThanOrEqual(2);
  });

  it("marks the block as advisory, not instruction", () => {
    expect(formatAdvisories([p("a", "one")])).toMatch(/advisor/i);
  });
});
