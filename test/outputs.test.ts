import { describe, expect, it } from "vitest";
import { createOutputTools } from "../src/outputs.ts";
import type { ObserverDefinition } from "../src/types.ts";

function defOf(over: Partial<ObserverDefinition> = {}): ObserverDefinition {
  return {
    name: "o",
    description: "d",
    enabled: true,
    on: "turn_end",
    sees: [],
    tools: [],
    can: ["advise"],
    deliver: "next_prompt",
    fallback: [],
    thinking: "low",
    priority: 70,
    maxAdvisoryChars: 20,
    timeoutMs: 20000,
    systemPrompt: "b",
    sourcePath: "/o.md",
    scope: "builtin",
    ...over,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test harness for the tool execute signature
const call = (tool: any, params: unknown) =>
  // biome-ignore lint/suspicious/noExplicitAny: test harness for the tool execute signature
  tool.execute("id", params, undefined, undefined, {} as any);

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
      observer: "o",
      kind: "advisory",
      text: "check the tests",
      fingerprint: "fp1",
      priority: 70,
      deliver: "settle",
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
      // biome-ignore lint/style/noNonNullAssertion: presence just asserted above via toHaveLength(1)
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
      await expect(call(vetoTool, { reason: "toolong", fingerprint: "v1" })).rejects.toThrow(
        /exceeds max_advisory_chars/,
      );
    });

    // Input validation tests
    describe("input validation", () => {
      it("throws when advisory is empty string", async () => {
        const { tools } = createOutputTools(defOf());
        await expect(call(tools[0], { advisory: "", fingerprint: "fp" })).rejects.toThrow(
          /Advisory must be a non-empty string/,
        );
      });

      it("throws when advisory is whitespace-only", async () => {
        const { tools } = createOutputTools(defOf());
        await expect(call(tools[0], { advisory: "   \t\n  ", fingerprint: "fp" })).rejects.toThrow(
          /Advisory must be a non-empty string/,
        );
      });

      it("throws when veto reason is empty string", async () => {
        const { tools } = createOutputTools(defOf({ can: ["veto"] }));
        // biome-ignore lint/style/noNonNullAssertion: defOf({ can: ["veto"] }) guarantees createOutputTools registers a veto tool
        const vetoTool = tools.find((t) => t.name === "veto")!;
        await expect(call(vetoTool, { reason: "", fingerprint: "fp" })).rejects.toThrow(
          /Reason must be a non-empty string/,
        );
      });

      it("throws when veto reason is whitespace-only", async () => {
        const { tools } = createOutputTools(defOf({ can: ["veto"] }));
        // biome-ignore lint/style/noNonNullAssertion: defOf({ can: ["veto"] }) guarantees createOutputTools registers a veto tool
        const vetoTool = tools.find((t) => t.name === "veto")!;
        await expect(call(vetoTool, { reason: "  \n  ", fingerprint: "fp" })).rejects.toThrow(
          /Reason must be a non-empty string/,
        );
      });

      it("throws when fingerprint is empty string", async () => {
        const { tools } = createOutputTools(defOf());
        await expect(call(tools[0], { advisory: "text", fingerprint: "" })).rejects.toThrow(
          /Fingerprint must be a non-empty string/,
        );
      });

      it("throws when fingerprint is whitespace-only", async () => {
        const { tools } = createOutputTools(defOf());
        await expect(call(tools[0], { advisory: "text", fingerprint: "   \t  " })).rejects.toThrow(
          /Fingerprint must be a non-empty string/,
        );
      });

      it("leaves collector empty after a rejected call (advisory)", async () => {
        const { tools, collector } = createOutputTools(defOf());
        await expect(call(tools[0], { advisory: "", fingerprint: "fp" })).rejects.toThrow();
        expect(collector.take()).toBeNull();
        expect(collector.warnings).toHaveLength(0);
      });

      it("leaves collector empty after a rejected call (fingerprint)", async () => {
        const { tools, collector } = createOutputTools(defOf());
        await expect(call(tools[0], { advisory: "valid text", fingerprint: "" })).rejects.toThrow();
        expect(collector.take()).toBeNull();
        expect(collector.warnings).toHaveLength(0);
      });

      it("observer cannot spoof priority in propose call", async () => {
        const { tools, collector } = createOutputTools(defOf({ priority: 50 }));
        // Try to pass a spoofed priority field (and other fields)
        await call(tools[0], {
          advisory: "text",
          fingerprint: "fp",
          priority: 999,
          deliver: "settle",
          observer: "malicious",
          kind: "veto",
          // biome-ignore lint/suspicious/noExplicitAny: deliberately spoofing extra call-site fields to prove the tool ignores them
        } as any);
        const proposal = collector.take();
        expect(proposal).toMatchObject({
          observer: "o", // From def, not spoofed
          kind: "advisory", // From record() kind, not spoofed
          priority: 50, // From def, not spoofed
          deliver: "next_prompt", // From def, not spoofed
        });
      });

      it("observer cannot spoof priority in veto call", async () => {
        const { tools, collector } = createOutputTools(defOf({ can: ["veto"], priority: 75 }));
        // biome-ignore lint/style/noNonNullAssertion: defOf({ can: ["veto"] }) guarantees createOutputTools registers a veto tool
        const vetoTool = tools.find((t) => t.name === "veto")!;
        // Try to pass a spoofed priority field (and other fields)
        await call(vetoTool, {
          reason: "incomplete",
          fingerprint: "fp",
          priority: 999,
          deliver: "settle",
          observer: "malicious",
          kind: "advisory",
          // biome-ignore lint/suspicious/noExplicitAny: deliberately spoofing extra call-site fields to prove the tool ignores them
        } as any);
        const proposal = collector.take();
        expect(proposal).toMatchObject({
          observer: "o", // From def, not spoofed
          kind: "veto", // From record() kind, not spoofed
          priority: 75, // From def, not spoofed
          deliver: "next_prompt", // From def, not spoofed
        });
      });
    });

    // Blank-codepoint validation (round 2 fix): trim() alone does not catch
    // every blank-looking codepoint. These are written as \uXXXX escapes
    // rather than pasted invisible characters so the diff stays reviewable.
    describe("blank codepoint validation", () => {
      const BLANK_CASES: Array<[string, string]> = [
        ["U+200B zero-width space", "\u200B"],
        ["U+2800 Braille pattern blank", "\u2800"],
        ["U+3164 Hangul filler", "\u3164"],
        ["U+115F Hangul choseong filler", "\u115F"],
        ["U+17B4 Khmer inherent vowel", "\u17B4"],
        ["empty string", ""],
        ["U+FEFF BOM", "\uFEFF"],
        ["U+0085 NEL", "\u0085"],
        ["ordinary space", " "],
        ["mixed all-blank string", "\u200B\u2800 \t"],
        ["mixed all-blank string with NEL", "\u200B\u0085 \t"],
      ];

      for (const [label, value] of BLANK_CASES) {
        it(`rejects advisory containing only blank codepoints: ${label}`, async () => {
          const { tools } = createOutputTools(defOf());
          await expect(call(tools[0], { advisory: value, fingerprint: "fp" })).rejects.toThrow(
            /Advisory must be a non-empty string/,
          );
        });

        it(`rejects veto reason containing only blank codepoints: ${label}`, async () => {
          const { tools } = createOutputTools(defOf({ can: ["veto"] }));
          // biome-ignore lint/style/noNonNullAssertion: defOf({ can: ["veto"] }) guarantees createOutputTools registers a veto tool
          const vetoTool = tools.find((t) => t.name === "veto")!;
          await expect(call(vetoTool, { reason: value, fingerprint: "fp" })).rejects.toThrow(
            /Reason must be a non-empty string/,
          );
        });

        it(`rejects fingerprint containing only blank codepoints: ${label}`, async () => {
          const { tools } = createOutputTools(defOf());
          await expect(
            call(tools[0], { advisory: "valid text", fingerprint: value }),
          ).rejects.toThrow(/Fingerprint must be a non-empty string/);
        });
      }

      it("accepts advisory with a zero-width space plus real content", async () => {
        const { tools, collector } = createOutputTools(defOf());
        await call(tools[0], { advisory: "\u200Bx", fingerprint: "fp" });
        expect(collector.take()?.text).toBe("\u200Bx");
      });

      it("accepts advisory with a Braille blank plus real content", async () => {
        const { tools, collector } = createOutputTools(defOf());
        await call(tools[0], { advisory: "\u2800ok", fingerprint: "fp" });
        expect(collector.take()?.text).toBe("\u2800ok");
      });

      it("accepts advisory with a NEL plus real content", async () => {
        const { tools, collector } = createOutputTools(defOf());
        await call(tools[0], { advisory: "\u0085x", fingerprint: "fp" });
        expect(collector.take()?.text).toBe("\u0085x");
      });

      it("accepts ordinary text", async () => {
        const { tools, collector } = createOutputTools(defOf());
        await call(tools[0], { advisory: "check the tests", fingerprint: "fp" });
        expect(collector.take()?.text).toBe("check the tests");
      });

      it("accepts text containing an emoji", async () => {
        const { tools, collector } = createOutputTools(defOf({ maxAdvisoryChars: 50 }));
        await call(tools[0], { advisory: "looks good \u{1F44D}", fingerprint: "fp" });
        expect(collector.take()?.text).toBe("looks good \u{1F44D}");
      });

      it("accepts Hebrew text", async () => {
        const { tools, collector } = createOutputTools(defOf({ maxAdvisoryChars: 50 }));
        await call(tools[0], { advisory: "שלום", fingerprint: "fp" });
        expect(collector.take()?.text).toBe("שלום");
      });

      it("accepts Chinese text", async () => {
        const { tools, collector } = createOutputTools(defOf({ maxAdvisoryChars: 50 }));
        await call(tools[0], { advisory: "你好世界", fingerprint: "fp" });
        expect(collector.take()?.text).toBe("你好世界");
      });

      it("a rejected blank call does not consume the one-proposal-per-run allowance", async () => {
        const { tools, collector } = createOutputTools(defOf());
        await expect(call(tools[0], { advisory: "\u2800", fingerprint: "fp" })).rejects.toThrow();
        expect(collector.take()).toBeNull();
        await call(tools[0], { advisory: "valid follow-up", fingerprint: "fp2" });
        expect(collector.take()?.text).toBe("valid follow-up");
        expect(collector.warnings).toHaveLength(0);
      });
    });
  });
});
