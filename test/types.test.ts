import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, DEFAULTS, isAllowedTool } from "../src/types.ts";

describe("types", () => {
  it("allows exactly the four read-only tools", () => {
    expect([...ALLOWED_TOOLS]).toEqual(["read", "grep", "find", "ls"]);
  });

  it("rejects mutating tools", () => {
    expect(isAllowedTool("read")).toBe(true);
    expect(isAllowedTool("write")).toBe(false);
    expect(isAllowedTool("edit")).toBe(false);
    expect(isAllowedTool("bash")).toBe(false);
  });

  it("carries the spec's default values", () => {
    expect(DEFAULTS.priority).toBe(50);
    expect(DEFAULTS.maxAdvisoryChars).toBe(300);
    expect(DEFAULTS.timeoutMs).toBe(20000);
    expect(DEFAULTS.maxAdvisoriesPerTurn).toBe(2);
    expect(DEFAULTS.vetoBudget).toBe(3);
  });
});
