import { describe, expect, it } from "vitest";
import {
  type ModelLike,
  type ModelLookup,
  normalizeModelId,
  resolveObserverModel,
} from "../src/models.ts";
import type { ObserverDefinition } from "../src/types.ts";

function lookupOf(models: ModelLike[]): ModelLookup {
  return {
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    all: () => models,
  };
}

function defOf(over: Partial<ObserverDefinition>): ObserverDefinition {
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
    priority: 50,
    maxAdvisoryChars: 300,
    timeoutMs: 20000,
    systemPrompt: "b",
    sourcePath: "/o.md",
    scope: "builtin",
    ...over,
  };
}

const SESSION: ModelLike = { provider: "openai-codex", id: "gpt-5.6-sol" };

describe("normalizeModelId", () => {
  it("treats . and - as equivalent and drops a trailing date stamp", () => {
    expect(normalizeModelId("claude-haiku-4.5")).toBe(normalizeModelId("claude-haiku-4-5"));
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe(
      normalizeModelId("claude-haiku-4-5"),
    );
  });
});

describe("resolveObserverModel", () => {
  it("step 1: exact match wins", () => {
    const lookup = lookupOf([{ provider: "lunaroute", id: "deepseek-v4-flash" }]);
    const r = resolveObserverModel(defOf({ model: "lunaroute/deepseek-v4-flash" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "exact" });
  });

  it("step 2: fuzzy match under the named provider", () => {
    const lookup = lookupOf([{ provider: "anthropic", id: "claude-haiku-4-5-20251001" }]);
    const r = resolveObserverModel(defOf({ model: "anthropic/claude-haiku-4.5" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "fuzzy" });
    if (r.status === "resolved") expect(r.model.id).toBe("claude-haiku-4-5-20251001");
  });

  it("step 3: same bare id under a different provider", () => {
    const lookup = lookupOf([{ provider: "bedrock", id: "claude-haiku-4-5" }]);
    // Provider is pinned — must NOT cross to any-provider; falls back to disabled/session.
    const r = resolveObserverModel(defOf({ model: "anthropic/claude-haiku-4-5" }), lookup, {});
    expect(r.status).toBe("disabled");
  });

  it("step 4: falls back in listed order", () => {
    const lookup = lookupOf([{ provider: "anthropic", id: "claude-haiku-4-5" }]);
    const r = resolveObserverModel(
      defOf({ model: "lunaroute/gone", fallback: ["also/gone", "anthropic/claude-haiku-4-5"] }),
      lookup,
      {},
    );
    expect(r).toMatchObject({ status: "resolved", via: "fallback" });
  });

  it("step 5: falls back to the session model", () => {
    const lookup = lookupOf([SESSION]);
    const r = resolveObserverModel(defOf({ model: "nope/nope" }), lookup, {
      sessionModel: SESSION,
    });
    expect(r).toMatchObject({ status: "resolved", via: "session" });
  });

  it("step 6: disables when nothing resolves and there is no session model", () => {
    const r = resolveObserverModel(defOf({ model: "nope/nope" }), lookupOf([]), {});
    expect(r.status).toBe("disabled");
    if (r.status === "disabled") expect(r.reason).toContain("nope/nope");
  });

  it("substitutes settings defaultModel when the file omits model", () => {
    const lookup = lookupOf([{ provider: "lunaroute", id: "deepseek-v4-flash" }]);
    const r = resolveObserverModel(defOf({}), lookup, {
      defaultModel: "lunaroute/deepseek-v4-flash",
    });
    expect(r).toMatchObject({ status: "resolved", via: "exact" });
  });

  it("starts at the session model when neither file nor settings name one", () => {
    const r = resolveObserverModel(defOf({}), lookupOf([SESSION]), { sessionModel: SESSION });
    expect(r).toMatchObject({ status: "resolved", via: "session" });
  });

  it("accepts a bare model id with no provider", () => {
    const lookup = lookupOf([{ provider: "anthropic", id: "claude-haiku-4-5" }]);
    const r = resolveObserverModel(defOf({ model: "claude-haiku-4-5" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "any-provider" });
  });
});

describe("normalizeModelId (exploratory)", () => {
  it("does NOT strip 8 non-date digits at the end", () => {
    // A model id ending in 8 arbitrary digits (e.g., build number or version)
    // should not be truncated to match an unrelated base model
    const withBuildNum = normalizeModelId("llama-2-70b-12345678");
    expect(withBuildNum).toBe("llama-2-70b-12345678");
    expect(withBuildNum).not.toBe("llama-2-70b");
  });

  it("strips a valid YYYYMMDD date stamp", () => {
    // Valid dates like 20251001 (Oct 1, 2025) should be stripped
    // Note: dots are also converted to dashes during normalization
    const withDate = normalizeModelId("gemini-2.0-pro-20251001");
    expect(withDate).toBe("gemini-2-0-pro");
  });

  it("handles various valid date boundaries correctly", () => {
    // First day of a month (01), last possible day (31)
    expect(normalizeModelId("model-20240101")).toBe("model");
    expect(normalizeModelId("model-20240131")).toBe("model");
    // December (12)
    expect(normalizeModelId("model-20241201")).toBe("model");
  });

  it("does NOT strip invalid dates (month > 12 or day > 31)", () => {
    // Month 13 is invalid; should not strip
    expect(normalizeModelId("model-20241301")).toBe("model-20241301");
    // Day 32 is invalid; should not strip
    expect(normalizeModelId("model-20240132")).toBe("model-20240132");
  });

  it("does not strip 8 digits that are not preceded by a dash", () => {
    // If there's no dash before the 8 digits, they're part of the id and should not be stripped
    expect(normalizeModelId("model20251001")).toBe("model20251001");
  });
});

describe("resolveObserverModel (exploratory)", () => {
  it("picks deterministic winner when multiple entries normalize to the same id", () => {
    // When two models have the same normalized id, the lexicographically first
    // by (provider, id) should win, not arbitrary iteration order
    const lookup = lookupOf([
      { provider: "zebra", id: "claude-haiku-4-5-20241001" },
      { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
    ]);
    const r = resolveObserverModel(defOf({ model: "anthropic/claude-haiku-4.5" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "fuzzy" });
    // Should pick anthropic's entry, not zebra's, because anthropic < zebra alphabetically
    if (r.status === "resolved") {
      expect(r.model.provider).toBe("anthropic");
    }
  });

  it("deterministically sorts by (provider, id) in any-provider step", () => {
    // Two models with same normalized id but different providers: pick by (provider, id) sort
    const lookup = lookupOf([
      { provider: "bedrock", id: "claude-3-opus-20240229" },
      { provider: "anthropic", id: "claude-3-opus" },
    ]);
    const r = resolveObserverModel(defOf({ model: "claude-3-opus" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "any-provider" });
    if (r.status === "resolved") {
      // anthropic < bedrock, so anthropic should win
      expect(r.model.provider).toBe("anthropic");
    }
  });

  it("treats whitespace-only model as absent and uses defaultModel", () => {
    const lookup = lookupOf([{ provider: "lunaroute", id: "deepseek-v4-flash" }]);
    // def.model is whitespace-only; should fall through to defaultModel
    const r = resolveObserverModel(defOf({ model: "   " }), lookup, {
      defaultModel: "lunaroute/deepseek-v4-flash",
    });
    expect(r).toMatchObject({ status: "resolved", via: "exact" });
  });

  it("treats empty string model as absent and uses defaultModel", () => {
    const lookup = lookupOf([{ provider: "anthropic", id: "claude-haiku-4-5" }]);
    const r = resolveObserverModel(defOf({ model: "" }), lookup, {
      defaultModel: "anthropic/claude-haiku-4-5",
    });
    expect(r).toMatchObject({ status: "resolved", via: "exact" });
  });

  it("falls back to session model when blank model is given and no defaultModel", () => {
    const lookup = lookupOf([SESSION]);
    const r = resolveObserverModel(defOf({ model: "  " }), lookup, { sessionModel: SESSION });
    expect(r).toMatchObject({ status: "resolved", via: "session" });
  });
});
