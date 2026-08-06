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

/**
 * Frontmatter list fields accept a YAML list or a comma-separated string.
 * Returns undefined only if the value is absent (undefined or null).
 * Returns an array if the value is present and valid (array or string).
 * Returns "invalid" if the value is present but of wrong type (object, number, boolean, etc.).
 */
function asList(value: unknown): string[] | "invalid" | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  // Present but wrong type (object, number, boolean, etc.)
  return "invalid";
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
  if (list === "invalid") {
    fail(file, key, `"${key}" must be a list or comma-separated string, got ${typeof raw[key]}.`);
  }
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

function parseEnabled(raw: Raw, file: string): boolean {
  const value = raw.enabled;
  if (value === undefined || value === null) return DEFAULTS.enabled;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  fail(file, "enabled", `"enabled" must be a boolean or the string "true"/"false", got ${typeof value}.`);
}

function parseModel(raw: Raw, file: string): string | undefined {
  const modelRaw = raw.model;
  if (modelRaw === undefined || modelRaw === null) return undefined;
  if (typeof modelRaw === "string" && modelRaw.trim() !== "") {
    return modelRaw.trim();
  }
  if (typeof modelRaw === "string" && modelRaw.trim() === "") {
    return undefined;
  }
  fail(file, "model", `"model" must be a string, got ${typeof modelRaw}.`);
}

export function parseObserverDefinition(
  content: string,
  sourcePath: string,
  scope: ObserverScope,
): ObserverDefinition {
  let frontmatter: Raw;
  let body: string | undefined;
  try {
    const result = parseFrontmatter<Raw>(content);
    frontmatter = result.frontmatter ?? {};
    body = result.body;
  } catch (err) {
    const yamlError = err instanceof Error ? err.message : String(err);
    fail(sourcePath, "frontmatter", `Invalid YAML in frontmatter: ${yamlError}`);
  }

  // A typo'd field that silently does nothing is worse than a startup complaint.
  for (const key of Object.keys(frontmatter)) {
    if (!KNOWN_FIELDS.has(key)) {
      fail(sourcePath, key, `Unknown field "${key}" in observer definition.`);
    }
  }

  const name = requireString(frontmatter, "name", sourcePath);
  const description = requireString(frontmatter, "description", sourcePath);
  const on = oneOf<TriggerEvent>(frontmatter, "on", TRIGGER_EVENTS, sourcePath);

  const tools = manyOf<string>(frontmatter, "tools", [...ALLOWED_TOOLS, "write", "edit", "bash"], sourcePath, []);
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
    frontmatter,
    "thinking",
    THINKING_LEVELS as readonly ThinkingLevel[],
    sourcePath,
    DEFAULTS.thinking,
  );

  const model = parseModel(frontmatter, sourcePath);

  const fallback = asList(frontmatter.fallback);
  if (fallback === "invalid") {
    fail(sourcePath, "fallback", `"fallback" must be a list or comma-separated string, got ${typeof frontmatter.fallback}.`);
  }
  const fallbackList = fallback ?? [];

  return {
    name,
    description,
    enabled: parseEnabled(frontmatter, sourcePath),
    on,
    sees: manyOf<SliceName>(frontmatter, "sees", SLICE_NAMES, sourcePath, []),
    tools: tools as AllowedTool[],
    can: manyOf<Capability>(frontmatter, "can", CAPABILITIES, sourcePath, ["advise"]),
    deliver: oneOf<DeliveryPoint>(frontmatter, "deliver", DELIVERY_POINTS, sourcePath, DEFAULTS.deliver),
    model,
    fallback: fallbackList,
    thinking,
    priority: positiveInt(frontmatter, "priority", sourcePath, DEFAULTS.priority),
    maxAdvisoryChars: positiveInt(frontmatter, "max_advisory_chars", sourcePath, DEFAULTS.maxAdvisoryChars),
    timeoutMs: positiveInt(frontmatter, "timeout_ms", sourcePath, DEFAULTS.timeoutMs),
    systemPrompt,
    sourcePath,
    scope,
  };
}
