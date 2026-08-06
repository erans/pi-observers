import { describe, expect, it } from "vitest";
import { isObserverEnabled, parseSettings } from "../src/settings.ts";

describe("parseSettings", () => {
  it("returns defaults for undefined", () => {
    expect(parseSettings(undefined)).toEqual({
      enabled: true,
      maxAdvisoriesPerTurn: 2,
      vetoBudget: 3,
      defaultModel: undefined,
      disable: [],
    });
  });

  it("reads provided values", () => {
    const s = parseSettings({
      enabled: false,
      maxAdvisoriesPerTurn: 5,
      vetoBudget: 1,
      defaultModel: "lunaroute/deepseek-v4-flash",
      disable: ["verification"],
    });
    expect(s.enabled).toBe(false);
    expect(s.maxAdvisoriesPerTurn).toBe(5);
    expect(s.vetoBudget).toBe(1);
    expect(s.defaultModel).toBe("lunaroute/deepseek-v4-flash");
    expect(s.disable).toEqual(["verification"]);
  });

  it("ignores malformed values rather than throwing", () => {
    const s = parseSettings({ maxAdvisoriesPerTurn: "lots", disable: "nope", vetoBudget: -1 });
    expect(s.maxAdvisoriesPerTurn).toBe(2);
    expect(s.vetoBudget).toBe(3);
    expect(s.disable).toEqual([]);
  });

  it("ignores a non-object", () => {
    expect(parseSettings("nope").enabled).toBe(true);
  });

  it('honors enabled: "false" instead of coercing it to true', () => {
    // Boolean("false") is true. Coercion here would silently invert the user's intent,
    // which is the same defect definitions.ts already had to fix.
    expect(parseSettings({ enabled: "false" }).enabled).toBe(false);
    expect(parseSettings({ enabled: "true" }).enabled).toBe(true);
  });

  it("falls back rather than coercing a nonsense enabled value", () => {
    expect(parseSettings({ enabled: "yes" }).enabled).toBe(true);
    expect(parseSettings({ enabled: 0 }).enabled).toBe(true);
  });

  it("rejects a boolean where a count is expected", () => {
    // Number(true) === 1, which would silently read as "one advisory per turn".
    expect(parseSettings({ maxAdvisoriesPerTurn: true }).maxAdvisoriesPerTurn).toBe(2);
    expect(parseSettings({ vetoBudget: false }).vetoBudget).toBe(3);
  });

  it("clamps counts to the safety ceiling", () => {
    expect(parseSettings({ maxAdvisoriesPerTurn: 999999 }).maxAdvisoriesPerTurn).toBe(10);
    expect(parseSettings({ vetoBudget: 999999 }).vetoBudget).toBe(10);
  });

  it("does not clamp a value that is already under the ceiling", () => {
    // Guards against an implementation that always returns the ceiling.
    expect(parseSettings({ maxAdvisoriesPerTurn: 4 }).maxAdvisoriesPerTurn).toBe(4);
    expect(parseSettings({ vetoBudget: 7 }).vetoBudget).toBe(7);
  });

  it("accepts the ceiling value itself unclamped", () => {
    expect(parseSettings({ maxAdvisoriesPerTurn: 10 }).maxAdvisoriesPerTurn).toBe(10);
  });

  it("drops non-string and blank entries from disable", () => {
    expect(parseSettings({ disable: ["a", "", "  ", null, 7, {}, " b "] }).disable).toEqual([
      "a",
      "b",
    ]);
  });

  // --- Exploratory: null vs undefined vs missing ---

  it("treats an explicit null the same as a missing field, for every field", () => {
    const s = parseSettings({
      enabled: null,
      maxAdvisoriesPerTurn: null,
      vetoBudget: null,
      defaultModel: null,
      disable: null,
    });
    expect(s).toEqual(parseSettings({}));
  });

  it("treats null as the whole settings value the same as undefined", () => {
    expect(parseSettings(null)).toEqual(parseSettings(undefined));
  });

  // --- Exploratory: numeric strings and floats ---

  it("accepts a numeric string count, matching the string-tolerant convention", () => {
    expect(parseSettings({ maxAdvisoriesPerTurn: "5" }).maxAdvisoriesPerTurn).toBe(5);
  });

  it("rejects a float count rather than truncating or rounding it", () => {
    expect(parseSettings({ maxAdvisoriesPerTurn: 2.5 }).maxAdvisoriesPerTurn).toBe(2);
    expect(parseSettings({ vetoBudget: 3.9 }).vetoBudget).toBe(3);
  });

  it("rejects a float-looking numeric string", () => {
    expect(parseSettings({ maxAdvisoriesPerTurn: "2.5" }).maxAdvisoriesPerTurn).toBe(2);
  });

  it("rejects zero and negative counts", () => {
    expect(parseSettings({ maxAdvisoriesPerTurn: 0 }).maxAdvisoriesPerTurn).toBe(2);
    expect(parseSettings({ maxAdvisoriesPerTurn: -5 }).maxAdvisoriesPerTurn).toBe(2);
    expect(parseSettings({ vetoBudget: 0 }).vetoBudget).toBe(3);
  });

  it("rejects NaN, Infinity, and non-numeric strings for counts", () => {
    expect(parseSettings({ maxAdvisoriesPerTurn: Number.NaN }).maxAdvisoriesPerTurn).toBe(2);
    expect(
      parseSettings({ maxAdvisoriesPerTurn: Number.POSITIVE_INFINITY }).maxAdvisoriesPerTurn,
    ).toBe(2);
    expect(parseSettings({ maxAdvisoriesPerTurn: "abc" }).maxAdvisoriesPerTurn).toBe(2);
    expect(parseSettings({ maxAdvisoriesPerTurn: "" }).maxAdvisoriesPerTurn).toBe(2);
    expect(parseSettings({ maxAdvisoriesPerTurn: "  " }).maxAdvisoriesPerTurn).toBe(2);
  });

  it("rejects an array where a count is expected", () => {
    expect(parseSettings({ maxAdvisoriesPerTurn: [5] }).maxAdvisoriesPerTurn).toBe(2);
  });

  // --- Exploratory: arrays / scalars swapped ---

  it("falls back when the whole settings value is an array", () => {
    const s = parseSettings([1, 2, 3]);
    expect(s).toEqual(parseSettings(undefined));
  });

  it("falls back when disable is a scalar instead of an array (object, number, boolean)", () => {
    expect(parseSettings({ disable: 7 }).disable).toEqual([]);
    expect(parseSettings({ disable: true }).disable).toEqual([]);
    expect(parseSettings({ disable: { a: true } }).disable).toEqual([]);
  });

  it("falls back when enabled is an array", () => {
    expect(parseSettings({ enabled: [true] }).enabled).toBe(true);
  });

  it("falls back when defaultModel is not a string (number, array, object)", () => {
    expect(parseSettings({ defaultModel: 5 }).defaultModel).toBeUndefined();
    expect(parseSettings({ defaultModel: ["x"] }).defaultModel).toBeUndefined();
    expect(parseSettings({ defaultModel: {} }).defaultModel).toBeUndefined();
  });

  it("treats a blank/whitespace-only defaultModel as absent", () => {
    expect(parseSettings({ defaultModel: "" }).defaultModel).toBeUndefined();
    expect(parseSettings({ defaultModel: "   " }).defaultModel).toBeUndefined();
  });

  it("trims a defaultModel with surrounding whitespace", () => {
    expect(parseSettings({ defaultModel: "  foo/bar  " }).defaultModel).toBe("foo/bar");
  });

  // --- Exploratory: prototype-polluting / nested keys ---

  it("does not let a __proto__ key pollute the prototype or leak into the result", () => {
    // JSON.parse gives "__proto__" as an own data property, not the accessor — it does not
    // touch the real prototype chain. This guards against a rewrite that spreads/copies keys
    // (e.g. `{...obj}`) and thereby carries that own property into the returned object.
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "enabled": true}');
    const s = parseSettings(payload);
    expect(Object.hasOwn(s, "__proto__")).toBe(false);
    expect(JSON.stringify(s)).not.toContain("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(s.enabled).toBe(true);
  });

  it("ignores unknown/nested keys instead of throwing", () => {
    const s = parseSettings({
      enabled: true,
      nested: { deeply: { value: 1 } },
      constructor: { prototype: { polluted: true } },
    });
    expect(s.enabled).toBe(true);
    expect((s as unknown as Record<string, unknown>).nested).toBeUndefined();
  });

  it("does not let a disable entry with a prototype-polluting name behave specially", () => {
    const s = parseSettings({ disable: ["__proto__", "constructor"] });
    expect(s.disable).toEqual(["__proto__", "constructor"]);
  });

  // --- Exploratory: no mutation / no reference retention ---

  it("does not mutate the input object", () => {
    const input = { enabled: false, maxAdvisoriesPerTurn: 5, disable: ["a"] };
    const snapshot = JSON.parse(JSON.stringify(input));
    parseSettings(input);
    expect(input).toEqual(snapshot);
  });

  it("does not retain a reference to the input's disable array", () => {
    const disable = ["a", "b"];
    const input = { disable };
    const s = parseSettings(input);
    disable.push("c");
    expect(s.disable).toEqual(["a", "b"]);
  });

  it("returns independent objects across calls (no shared mutable default)", () => {
    const a = parseSettings(undefined);
    const b = parseSettings(undefined);
    a.disable.push("x");
    expect(b.disable).toEqual([]);
  });
});

describe("isObserverEnabled", () => {
  const base = parseSettings(undefined);

  it("is on when the file says enabled and settings do not disable it", () => {
    expect(isObserverEnabled({ name: "a", enabled: true }, base)).toBe(true);
  });

  it("is off when the file disables it", () => {
    expect(isObserverEnabled({ name: "a", enabled: false }, base)).toBe(false);
  });

  it("is off when settings disable it", () => {
    const s = parseSettings({ disable: ["a"] });
    expect(isObserverEnabled({ name: "a", enabled: true }, s)).toBe(false);
  });

  it("is off for every observer when the whole feature is disabled", () => {
    const s = parseSettings({ enabled: false });
    expect(isObserverEnabled({ name: "a", enabled: true }, s)).toBe(false);
  });

  it("does not disable an unrelated observer via a partial name match", () => {
    const s = parseSettings({ disable: ["verification"] });
    expect(isObserverEnabled({ name: "verification-strict", enabled: true }, s)).toBe(true);
    expect(isObserverEnabled({ name: "verification", enabled: true }, s)).toBe(false);
  });

  it("is on for an observer whose name is not in a non-empty disable list", () => {
    const s = parseSettings({ disable: ["other"] });
    expect(isObserverEnabled({ name: "a", enabled: true }, s)).toBe(true);
  });
});
