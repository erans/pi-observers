import type { ObserverDefinition } from "./types.ts";

export interface ModelLike {
  provider: string;
  id: string;
}

/** Narrow view of pi's ModelRegistry, so resolution is testable without pi. */
export interface ModelLookup {
  find(provider: string, id: string): ModelLike | undefined;
  all(): ModelLike[];
}

export type ResolutionStep = "exact" | "fuzzy" | "any-provider" | "fallback" | "session";

export type ModelResolution =
  | { status: "resolved"; model: ModelLike; via: ResolutionStep }
  | { status: "disabled"; reason: string };

/**
 * Cosmetic id variations must not silently drop an observer to a different model:
 * `.` and `-` are equivalent in version numbers, and a trailing -YYYYMMDD date
 * stamp is optional.
 */
export function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
}

function splitRef(ref: string): { provider?: string; id: string } {
  const slash = ref.indexOf("/");
  if (slash === -1) return { id: ref.trim() };
  return { provider: ref.slice(0, slash).trim(), id: ref.slice(slash + 1).trim() };
}

/** Steps 1-3 for a single model reference. */
function resolveRef(ref: string, lookup: ModelLookup): { model: ModelLike; via: ResolutionStep } | undefined {
  const { provider, id } = splitRef(ref);
  if (!id) return undefined;

  if (provider) {
    const exact = lookup.find(provider, id);
    if (exact) return { model: exact, via: "exact" };

    const target = normalizeModelId(id);
    const fuzzy = lookup.all().find((m) => m.provider === provider && normalizeModelId(m.id) === target);
    if (fuzzy) return { model: fuzzy, via: "fuzzy" };
  }

  const target = normalizeModelId(id);
  const anyProvider = lookup.all().find((m) => normalizeModelId(m.id) === target);
  if (anyProvider) return { model: anyProvider, via: "any-provider" };

  return undefined;
}

/**
 * Resolve an observer's model. Never silently inert, never silently expensive:
 * an unresolvable pin falls through to the session model, and if there is not
 * even one of those, the observer is disabled with a stated reason.
 */
export function resolveObserverModel(
  def: ObserverDefinition,
  lookup: ModelLookup,
  opts: { defaultModel?: string; sessionModel?: ModelLike },
): ModelResolution {
  const primary = def.model ?? opts.defaultModel;
  const attempted: string[] = [];

  if (primary) {
    attempted.push(primary);
    const hit = resolveRef(primary, lookup);
    if (hit) return { status: "resolved", model: hit.model, via: hit.via };
  }

  for (const ref of def.fallback) {
    attempted.push(ref);
    const hit = resolveRef(ref, lookup);
    if (hit) return { status: "resolved", model: hit.model, via: "fallback" };
  }

  if (opts.sessionModel) {
    return { status: "resolved", model: opts.sessionModel, via: "session" };
  }

  return {
    status: "disabled",
    reason:
      attempted.length > 0
        ? `No configured model matched ${attempted.join(", ")}, and no session model is available.`
        : "No model configured for this observer and no session model is available.",
  };
}
