export const TRIGGER_EVENTS = [
  "before_agent_start",
  "turn_end",
  "tool_execution_end",
  "agent_settled",
] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

export const SLICE_NAMES = [
  "last_user_message",
  "last_assistant_message",
  "tool_calls_this_turn",
  "transcript",
  "skills",
] as const;
export type SliceName = (typeof SLICE_NAMES)[number];

export const CAPABILITIES = ["advise", "veto"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const DELIVERY_POINTS = ["next_prompt", "next_turn", "settle"] as const;
export type DeliveryPoint = (typeof DELIVERY_POINTS)[number];

/** Read-only tools an observer may request. Enforced at load time. */
export const ALLOWED_TOOLS = ["read", "grep", "find", "ls"] as const;
export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export function isAllowedTool(name: string): name is AllowedTool {
  return (ALLOWED_TOOLS as readonly string[]).includes(name);
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ObserverScope = "builtin" | "user" | "project";

export interface ObserverDefinition {
  name: string;
  description: string;
  enabled: boolean;
  on: TriggerEvent;
  sees: SliceName[];
  tools: AllowedTool[];
  can: Capability[];
  deliver: DeliveryPoint;
  /** Undefined means "use settings defaultModel, else inherit the session model". */
  model?: string;
  fallback: string[];
  thinking: ThinkingLevel;
  priority: number;
  maxAdvisoryChars: number;
  timeoutMs: number;
  systemPrompt: string;
  sourcePath: string;
  scope: ObserverScope;
}

export interface Proposal {
  observer: string;
  kind: "advisory" | "veto";
  text: string;
  fingerprint: string;
  priority: number;
  deliver: DeliveryPoint;
}

export interface ToolCallRecord {
  name: string;
  args: string;
  isError: boolean;
}

export interface SliceState {
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  toolCallsThisTurn?: ToolCallRecord[];
  transcript?: string;
  skills?: Array<{ name: string; description: string }>;
}

export const DEFAULTS = {
  enabled: true,
  deliver: "next_prompt" as DeliveryPoint,
  thinking: "low" as ThinkingLevel,
  priority: 50,
  maxAdvisoryChars: 300,
  timeoutMs: 20000,
  maxAdvisoriesPerTurn: 2,
  vetoBudget: 3,
  maxConsecutiveFailures: 3,
} as const;
