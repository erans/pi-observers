import { describe, expect, it } from "vitest";
import { createOutputTools } from "../src/outputs.ts";
import type { ObserverDefinition } from "../src/types.ts";

function defOf(over: Partial<ObserverDefinition> = {}): ObserverDefinition {
  return {
    name: "o", description: "d", enabled: true, on: "turn_end", sees: [], tools: [],
    can: ["advise"], deliver: "next_prompt", fallback: [], thinking: "low", priority: 70,
    maxAdvisoryChars: 20, timeoutMs: 20000, systemPrompt: "b", sourcePath: "/o.md",
    scope: "builtin", ...over,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test harness for the tool execute signature
const call = (tool: any, params: unknown) => tool.execute("id", params, undefined, undefined, {} as any);

describe("createOutputTools", () => {
  it("registers only propose when can is [advise]", () => {
    const { tools } = createOutputTools(defOf({ can: ["advise"] }));
    expect(tools.map((t) => t.name)).toEqual(["propose"]);
  });

  it("registers veto only when can includes it", () => {
    const { tools } = createOutputTools(defOf({ can: ["advise", "veto"] }));
    expect(tools.map((t) => t.name).sort()).toEqual(["propose", "veto"]);
  });

  it("collects a proposal carrying the observer's name, priority and deliver", async () => {
    const { tools, collector } = createOutputTools(defOf({ deliver: "settle", priority: 70 }));
    await call(tools[0], { advisory: "check the tests", fingerprint: "fp1" });
    expect(collector.take()).toEqual({
      observer: "o", kind: "advisory", text: "check the tests",
      fingerprint: "fp1", priority: 70, deliver: "settle",
    });
  });

  it("returns null when nothing was proposed", () => {
    const { collector } = createOutputTools(defOf());
    expect(collector.take()).toBeNull();
  });

  it("throws when the advisory exceeds max_advisory_chars", async () => {
    const { tools } = createOutputTools(defOf({ maxAdvisoryChars: 10 }));
    await expect(call(tools[0], { advisory: "x".repeat(11), fingerprint: "fp" })).rejects.toThrow(
      /exceeds max_advisory_chars/,
    );
  });

  it("ignores a second call and records a warning", async () => {
    const { tools, collector } = createOutputTools(defOf());
    await call(tools[0], { advisory: "first", fingerprint: "a" });
    await call(tools[0], { advisory: "second", fingerprint: "b" });
    expect(collector.take()?.text).toBe("first");
    expect(collector.warnings.join()).toMatch(/already proposed/);
  });

  it("marks a veto with kind veto", async () => {
    const { tools, collector } = createOutputTools(defOf({ can: ["veto"] }));
    const veto = tools.find((t) => t.name === "veto");
    await call(veto, { reason: "tests not run", fingerprint: "g1" });
    expect(collector.take()).toMatchObject({ kind: "veto", text: "tests not run" });
  });

  // Exploratory tests
  describe("edge cases", () => {
    it("registers no tools when can is an empty array", () => {
      const { tools } = createOutputTools(defOf({ can: [] }));
      expect(tools).toHaveLength(0);
    });

    it("accepts advisory exactly at max_advisory_chars", async () => {
      const text = "a".repeat(20); // exactly 20 chars
      const { tools, collector } = createOutputTools(defOf({ maxAdvisoryChars: 20 }));
      await call(tools[0], { advisory: text, fingerprint: "fp" });
      expect(collector.take()?.text).toBe(text);
    });

    it("throws when advisory is one char over max_advisory_chars", async () => {
      const text = "a".repeat(21); // 21 chars, but limit is 20
      const { tools } = createOutputTools(defOf({ maxAdvisoryChars: 20 }));
      await expect(call(tools[0], { advisory: text, fingerprint: "fp" })).rejects.toThrow(
        /exceeds max_advisory_chars/,
      );
    });

    it("allows veto to be emitted by observer with veto capability but not advise", async () => {
      const { tools, collector } = createOutputTools(defOf({ can: ["veto"] }));
      expect(tools).toHaveLength(1);
      const vetoTool = tools[0]!;
      expect(vetoTool.name).toBe("veto");
      await call(vetoTool, { reason: "incomplete", fingerprint: "v1" });
      const proposal = collector.take();
      expect(proposal).toMatchObject({ kind: "veto", text: "incomplete" });
    });

    it("observer with only veto capability has no propose tool", () => {
      const { tools } = createOutputTools(defOf({ can: ["veto"] }));
      const proposeTool = tools.find((t) => t.name === "propose");
      expect(proposeTool).toBeUndefined();
    });

    it("veto also respects max_advisory_chars", async () => {
      const { tools } = createOutputTools(defOf({ can: ["veto"], maxAdvisoryChars: 5 }));
      const vetoTool = tools[0];
      await expect(
        call(vetoTool, { reason: "toolong", fingerprint: "v1" })
      ).rejects.toThrow(/exceeds max_advisory_chars/);
    });
  });
});
