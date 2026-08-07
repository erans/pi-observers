import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ObserverDefinition, Proposal } from "./types.ts";

export interface ProposalCollector {
  /** The single proposal from this run, or null if the observer stayed quiet. */
  take(): Proposal | null;
  /**
   * Clear the proposal and warnings so the same tool objects can serve the next
   * run. The runner creates its tools once, at session creation, and the model
   * only ever sees those objects; rebuilding them per run would leave the model
   * writing into a collector nobody reads. Resetting is how a run starts clean
   * without replacing the tools.
   */
  reset(): void;
  warnings: string[];
}

/**
 * Matches characters that render as blank: standard whitespace, Unicode
 * format characters (\p{Cf}, e.g. U+200B zero-width space, U+FEFF BOM), and
 * a set of invisible codepoints whose General_Category is NOT Cf so \p{Cf}
 * alone misses them: U+2800 Braille pattern blank, U+115F/U+1160 Hangul
 * fillers, U+17B4/U+17B5 Khmer inherent vowels, U+3164 Hangul filler,
 * U+FFA0 halfwidth Hangul filler. U+0085 (NEL) is listed explicitly
 * (as the \u0085 escape below) because JavaScript's `\s` does NOT match
 * it, and its General_Category is Cc (not Cf), so \p{Cf} does not cover
 * it either -- it would otherwise fall through both guards. The `u` flag
 * is required for \p{...} to work at all. Every non-ASCII codepoint below
 * is written as a \uXXXX escape rather than a literal, so the source
 * stays unambiguous under any transport that might mangle raw invisible
 * characters.
 */
export const BLANK = /[\s\u0085\p{Cf}\u2800\u115F\u1160\u17B4\u17B5\u3164\uFFA0]/gu;

/**
 * Bound on a fingerprint's length. Emission (src/outputs.ts) rejects fingerprints
 * exceeding this length; the reconciler rejects them again on replay.
 *
 * Over-long fingerprints are REJECTED, never truncated. Truncating would map two
 * distinct advisories that share a long prefix onto one key, so accepting the first
 * would silently suppress the second -- advice lost with no trace. Rejecting means an
 * advisory with an absurd fingerprint may be delivered again after a reload, which is
 * visible, bounded by the per-turn advisory budget, and strictly the better failure.
 */
export const MAX_FINGERPRINT_LENGTH = 512;

export function isBlank(value: string): boolean {
  return value.replace(BLANK, "") === "";
}

/**
 * Build the output tools for one observer run.
 *
 * These are the observer's only means of emitting anything — its prose final
 * message is discarded. Not calling either tool is how an observer says
 * "nothing to add", which is the common case and costs no parsing.
 */
export function createOutputTools(def: ObserverDefinition) {
  let proposal: Proposal | null = null;
  const warnings: string[] = [];

  /**
   * Validate and trim a string field, rejecting values that are empty or
   * whose every character renders as blank (see BLANK above). A string
   * containing at least one real character is accepted even if it also
   * contains invisible characters.
   * Mirrors the convention from src/definitions.ts requireString().
   */
  const requireNonEmpty = (value: unknown, fieldName: string): string => {
    if (typeof value !== "string" || value.replace(BLANK, "") === "") {
      throw new Error(`${fieldName} must be a non-empty string.`);
    }
    return value.trim();
  };

  const record = (kind: Proposal["kind"], text: string, fingerprint: string) => {
    // Validate inputs BEFORE checking for existing proposal or length.
    // This ensures rejected calls don't consume the observer's one emission.
    const trimmedText = requireNonEmpty(text, kind === "advisory" ? "Advisory" : "Reason");
    const trimmedFingerprint = requireNonEmpty(fingerprint, "Fingerprint");
    if (trimmedFingerprint.length > MAX_FINGERPRINT_LENGTH) {
      throw new Error(
        `Fingerprint is ${trimmedFingerprint.length} chars, which exceeds max ${MAX_FINGERPRINT_LENGTH}.`,
      );
    }

    if (proposal) {
      warnings.push(`${def.name} already proposed this run; ignoring the extra ${kind}.`);
      return `Ignored: ${def.name} has already emitted once this run.`;
    }
    if (trimmedText.length > def.maxAdvisoryChars) {
      throw new Error(
        `Text is ${trimmedText.length} chars, which exceeds max_advisory_chars (${def.maxAdvisoryChars}). Be brief.`,
      );
    }
    proposal = {
      observer: def.name,
      kind,
      text: trimmedText,
      fingerprint: trimmedFingerprint,
      priority: def.priority,
      deliver: def.deliver,
    };
    return "Recorded.";
  };

  const tools = [];

  if (def.can.includes("advise")) {
    tools.push(
      defineTool({
        name: "propose",
        label: "Propose",
        description:
          "Propose a single short advisory for the main agent. Call this at most once. If you have nothing useful to add, do not call it at all.",
        parameters: Type.Object({
          advisory: Type.String({ description: "The advisory. One or two sentences." }),
          fingerprint: Type.String({
            description:
              "Stable dedupe key identifying this specific advice, so it is not repeated later in the session.",
          }),
        }),
        async execute(_toolCallId, params) {
          const text = record("advisory", params.advisory, params.fingerprint);
          return { content: [{ type: "text", text }], details: {} };
        },
      }),
    );
  }

  if (def.can.includes("veto")) {
    tools.push(
      defineTool({
        name: "veto",
        label: "Veto",
        description:
          "Decline to let the turn close because required work is not done. Call this at most once, and only when you are confident.",
        parameters: Type.Object({
          reason: Type.String({ description: "One sentence naming what remains undone." }),
          fingerprint: Type.String({ description: "Stable dedupe key for this veto." }),
        }),
        async execute(_toolCallId, params) {
          const text = record("veto", params.reason, params.fingerprint);
          return { content: [{ type: "text", text }], details: {} };
        },
      }),
    );
  }

  const collector: ProposalCollector = {
    take: () => proposal,
    reset: () => {
      proposal = null;
      warnings.length = 0;
    },
    warnings,
  };

  return { tools, collector };
}
