import type { SliceName, SliceState, ToolCallRecord } from "./types.ts";

const UNAVAILABLE = "(unavailable)";

function renderToolCalls(calls: ToolCallRecord[]): string {
  if (calls.length === 0) return "(no tool calls this turn)";
  return calls.map((c) => `- ${c.name}(${c.args}) ${c.isError ? "ERROR" : "ok"}`).join("\n");
}

function renderSkills(skills: Array<{ name: string; description: string }>): string {
  if (skills.length === 0) return "(no skills available)";
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

function renderOne(slice: SliceName, state: SliceState): string {
  switch (slice) {
    case "last_user_message":
      return state.lastUserMessage ?? UNAVAILABLE;
    case "last_assistant_message":
      return state.lastAssistantMessage ?? UNAVAILABLE;
    case "tool_calls_this_turn":
      return state.toolCallsThisTurn ? renderToolCalls(state.toolCallsThisTurn) : UNAVAILABLE;
    case "transcript":
      return state.transcript ?? UNAVAILABLE;
    case "skills":
      return state.skills ? renderSkills(state.skills) : UNAVAILABLE;
  }
}

/**
 * Render the requested slices as labelled sections, in the order the observer
 * listed them. A slice with no data renders as an explicit "(unavailable)"
 * marker rather than vanishing, so the observer can tell the difference between
 * "nothing happened" and "you weren't shown this".
 */
export function renderSlices(sees: SliceName[], state: SliceState): string {
  if (sees.length === 0) return "";
  return sees.map((slice) => `## ${slice}\n\n${renderOne(slice, state)}`).join("\n\n");
}
