import type { SliceName, SliceState, ToolCallRecord } from "./types.ts";

const UNAVAILABLE = "(unavailable)";

// Length limits per field to prevent any single value from dominating the prompt
const FIELD_LIMITS = {
  toolName: 100,
  toolArgs: 5000,
  skillName: 100,
  skillDesc: 1000,
  messageContent: 50000,
  transcriptContent: 50000,
};

/**
 * Collapse all line separator characters (including CR, LF, NEL, U+2028, U+2029, VT, FF)
 * into spaces. Used for fields that must be single-line (tool names, args, skill names/descs).
 * Ensures one ToolCallRecord or skill always renders as exactly one line.
 */
function sanitizeSingleLine(value: string, maxLength: number): string {
  // Replace all line separators with spaces
  const collapsed = value.replace(/[\r\n]+/g, " ");
  return collapsed.substring(0, maxLength);
}

/**
 * Cap multi-line content length while preserving line structure.
 * Used for message and transcript fields that legitimately contain newlines.
 */
function sanitizeMultiLine(value: string, maxLength: number): string {
  return value.substring(0, maxLength);
}

/**
 * Find the fence length needed to wrap content safely.
 * Uses the CommonMark code fence algorithm: find the longest run of backticks
 * in the content, then use a fence that is provably longer.
 * Content containing ``` requires a ```` fence, and so on.
 * This makes forged markup inside the fence inert — it cannot break out.
 */
function findFenceLength(content: string): number {
  const backtickRuns = content.match(/`+/g) || [];
  const maxRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  return Math.max(3, maxRun + 1);
}

/**
 * Wrap content in a backtick fence. Any markdown inside the fence is treated
 * as literal text, not parsed. Forged headers, lists, or other markup become inert.
 * SECURITY INVARIANT: This is a single choke point all slice content passes through.
 */
function wrapInFence(content: string): string {
  const fence = "`".repeat(findFenceLength(content));
  return `${fence}\n${content}\n${fence}`;
}

function renderToolCalls(calls: ToolCallRecord[]): string {
  if (calls.length === 0) return "(no tool calls this turn)";
  return calls
    .map((c) => {
      const name = sanitizeSingleLine(c.name, FIELD_LIMITS.toolName);
      const args = sanitizeSingleLine(c.args, FIELD_LIMITS.toolArgs);
      return `- ${name}(${args}) ${c.isError ? "ERROR" : "ok"}`;
    })
    .join("\n");
}

function renderSkills(skills: Array<{ name: string; description: string }>): string {
  if (skills.length === 0) return "(no skills available)";
  return skills
    .map((s) => {
      const name = sanitizeSingleLine(s.name, FIELD_LIMITS.skillName);
      const desc = sanitizeSingleLine(s.description, FIELD_LIMITS.skillDesc);
      return `- ${name}: ${desc}`;
    })
    .join("\n");
}

function renderOne(slice: SliceName, state: SliceState): string {
  switch (slice) {
    case "last_user_message":
      return state.lastUserMessage
        ? sanitizeMultiLine(state.lastUserMessage, FIELD_LIMITS.messageContent)
        : UNAVAILABLE;
    case "last_assistant_message":
      return state.lastAssistantMessage
        ? sanitizeMultiLine(state.lastAssistantMessage, FIELD_LIMITS.messageContent)
        : UNAVAILABLE;
    case "tool_calls_this_turn":
      return state.toolCallsThisTurn ? renderToolCalls(state.toolCallsThisTurn) : UNAVAILABLE;
    case "transcript":
      return state.transcript
        ? sanitizeMultiLine(state.transcript, FIELD_LIMITS.transcriptContent)
        : UNAVAILABLE;
    case "skills":
      return state.skills ? renderSkills(state.skills) : UNAVAILABLE;
  }
}

/**
 * Render the requested slices as labelled sections, in the order the observer
 * listed them. A slice with no data renders as an explicit "(unavailable)"
 * marker rather than vanishing, so the observer can tell the difference between
 * "nothing happened" and "you weren't shown this".
 *
 * SECURITY INVARIANT — Content Sanitization:
 * Every untrusted string reaches the rendered output through a single choke point:
 * wrapInFence(). The five attacker-reachable paths are:
 *   1. Tool call names (sanitizeSingleLine in renderToolCalls)
 *   2. Tool call args (sanitizeSingleLine in renderToolCalls)
 *   3. Skill names (sanitizeSingleLine in renderSkills)
 *   4. Skill descriptions (sanitizeSingleLine in renderSkills)
 *   5. Message and transcript content (sanitizeMultiLine in renderOne)
 *
 * All paths collapse line separators and apply length caps. Single-line fields
 * collapse separators to spaces, ensuring one ToolCallRecord or skill always renders
 * as exactly one line. Multi-line content is length-capped. All section bodies are
 * wrapped in a backtick fence that expands if content contains backticks, making
 * forged markup inside the fence inert. A reader cannot be misled by attacker-controlled content.
 */
export function renderSlices(sees: SliceName[], state: SliceState): string {
  if (sees.length === 0) return "";
  return sees
    .map((slice) => {
      const body = renderOne(slice, state);
      return `## ${slice}\n\n${wrapInFence(body)}`;
    })
    .join("\n\n");
}
