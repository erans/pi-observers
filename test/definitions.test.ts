import { describe, expect, it } from "vitest";
import { ObserverDefinitionError, parseObserverDefinition } from "../src/definitions.ts";

const VALID = `---
name: goal-tracker
description: Hold the agent to a declared goal
on: agent_settled
sees: [last_user_message, transcript]
tools: [read, grep]
can: [advise, veto]
deliver: settle
model: lunaroute/deepseek-v4-flash
fallback: [anthropic/claude-haiku-4-5]
thinking: low
priority: 80
max_advisory_chars: 250
timeout_ms: 15000
---
Watch the goal.
`;

function parse(src: string) {
  return parseObserverDefinition(src, "/o/goal-tracker.md", "project");
}

describe("parseObserverDefinition", () => {
  it("parses a full definition", () => {
    const d = parse(VALID);
    expect(d.name).toBe("goal-tracker");
    expect(d.on).toBe("agent_settled");
    expect(d.sees).toEqual(["last_user_message", "transcript"]);
    expect(d.tools).toEqual(["read", "grep"]);
    expect(d.can).toEqual(["advise", "veto"]);
    expect(d.deliver).toBe("settle");
    expect(d.model).toBe("lunaroute/deepseek-v4-flash");
    expect(d.fallback).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(d.priority).toBe(80);
    expect(d.maxAdvisoryChars).toBe(250);
    expect(d.timeoutMs).toBe(15000);
    expect(d.systemPrompt.trim()).toBe("Watch the goal.");
    expect(d.scope).toBe("project");
    expect(d.sourcePath).toBe("/o/goal-tracker.md");
  });

  it("applies defaults for omitted optional fields", () => {
    const d = parse(`---
name: minimal
description: A minimal observer
on: turn_end
---
Body.
`);
    expect(d.enabled).toBe(true);
    expect(d.sees).toEqual([]);
    expect(d.tools).toEqual([]);
    expect(d.can).toEqual(["advise"]);
    expect(d.deliver).toBe("next_prompt");
    expect(d.thinking).toBe("low");
    expect(d.priority).toBe(50);
    expect(d.maxAdvisoryChars).toBe(300);
    expect(d.timeoutMs).toBe(20000);
    expect(d.model).toBeUndefined();
    expect(d.fallback).toEqual([]);
  });

  it.each([
    ["missing name", `---\ndescription: d\non: turn_end\n---\nb`, "name"],
    ["missing description", `---\nname: n\non: turn_end\n---\nb`, "description"],
    ["missing on", `---\nname: n\ndescription: d\n---\nb`, "on"],
    ["bad trigger", `---\nname: n\ndescription: d\non: nope\n---\nb`, "on"],
    ["bad slice", `---\nname: n\ndescription: d\non: turn_end\nsees: [nope]\n---\nb`, "sees"],
    ["bad deliver", `---\nname: n\ndescription: d\non: turn_end\ndeliver: nope\n---\nb`, "deliver"],
    ["bad capability", `---\nname: n\ndescription: d\non: turn_end\ncan: [destroy]\n---\nb`, "can"],
    ["unknown field", `---\nname: n\ndescription: d\non: turn_end\nwibble: 1\n---\nb`, "wibble"],
    ["empty body", `---\nname: n\ndescription: d\non: turn_end\n---\n   \n`, "systemPrompt"],
  ])("rejects %s", (_label, src, field) => {
    expect(() => parse(src)).toThrow(ObserverDefinitionError);
    try {
      parse(src);
    } catch (e) {
      expect((e as ObserverDefinitionError).field).toBe(field);
      expect((e as ObserverDefinitionError).file).toBe("/o/goal-tracker.md");
    }
  });

  it.each(["write", "edit", "bash"])("rejects the mutating tool %s", (tool) => {
    const src = `---\nname: n\ndescription: d\non: turn_end\ntools: [read, ${tool}]\n---\nb`;
    expect(() => parse(src)).toThrow(/not a permitted observer tool/);
  });

  it("rejects a non-positive timeout", () => {
    const src = `---\nname: n\ndescription: d\non: turn_end\ntimeout_ms: 0\n---\nb`;
    expect(() => parse(src)).toThrow(/timeout_ms/);
  });
});
