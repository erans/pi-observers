import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  ALLOWED_TOOLS,
  CAPABILITIES,
  DEFAULTS,
  DELIVERY_POINTS,
  SLICE_NAMES,
  TRIGGER_EVENTS,
  isAllowedTool,
  type AllowedTool,
  type Capability,
  type DeliveryPoint,
  type ObserverDefinition,
  type ObserverScope,
  type SliceName,
  type ThinkingLevel,
  type TriggerEvent,
} from "./types.ts";

export class ObserverDefinitionError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ObserverDefinitionError";
  }
}

export const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "enabled",
  "on",
  "sees",
  "tools",
  "can",
  "deliver",
  "model",
  "fallback",
  "thinking",
  "priority",
  "max_advisory_chars",
  "timeout_ms",
]);

const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

type Raw = Record<string, unknown>;

function fail(file: string, field: string | undefined, message: string): never {
  throw new ObserverDefinitionError(message, file, field);
}

/** Frontmatter list fields accept a YAML list or a comma-separated string. */
function asList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return undefined;
}

function requireString(raw: Raw, key: string, file: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(file, key, `Observer file is missing required field "${key}".`);
  }
  return value.trim();
}

function oneOf<T extends string>(
  raw: Raw,
  key: string,
  allowed: readonly T[],
  file: string,
  fallbackValue?: T,
): T {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (fallbackValue !== undefined) return fallbackValue;
    fail(file, key, `Observer file is missing required field "${key}".`);
  }
  const str = String(value).trim();
  if (!(allowed as readonly string[]).includes(str)) {
    fail(file, key, `"${str}" is not a valid ${key}. Expected one of: ${allowed.join(", ")}.`);
  }
  return str as T;
}

function manyOf<T extends string>(
  raw: Raw,
  key: string,
  allowed: readonly T[],
  file: string,
  fallbackValue: T[],
): T[] {
  const list = asList(raw[key]);
  if (list === undefined) return fallbackValue;
  for (const item of list) {
    if (!(allowed as readonly string[]).includes(item)) {
      fail(file, key, `"${item}" is not a valid ${key} entry. Expected one of: ${allowed.join(", ")}.`);
    }
  }
  return list as T[];
}

function positiveInt(raw: Raw, key: string, file: string, fallbackValue: number): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallbackValue;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    fail(file, key, `"${key}" must be a positive integer, got ${String(value)}.`);
  }
  return num;
}

export function parseObserverDefinition(
  content: string,
  sourcePath: string,
  scope: ObserverScope,
): ObserverDefinition {
  const { frontmatter, body } = parseFrontmatter<Raw>(content);
  const raw = frontmatter ?? {};

  // A typo'd field that silently does nothing is worse than a startup complaint.
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      fail(sourcePath, key, `Unknown field "${key}" in observer definition.`);
    }
  }

  const name = requireString(raw, "name", sourcePath);
  const description = requireString(raw, "description", sourcePath);
  const on = oneOf<TriggerEvent>(raw, "on", TRIGGER_EVENTS, sourcePath);

  const tools = manyOf<string>(raw, "tools", [...ALLOWED_TOOLS, "write", "edit", "bash"], sourcePath, []);
  for (const tool of tools) {
    if (!isAllowedTool(tool)) {
      fail(
        sourcePath,
        "tools",
        `"${tool}" is not a permitted observer tool. Observers are read-only; allowed tools are: ${ALLOWED_TOOLS.join(", ")}.`,
      );
    }
  }

  const systemPrompt = body ?? "";
  if (systemPrompt.trim() === "") {
    fail(sourcePath, "systemPrompt", "Observer file has an empty body; a system prompt is required.");
  }

  const thinking = oneOf<ThinkingLevel>(
    raw,
    "thinking",
    THINKING_LEVELS as readonly ThinkingLevel[],
    sourcePath,
    DEFAULTS.thinking,
  );

  const modelRaw = raw.model;
  const model = typeof modelRaw === "string" && modelRaw.trim() !== "" ? modelRaw.trim() : undefined;

  return {
    name,
    description,
    enabled: raw.enabled === undefined ? DEFAULTS.enabled : Boolean(raw.enabled),
    on,
    sees: manyOf<SliceName>(raw, "sees", SLICE_NAMES, sourcePath, []),
    tools: tools as AllowedTool[],
    can: manyOf<Capability>(raw, "can", CAPABILITIES, sourcePath, ["advise"]),
    deliver: oneOf<DeliveryPoint>(raw, "deliver", DELIVERY_POINTS, sourcePath, DEFAULTS.deliver),
    model,
    fallback: asList(raw.fallback) ?? [],
    thinking,
    priority: positiveInt(raw, "priority", sourcePath, DEFAULTS.priority),
    maxAdvisoryChars: positiveInt(raw, "max_advisory_chars", sourcePath, DEFAULTS.maxAdvisoryChars),
    timeoutMs: positiveInt(raw, "timeout_ms", sourcePath, DEFAULTS.timeoutMs),
    systemPrompt,
    sourcePath,
    scope,
  };
}
