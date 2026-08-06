import { describe, expect, it } from "vitest";
import { normalizeModelId, resolveObserverModel, type ModelLike, type ModelLookup } from "../src/models.ts";
import type { ObserverDefinition } from "../src/types.ts";

function lookupOf(models: ModelLike[]): ModelLookup {
  return {
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    all: () => models,
  };
}

function defOf(over: Partial<ObserverDefinition>): ObserverDefinition {
  return {
    name: "o", description: "d", enabled: true, on: "turn_end", sees: [], tools: [],
    can: ["advise"], deliver: "next_prompt", fallback: [], thinking: "low", priority: 50,
    maxAdvisoryChars: 300, timeoutMs: 20000, systemPrompt: "b", sourcePath: "/o.md",
    scope: "builtin", ...over,
  };
}

const SESSION: ModelLike = { provider: "openai-codex", id: "gpt-5.6-sol" };

describe("normalizeModelId", () => {
  it("treats . and - as equivalent and drops a trailing date stamp", () => {
    expect(normalizeModelId("claude-haiku-4.5")).toBe(normalizeModelId("claude-haiku-4-5"));
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe(normalizeModelId("claude-haiku-4-5"));
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
    const r = resolveObserverModel(defOf({ model: "anthropic/claude-haiku-4-5" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "any-provider" });
    if (r.status === "resolved") expect(r.model.provider).toBe("bedrock");
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
    const r = resolveObserverModel(defOf({ model: "nope/nope" }), lookup, { sessionModel: SESSION });
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
