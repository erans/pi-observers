import { DEFAULTS } from "./types.ts";

export interface ObserverSettings {
  enabled: boolean;
  maxAdvisoriesPerTurn: number;
  vetoBudget: number;
  defaultModel?: string;
  disable: string[];
}

/** Safety ceilings on user-supplied values. Not preferences — these bound how much an
 *  observer can inject into the main agent even if a settings file asks for more. */
const MAX_ADVISORIES_LIMIT = 10;
const MAX_VETO_BUDGET_LIMIT = 10;

function positiveIntOr(value: unknown, fallback: number, max: number): number {
  // Reject booleans explicitly: Number(true) === 1, which would silently accept
  // `maxAdvisoriesPerTurn: true` as the number 1.
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return fallback;
  // Upper bound is a safety limit, not a preference. The reconciler's per-turn cap and
  // the veto budget are the only things bounding how much an observer can inject into
  // the main agent; an unbounded value from a hand-edited settings file (a typo adding
  // a digit) would re-enable exactly the runaway loop the budget exists to prevent.
  return Math.min(num, max);
}

/** Accepts a real boolean or the strings "true"/"false", matching the observer-file
 *  convention in definitions.ts. Anything else falls back rather than coercing:
 *  Boolean("false") is true, which would invert the user's stated intent. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Tolerant by design: bad settings degrade to defaults rather than blocking startup.
 *  This is the deliberate difference from definitions.ts, which errors on bad input —
 *  a broken observer file names one broken observer, a broken settings file would
 *  otherwise take down every observer at once. */
export function parseSettings(raw: unknown): ObserverSettings {
  const obj = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const defaultModel =
    typeof obj.defaultModel === "string" && obj.defaultModel.trim() !== "" ? obj.defaultModel.trim() : undefined;

  return {
    enabled: booleanOr(obj.enabled, true),
    maxAdvisoriesPerTurn: positiveIntOr(obj.maxAdvisoriesPerTurn, DEFAULTS.maxAdvisoriesPerTurn, MAX_ADVISORIES_LIMIT),
    vetoBudget: positiveIntOr(obj.vetoBudget, DEFAULTS.vetoBudget, MAX_VETO_BUDGET_LIMIT),
    defaultModel,
    disable: Array.isArray(obj.disable)
      ? obj.disable.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim())
      : [],
  };
}

/** Either switch being off means off. */
export function isObserverEnabled(def: { name: string; enabled: boolean }, settings: ObserverSettings): boolean {
  if (!settings.enabled) return false;
  if (!def.enabled) return false;
  return !settings.disable.includes(def.name);
}
