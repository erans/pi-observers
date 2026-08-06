import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ObserverDefinition, Proposal } from "./types.ts";

export interface ProposalCollector {
  /** The single proposal from this run, or null if the observer stayed quiet. */
  take(): Proposal | null;
  warnings: string[];
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
   * Validate and trim a string field, rejecting empty or whitespace-only values.
   * Mirrors the convention from src/definitions.ts requireString().
   */
  const requireNonEmpty = (value: unknown, fieldName: string): string => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${fieldName} must be a non-empty string.`);
    }
    return value.trim();
  };

  const record = (kind: Proposal["kind"], text: string, fingerprint: string) => {
    // Validate inputs BEFORE checking for existing proposal or length.
    // This ensures rejected calls don't consume the observer's one emission.
    const trimmedText = requireNonEmpty(text, kind === "advisory" ? "Advisory" : "Reason");
    const trimmedFingerprint = requireNonEmpty(fingerprint, "Fingerprint");

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
    warnings,
  };

  return { tools, collector };
}
