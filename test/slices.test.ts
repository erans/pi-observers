import { describe, expect, it } from "vitest";
import { renderSlices } from "../src/slices.ts";

describe("renderSlices", () => {
  it("renders nothing for an empty sees list", () => {
    expect(renderSlices([], { lastUserMessage: "hi" })).toBe("");
  });

  it("renders sections in the order listed, not a fixed order", () => {
    const out = renderSlices(["transcript", "last_user_message"], {
      lastUserMessage: "hello",
      transcript: "T",
    });
    expect(out.indexOf("## transcript")).toBeLessThan(out.indexOf("## last_user_message"));
  });

  it("marks a missing slice unavailable rather than omitting it", () => {
    const out = renderSlices(["last_assistant_message"], {});
    expect(out).toContain("## last_assistant_message");
    expect(out).toContain("(unavailable)");
  });

  it("formats tool calls with name, args and error status", () => {
    const out = renderSlices(["tool_calls_this_turn"], {
      toolCallsThisTurn: [
        { name: "bash", args: "npm test", isError: false },
        { name: "read", args: "src/a.ts", isError: true },
      ],
    });
    expect(out).toContain("bash(npm test) ok");
    expect(out).toContain("read(src/a.ts) ERROR");
  });

  it("says so explicitly when there were no tool calls", () => {
    const out = renderSlices(["tool_calls_this_turn"], { toolCallsThisTurn: [] });
    expect(out).toContain("(no tool calls this turn)");
    expect(out).not.toContain("(unavailable)");
  });

  it("formats skills as name + description", () => {
    const out = renderSlices(["skills"], {
      skills: [{ name: "brainstorming", description: "Explore ideas" }],
    });
    expect(out).toContain("brainstorming: Explore ideas");
  });

  it("says so explicitly when no skills are available", () => {
    const out = renderSlices(["skills"], { skills: [] });
    expect(out).toContain("(no skills available)");
  });
});
