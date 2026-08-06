import type { ObserverDefinition } from "./types.ts";

export interface ModelLike {
  provider: string;
  id: string;
}

/** Narrow view of pi's ModelRegistry, so resolution is testable without pi.
 *
 * Contracts:
 * - `all()` must return results in stable order. When multiple entries
 *   normalize to the same id, the deterministic winner is the first by
 *   (provider, id) lexicographic sort — callers rely on this tie-break.
 * - Authentication and availability filtering are the adapter's responsibility,
 *   not this file's. Task 13's adapter must apply those before populating
 *   the registry.
 */
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
 * stamp is optional. The date suffix is stripped only when it is a plausible date
 * (YYYY from 2000-2999, MM from 01-12, DD from 01-31) to avoid silently truncating
 * legitimate model ids that happen to end in 8 digits.
 */
export function normalizeModelId(id: string): string {
  const lower = id.toLowerCase().replace(/\./g, "-");
  // Only strip a suffix if it parses as a valid date: YYYYMMDD where
  // YYYY is 2000-2999, MM is 01-12, DD is 01-31
  const dateMatch = lower.match(/-(?:20|21|22|23|24|25|26|27|28|29)(\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/);
  if (dateMatch) {
    return lower.slice(0, -(dateMatch[0].length));
  }
  return lower;
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
    // Sort by (provider, id) to break ties deterministically when multiple
    // entries normalize to the same id
    const candidates = lookup
      .all()
      .filter((m) => m.provider === provider && normalizeModelId(m.id) === target)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    const fuzzy = candidates[0];
    if (fuzzy) return { model: fuzzy, via: "fuzzy" };
  }

  const target = normalizeModelId(id);
  // Sort by (provider, id) to break ties deterministically when multiple
  // entries normalize to the same id
  const candidates = lookup
    .all()
    .filter((m) => normalizeModelId(m.id) === target)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const anyProvider = candidates[0];
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
  // Treat blank or whitespace-only model as absent, before falling through to defaultModel
  const primary = (def.model?.trim() || undefined) ?? opts.defaultModel;
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
