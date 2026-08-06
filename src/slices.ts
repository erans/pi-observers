import type { SliceName, SliceState, ToolCallRecord } from "./types.ts";

const UNAVAILABLE = "(unavailable)";

/**
 * SECURITY: Escape lines that look like markdown headers so attacker-controlled
 * content cannot forge section boundaries. Lines matching ^#{1,6}\s are prefixed
 * with a backslash, preventing them from parsing as headers.
 */
function escapeHeaderMarkers(content: string): string {
  return content.replace(/^(#{1,6}\s)/gm, "\\$1");
}

/**
 * SECURITY: Collapse multiline tool args into a single line so attacker-controlled
 * arguments cannot forge tool call entries. Newlines and carriage returns become spaces.
 */
function collapseMultilineArgs(args: string): string {
  return args.replace(/[\r\n]+/g, " ");
}

function renderToolCalls(calls: ToolCallRecord[]): string {
  if (calls.length === 0) return "(no tool calls this turn)";
  return calls
    .map((c) => `- ${c.name}(${collapseMultilineArgs(c.args)}) ${c.isError ? "ERROR" : "ok"}`)
    .join("\n");
}

function renderSkills(skills: Array<{ name: string; description: string }>): string {
  if (skills.length === 0) return "(no skills available)";
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

function renderOne(slice: SliceName, state: SliceState): string {
  switch (slice) {
    case "last_user_message":
      return escapeHeaderMarkers(state.lastUserMessage ?? UNAVAILABLE);
    case "last_assistant_message":
      return escapeHeaderMarkers(state.lastAssistantMessage ?? UNAVAILABLE);
    case "tool_calls_this_turn":
      return state.toolCallsThisTurn ? renderToolCalls(state.toolCallsThisTurn) : UNAVAILABLE;
    case "transcript":
      return escapeHeaderMarkers(state.transcript ?? UNAVAILABLE);
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
 * SECURITY INVARIANT: Slice content is escaped to prevent forging section
 * headers or tool call entries. Lines matching ^#{1,6}\s are prefixed with a
 * backslash so they cannot parse as markdown headers. Multiline tool args are
 * collapsed to single lines to prevent forging tool call entries. This ensures
 * an observer cannot be misled by attacker-controlled content.
 */
export function renderSlices(sees: SliceName[], state: SliceState): string {
  if (sees.length === 0) return "";
  return sees.map((slice) => `## ${slice}\n\n${renderOne(slice, state)}`).join("\n\n");
}
