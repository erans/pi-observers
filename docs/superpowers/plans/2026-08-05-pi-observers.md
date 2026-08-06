# pi-observers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pi extension that runs file-defined, read-only observer agents alongside the main session; each proposes at most a short advisory, and a reconciler decides what reaches the main agent.

**Architecture:** An observer is a markdown file with YAML frontmatter declaring when it wakes (`on:`), what session state it sees (`sees:`), which read-only tools it may use, and whether it may advise or veto. At `session_start` the extension discovers definitions, resolves each to a model, and creates one persistent in-memory `AgentSession` per observer. Trigger events kick observers fire-and-forget; they emit via `propose`/`veto` tools into a queue; delivery points drain the queue, run it through a pure reconciler, and inject at most a couple of lines.

**Tech Stack:** TypeScript (ESM, no build step at runtime — pi loads `.ts` via jiti), `@earendil-works/pi-coding-agent` (peer), `typebox` for tool schemas, vitest for tests, biome for lint.

## Global Constraints

- Package name: `pi-observers`. Extension entry declared as `pi.extensions: ["./src/index.ts"]`.
- Peer deps, not deps: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, all `>=0.83.0`.
- Runtime deps go in `dependencies` — `pi install` runs `npm install --omit=dev`, so `devDependencies` are absent at runtime.
- Never hardcode `.pi`. Use `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent` for project paths and `getAgentDir()` for the global dir.
- Observer tool allowlist is exactly `read`, `grep`, `find`, `ls`. Anything else is a load-time error.
- No lifecycle handler may ever `await` an observer run.
- Observer sessions must use a hermetic `DefaultResourceLoader` (`noExtensions: true`, `noSkills: true`, `noPromptTemplates: true`, `noThemes: true`, `noContextFiles: true`). Omitting this makes pi load this extension inside its own observer sessions, recursively.
- Observer sessions use `SessionManager.inMemory(cwd)` — observer conversations are never written to the session directory.
- Use `StringEnum` from `@earendil-works/pi-ai` for enum tool parameters, never `Type.Union`/`Type.Literal` (Google API compatibility).
- Tool `execute` signals errors by throwing, never by returning an error object.
- Reconciler defaults: `maxAdvisoriesPerTurn: 2`, `vetoBudget: 3`, `max_advisory_chars: 300`, `timeout_ms: 20000`, `priority: 50`.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `biome.json` | toolchain |
| `src/types.ts` | shared types and constants; no logic |
| `src/definitions.ts` | parse + validate one observer file |
| `src/discovery.ts` | find files across three scopes, apply precedence |
| `src/models.ts` | model resolution + fallback chain |
| `src/slices.ts` | render `sees:` into prompt sections |
| `src/outputs.ts` | `propose` / `veto` tool definitions |
| `src/reconciler.ts` | dedupe, rank, budget, veto arbitration |
| `src/bus.ts` | fire-and-forget scheduling, timeout, failure tracking |
| `src/runner.ts` | persistent nested `AgentSession` per observer |
| `src/settings.ts` | read + merge the `observers` settings block |
| `src/memory.ts` | `.pi/memory` note writing + slug derivation |
| `src/commands.ts` | `/observers`, `/goal`, `/remember` |
| `src/index.ts` | extension factory: wiring, lifecycle, injection points |
| `observers/*.md` | four bundled observer definitions |

Tests live in `test/<name>.test.ts` mirroring `src/`.

---

## Task 1: Package scaffold and core types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `biome.json`, `.gitignore`
- Create: `src/types.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: all shared types used by every later task — `TriggerEvent`, `SliceName`, `Capability`, `DeliveryPoint`, `AllowedTool`, `ALLOWED_TOOLS`, `ObserverDefinition`, `Proposal`, `SliceState`, `DEFAULTS`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pi-observers",
  "version": "0.1.0",
  "description": "File-defined observer agents for pi: they propose, a reconciler decides.",
  "type": "module",
  "license": "MIT",
  "keywords": ["pi-package", "pi", "pi-extension", "observer", "agent"],
  "dependencies": {
    "typebox": "^1.3.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": ">=0.83.0",
    "@earendil-works/pi-coding-agent": ">=0.83.0",
    "@earendil-works/pi-tui": ">=0.83.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/ test/"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "files": ["src", "observers", "README.md"]
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`, `biome.json`, `.gitignore`**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.0/schema.json",
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } }
}
```

`.gitignore`:
```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 4: Write the failing test**

`test/types.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, DEFAULTS, isAllowedTool } from "../src/types.ts";

describe("types", () => {
  it("allows exactly the four read-only tools", () => {
    expect([...ALLOWED_TOOLS]).toEqual(["read", "grep", "find", "ls"]);
  });

  it("rejects mutating tools", () => {
    expect(isAllowedTool("read")).toBe(true);
    expect(isAllowedTool("write")).toBe(false);
    expect(isAllowedTool("edit")).toBe(false);
    expect(isAllowedTool("bash")).toBe(false);
  });

  it("carries the spec's default values", () => {
    expect(DEFAULTS.priority).toBe(50);
    expect(DEFAULTS.maxAdvisoryChars).toBe(300);
    expect(DEFAULTS.timeoutMs).toBe(20000);
    expect(DEFAULTS.maxAdvisoriesPerTurn).toBe(2);
    expect(DEFAULTS.vetoBudget).toBe(3);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm install && npx vitest run test/types.test.ts`
Expected: FAIL — `Cannot find module '../src/types.ts'`

- [ ] **Step 6: Write `src/types.ts`**

```ts
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
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/types.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts biome.json .gitignore src/types.ts test/types.test.ts package-lock.json
git commit -m "feat: scaffold pi-observers package and core types"
```

---

## Task 2: Observer definition parsing and validation

**Files:**
- Create: `src/definitions.ts`
- Test: `test/definitions.test.ts`

**Interfaces:**
- Consumes: `ObserverDefinition`, `DEFAULTS`, `ALLOWED_TOOLS`, `isAllowedTool`, `TRIGGER_EVENTS`, `SLICE_NAMES`, `CAPABILITIES`, `DELIVERY_POINTS` from `src/types.ts`.
- Produces:
  - `class ObserverDefinitionError extends Error { readonly file: string; readonly field?: string }`
  - `parseObserverDefinition(content: string, sourcePath: string, scope: ObserverScope): ObserverDefinition` — throws `ObserverDefinitionError` on any invalid input.
  - `KNOWN_FIELDS: ReadonlySet<string>`

- [ ] **Step 1: Write the failing test**

`test/definitions.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ObserverDefinitionError, parseObserverDefinition } from "../src/definitions.ts";

const VALID = `---
name: goal-tracker
description: Hold the agent to a declared goal
on: agent_settled
sees: [last_user_message, transcript]
tools: [read, grep]
can: [advise, veto]
deliver: settle
model: lunaroute/deepseek-v4-flash
fallback: [anthropic/claude-haiku-4-5]
thinking: low
priority: 80
max_advisory_chars: 250
timeout_ms: 15000
---
Watch the goal.
`;

function parse(src: string) {
  return parseObserverDefinition(src, "/o/goal-tracker.md", "project");
}

describe("parseObserverDefinition", () => {
  it("parses a full definition", () => {
    const d = parse(VALID);
    expect(d.name).toBe("goal-tracker");
    expect(d.on).toBe("agent_settled");
    expect(d.sees).toEqual(["last_user_message", "transcript"]);
    expect(d.tools).toEqual(["read", "grep"]);
    expect(d.can).toEqual(["advise", "veto"]);
    expect(d.deliver).toBe("settle");
    expect(d.model).toBe("lunaroute/deepseek-v4-flash");
    expect(d.fallback).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(d.priority).toBe(80);
    expect(d.maxAdvisoryChars).toBe(250);
    expect(d.timeoutMs).toBe(15000);
    expect(d.systemPrompt.trim()).toBe("Watch the goal.");
    expect(d.scope).toBe("project");
    expect(d.sourcePath).toBe("/o/goal-tracker.md");
  });

  it("applies defaults for omitted optional fields", () => {
    const d = parse(`---
name: minimal
description: A minimal observer
on: turn_end
---
Body.
`);
    expect(d.enabled).toBe(true);
    expect(d.sees).toEqual([]);
    expect(d.tools).toEqual([]);
    expect(d.can).toEqual(["advise"]);
    expect(d.deliver).toBe("next_prompt");
    expect(d.thinking).toBe("low");
    expect(d.priority).toBe(50);
    expect(d.maxAdvisoryChars).toBe(300);
    expect(d.timeoutMs).toBe(20000);
    expect(d.model).toBeUndefined();
    expect(d.fallback).toEqual([]);
  });

  it.each([
    ["missing name", `---\ndescription: d\non: turn_end\n---\nb`, "name"],
    ["missing description", `---\nname: n\non: turn_end\n---\nb`, "description"],
    ["missing on", `---\nname: n\ndescription: d\n---\nb`, "on"],
    ["bad trigger", `---\nname: n\ndescription: d\non: nope\n---\nb`, "on"],
    ["bad slice", `---\nname: n\ndescription: d\non: turn_end\nsees: [nope]\n---\nb`, "sees"],
    ["bad deliver", `---\nname: n\ndescription: d\non: turn_end\ndeliver: nope\n---\nb`, "deliver"],
    ["bad capability", `---\nname: n\ndescription: d\non: turn_end\ncan: [destroy]\n---\nb`, "can"],
    ["unknown field", `---\nname: n\ndescription: d\non: turn_end\nwibble: 1\n---\nb`, "wibble"],
    ["empty body", `---\nname: n\ndescription: d\non: turn_end\n---\n   \n`, "systemPrompt"],
  ])("rejects %s", (_label, src, field) => {
    expect(() => parse(src)).toThrow(ObserverDefinitionError);
    try {
      parse(src);
    } catch (e) {
      expect((e as ObserverDefinitionError).field).toBe(field);
      expect((e as ObserverDefinitionError).file).toBe("/o/goal-tracker.md");
    }
  });

  it.each(["write", "edit", "bash"])("rejects the mutating tool %s", (tool) => {
    const src = `---\nname: n\ndescription: d\non: turn_end\ntools: [read, ${tool}]\n---\nb`;
    expect(() => parse(src)).toThrow(/not a permitted observer tool/);
  });

  it("rejects a non-positive timeout", () => {
    const src = `---\nname: n\ndescription: d\non: turn_end\ntimeout_ms: 0\n---\nb`;
    expect(() => parse(src)).toThrow(/timeout_ms/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/definitions.test.ts`
Expected: FAIL — `Cannot find module '../src/definitions.ts'`

- [ ] **Step 3: Write `src/definitions.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/definitions.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/definitions.ts test/definitions.test.ts
git commit -m "feat: parse and validate observer definition files"
```

---

## Task 3: Discovery and three-layer precedence

**Files:**
- Create: `src/discovery.ts`
- Test: `test/discovery.test.ts`

**Interfaces:**
- Consumes: `parseObserverDefinition`, `ObserverDefinitionError` from `src/definitions.ts`; `ObserverDefinition` from `src/types.ts`.
- Produces:
  - `interface DiscoveryResult { observers: ObserverDefinition[]; errors: ObserverDefinitionError[] }`
  - `discoverObservers(opts: { cwd: string; agentDir: string; builtinDir: string }): DiscoveryResult` — precedence project > user > builtin, keyed on `name`.

- [ ] **Step 1: Write the failing test**

`test/discovery.test.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { discoverObservers } from "../src/discovery.ts";

function def(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\non: turn_end\n---\nBody for ${name}.\n`;
}

let root: string;
let builtinDir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-observers-"));
  builtinDir = join(root, "builtin");
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  for (const d of [builtinDir, join(agentDir, "observers"), join(cwd, ".pi", "observers")]) {
    mkdirSync(d, { recursive: true });
  }
});

describe("discoverObservers", () => {
  it("loads builtins when nothing overrides them", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
    const { observers, errors } = discoverObservers({ cwd, agentDir, builtinDir });
    expect(errors).toEqual([]);
    expect(observers.map((o) => o.name)).toEqual(["a"]);
    expect(observers[0]?.scope).toBe("builtin");
  });

  it("lets user override builtin, and project override user", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
    writeFileSync(join(agentDir, "observers", "a.md"), def("a", "user a"));
    const userWins = discoverObservers({ cwd, agentDir, builtinDir });
    expect(userWins.observers[0]?.description).toBe("user a");
    expect(userWins.observers[0]?.scope).toBe("user");

    writeFileSync(join(cwd, ".pi", "observers", "a.md"), def("a", "project a"));
    const projectWins = discoverObservers({ cwd, agentDir, builtinDir });
    expect(projectWins.observers[0]?.description).toBe("project a");
    expect(projectWins.observers[0]?.scope).toBe("project");
  });

  it("overriding one observer leaves the others alone", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "builtin a"));
    writeFileSync(join(builtinDir, "b.md"), def("b", "builtin b"));
    writeFileSync(join(agentDir, "observers", "a.md"), def("a", "user a"));
    const { observers } = discoverObservers({ cwd, agentDir, builtinDir });
    const byName = Object.fromEntries(observers.map((o) => [o.name, o.description]));
    expect(byName).toEqual({ a: "user a", b: "builtin b" });
  });

  it("matches on the name field, not the filename", () => {
    writeFileSync(join(builtinDir, "a.md"), def("shared", "builtin"));
    writeFileSync(join(agentDir, "observers", "totally-different.md"), def("shared", "user"));
    const { observers } = discoverObservers({ cwd, agentDir, builtinDir });
    expect(observers).toHaveLength(1);
    expect(observers[0]?.description).toBe("user");
  });

  it("collects a bad file as an error and still loads the good ones", () => {
    writeFileSync(join(builtinDir, "good.md"), def("good", "fine"));
    writeFileSync(join(builtinDir, "bad.md"), `---\nname: bad\n---\nno description or trigger`);
    const { observers, errors } = discoverObservers({ cwd, agentDir, builtinDir });
    expect(observers.map((o) => o.name)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toContain("bad.md");
  });

  it("returns empty when no directories exist", () => {
    const result = discoverObservers({
      cwd: join(root, "nope"),
      agentDir: join(root, "nope"),
      builtinDir: join(root, "nope"),
    });
    expect(result.observers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("ignores non-markdown files", () => {
    writeFileSync(join(builtinDir, "a.md"), def("a", "yes"));
    writeFileSync(join(builtinDir, "notes.txt"), "ignore me");
    const { observers } = discoverObservers({ cwd, agentDir, builtinDir });
    expect(observers).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/discovery.test.ts`
Expected: FAIL — `Cannot find module '../src/discovery.ts'`

- [ ] **Step 3: Write `src/discovery.ts`**

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { ObserverDefinitionError, parseObserverDefinition } from "./definitions.ts";
import type { ObserverDefinition, ObserverScope } from "./types.ts";

export interface DiscoveryOptions {
  cwd: string;
  agentDir: string;
  builtinDir: string;
}

export interface DiscoveryResult {
  observers: ObserverDefinition[];
  errors: ObserverDefinitionError[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function loadDir(dir: string, scope: ObserverScope, errors: ObserverDefinitionError[]) {
  const found: ObserverDefinition[] = [];
  if (!isDirectory(dir)) return found;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      found.push(parseObserverDefinition(readFileSync(path, "utf8"), path, scope));
    } catch (error) {
      errors.push(
        error instanceof ObserverDefinitionError
          ? error
          : new ObserverDefinitionError(String(error), path),
      );
    }
  }
  return found;
}

/**
 * Discover observer definitions across all three scopes.
 *
 * Precedence is project > user > builtin, keyed on the `name` field rather than
 * the filename, so an override does not have to reuse the shipped filename.
 * Overriding one observer never disturbs the others.
 */
export function discoverObservers(opts: DiscoveryOptions): DiscoveryResult {
  const errors: ObserverDefinitionError[] = [];

  const layers: Array<[string, ObserverScope]> = [
    [opts.builtinDir, "builtin"],
    [join(opts.agentDir, "observers"), "user"],
    [join(opts.cwd, CONFIG_DIR_NAME, "observers"), "project"],
  ];

  const byName = new Map<string, ObserverDefinition>();
  for (const [dir, scope] of layers) {
    for (const definition of loadDir(dir, scope, errors)) {
      byName.set(definition.name, definition);
    }
  }

  return { observers: [...byName.values()], errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/discovery.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/discovery.ts test/discovery.test.ts
git commit -m "feat: discover observer definitions with three-layer precedence"
```

---

## Task 4: Model resolution and fallback chain

**Files:**
- Create: `src/models.ts`
- Test: `test/models.test.ts`

**Interfaces:**
- Consumes: `ObserverDefinition` from `src/types.ts`.
- Produces:
  - `interface ModelLike { provider: string; id: string }`
  - `interface ModelLookup { find(provider: string, id: string): ModelLike | undefined; all(): ModelLike[] }`
  - `type ModelResolution = { status: "resolved"; model: ModelLike; via: ResolutionStep } | { status: "disabled"; reason: string }`
  - `type ResolutionStep = "exact" | "fuzzy" | "any-provider" | "fallback" | "session"`
  - `resolveObserverModel(def, lookup, opts: { defaultModel?: string; sessionModel?: ModelLike }): ModelResolution`
  - `normalizeModelId(id: string): string`

- [ ] **Step 1: Write the failing test**

`test/models.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeModelId, resolveObserverModel, type ModelLike, type ModelLookup } from "../src/models.ts";
import type { ObserverDefinition } from "../src/types.ts";

function lookupOf(models: ModelLike[]): ModelLookup {
  return {
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    all: () => models,
  };
}

function defOf(over: Partial<ObserverDefinition>): ObserverDefinition {
  return {
    name: "o", description: "d", enabled: true, on: "turn_end", sees: [], tools: [],
    can: ["advise"], deliver: "next_prompt", fallback: [], thinking: "low", priority: 50,
    maxAdvisoryChars: 300, timeoutMs: 20000, systemPrompt: "b", sourcePath: "/o.md",
    scope: "builtin", ...over,
  };
}

const SESSION: ModelLike = { provider: "openai-codex", id: "gpt-5.6-sol" };

describe("normalizeModelId", () => {
  it("treats . and - as equivalent and drops a trailing date stamp", () => {
    expect(normalizeModelId("claude-haiku-4.5")).toBe(normalizeModelId("claude-haiku-4-5"));
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe(normalizeModelId("claude-haiku-4-5"));
  });
});

describe("resolveObserverModel", () => {
  it("step 1: exact match wins", () => {
    const lookup = lookupOf([{ provider: "lunaroute", id: "deepseek-v4-flash" }]);
    const r = resolveObserverModel(defOf({ model: "lunaroute/deepseek-v4-flash" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "exact" });
  });

  it("step 2: fuzzy match under the named provider", () => {
    const lookup = lookupOf([{ provider: "anthropic", id: "claude-haiku-4-5-20251001" }]);
    const r = resolveObserverModel(defOf({ model: "anthropic/claude-haiku-4.5" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "fuzzy" });
    if (r.status === "resolved") expect(r.model.id).toBe("claude-haiku-4-5-20251001");
  });

  it("step 3: same bare id under a different provider", () => {
    const lookup = lookupOf([{ provider: "bedrock", id: "claude-haiku-4-5" }]);
    const r = resolveObserverModel(defOf({ model: "anthropic/claude-haiku-4-5" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "any-provider" });
    if (r.status === "resolved") expect(r.model.provider).toBe("bedrock");
  });

  it("step 4: falls back in listed order", () => {
    const lookup = lookupOf([{ provider: "anthropic", id: "claude-haiku-4-5" }]);
    const r = resolveObserverModel(
      defOf({ model: "lunaroute/gone", fallback: ["also/gone", "anthropic/claude-haiku-4-5"] }),
      lookup,
      {},
    );
    expect(r).toMatchObject({ status: "resolved", via: "fallback" });
  });

  it("step 5: falls back to the session model", () => {
    const lookup = lookupOf([SESSION]);
    const r = resolveObserverModel(defOf({ model: "nope/nope" }), lookup, { sessionModel: SESSION });
    expect(r).toMatchObject({ status: "resolved", via: "session" });
  });

  it("step 6: disables when nothing resolves and there is no session model", () => {
    const r = resolveObserverModel(defOf({ model: "nope/nope" }), lookupOf([]), {});
    expect(r.status).toBe("disabled");
    if (r.status === "disabled") expect(r.reason).toContain("nope/nope");
  });

  it("substitutes settings defaultModel when the file omits model", () => {
    const lookup = lookupOf([{ provider: "lunaroute", id: "deepseek-v4-flash" }]);
    const r = resolveObserverModel(defOf({}), lookup, {
      defaultModel: "lunaroute/deepseek-v4-flash",
    });
    expect(r).toMatchObject({ status: "resolved", via: "exact" });
  });

  it("starts at the session model when neither file nor settings name one", () => {
    const r = resolveObserverModel(defOf({}), lookupOf([SESSION]), { sessionModel: SESSION });
    expect(r).toMatchObject({ status: "resolved", via: "session" });
  });

  it("accepts a bare model id with no provider", () => {
    const lookup = lookupOf([{ provider: "anthropic", id: "claude-haiku-4-5" }]);
    const r = resolveObserverModel(defOf({ model: "claude-haiku-4-5" }), lookup, {});
    expect(r).toMatchObject({ status: "resolved", via: "any-provider" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/models.test.ts`
Expected: FAIL — `Cannot find module '../src/models.ts'`

- [ ] **Step 3: Write `src/models.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/models.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/models.ts test/models.test.ts
git commit -m "feat: resolve observer models with a fallback chain"
```

---

## Task 5: Context slice rendering

**Files:**
- Create: `src/slices.ts`
- Test: `test/slices.test.ts`

**Interfaces:**
- Consumes: `SliceName`, `SliceState`, `ToolCallRecord` from `src/types.ts`.
- Produces: `renderSlices(sees: SliceName[], state: SliceState): string`

- [ ] **Step 1: Write the failing test**

`test/slices.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { renderSlices } from "../src/slices.ts";

describe("renderSlices", () => {
  it("renders nothing for an empty sees list", () => {
    expect(renderSlices([], { lastUserMessage: "hi" })).toBe("");
  });

  it("renders sections in the order listed, not a fixed order", () => {
    const out = renderSlices(["transcript", "last_user_message"], {
      lastUserMessage: "hello",
      transcript: "T",
    });
    expect(out.indexOf("## transcript")).toBeLessThan(out.indexOf("## last_user_message"));
  });

  it("marks a missing slice unavailable rather than omitting it", () => {
    const out = renderSlices(["last_assistant_message"], {});
    expect(out).toContain("## last_assistant_message");
    expect(out).toContain("(unavailable)");
  });

  it("formats tool calls with name, args and error status", () => {
    const out = renderSlices(["tool_calls_this_turn"], {
      toolCallsThisTurn: [
        { name: "bash", args: "npm test", isError: false },
        { name: "read", args: "src/a.ts", isError: true },
      ],
    });
    expect(out).toContain("bash(npm test) ok");
    expect(out).toContain("read(src/a.ts) ERROR");
  });

  it("says so explicitly when there were no tool calls", () => {
    const out = renderSlices(["tool_calls_this_turn"], { toolCallsThisTurn: [] });
    expect(out).toContain("(no tool calls this turn)");
    expect(out).not.toContain("(unavailable)");
  });

  it("formats skills as name + description", () => {
    const out = renderSlices(["skills"], {
      skills: [{ name: "brainstorming", description: "Explore ideas" }],
    });
    expect(out).toContain("brainstorming: Explore ideas");
  });

  it("says so explicitly when no skills are available", () => {
    const out = renderSlices(["skills"], { skills: [] });
    expect(out).toContain("(no skills available)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/slices.test.ts`
Expected: FAIL — `Cannot find module '../src/slices.ts'`

- [ ] **Step 3: Write `src/slices.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/slices.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/slices.ts test/slices.test.ts
git commit -m "feat: render context slices into observer prompts"
```

---

## Task 6: Output tools (`propose` / `veto`)

**Files:**
- Create: `src/outputs.ts`
- Test: `test/outputs.test.ts`

**Interfaces:**
- Consumes: `Capability`, `ObserverDefinition`, `Proposal` from `src/types.ts`.
- Produces:
  - `interface ProposalCollector { take(): Proposal | null; warnings: string[] }`
  - `createOutputTools(def: ObserverDefinition): { tools: ToolDefinition[]; collector: ProposalCollector }`

Note: `execute` receives `(toolCallId, params, signal, onUpdate, ctx)`. Errors are thrown, not returned.

- [ ] **Step 1: Write the failing test**

`test/outputs.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createOutputTools } from "../src/outputs.ts";
import type { ObserverDefinition } from "../src/types.ts";

function defOf(over: Partial<ObserverDefinition> = {}): ObserverDefinition {
  return {
    name: "o", description: "d", enabled: true, on: "turn_end", sees: [], tools: [],
    can: ["advise"], deliver: "next_prompt", fallback: [], thinking: "low", priority: 70,
    maxAdvisoryChars: 20, timeoutMs: 20000, systemPrompt: "b", sourcePath: "/o.md",
    scope: "builtin", ...over,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test harness for the tool execute signature
const call = (tool: any, params: unknown) => tool.execute("id", params, undefined, undefined, {} as any);

describe("createOutputTools", () => {
  it("registers only propose when can is [advise]", () => {
    const { tools } = createOutputTools(defOf({ can: ["advise"] }));
    expect(tools.map((t) => t.name)).toEqual(["propose"]);
  });

  it("registers veto only when can includes it", () => {
    const { tools } = createOutputTools(defOf({ can: ["advise", "veto"] }));
    expect(tools.map((t) => t.name).sort()).toEqual(["propose", "veto"]);
  });

  it("collects a proposal carrying the observer's name, priority and deliver", async () => {
    const { tools, collector } = createOutputTools(defOf({ deliver: "settle", priority: 70 }));
    await call(tools[0], { advisory: "check the tests", fingerprint: "fp1" });
    expect(collector.take()).toEqual({
      observer: "o", kind: "advisory", text: "check the tests",
      fingerprint: "fp1", priority: 70, deliver: "settle",
    });
  });

  it("returns null when nothing was proposed", () => {
    const { collector } = createOutputTools(defOf());
    expect(collector.take()).toBeNull();
  });

  it("throws when the advisory exceeds max_advisory_chars", async () => {
    const { tools } = createOutputTools(defOf({ maxAdvisoryChars: 10 }));
    await expect(call(tools[0], { advisory: "x".repeat(11), fingerprint: "fp" })).rejects.toThrow(
      /exceeds max_advisory_chars/,
    );
  });

  it("ignores a second call and records a warning", async () => {
    const { tools, collector } = createOutputTools(defOf());
    await call(tools[0], { advisory: "first", fingerprint: "a" });
    await call(tools[0], { advisory: "second", fingerprint: "b" });
    expect(collector.take()?.text).toBe("first");
    expect(collector.warnings.join()).toMatch(/already proposed/);
  });

  it("marks a veto with kind veto", async () => {
    const { tools, collector } = createOutputTools(defOf({ can: ["veto"] }));
    const veto = tools.find((t) => t.name === "veto");
    await call(veto, { reason: "tests not run", fingerprint: "g1" });
    expect(collector.take()).toMatchObject({ kind: "veto", text: "tests not run" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/outputs.test.ts`
Expected: FAIL — `Cannot find module '../src/outputs.ts'`

- [ ] **Step 3: Write `src/outputs.ts`**

```ts
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

  const record = (kind: Proposal["kind"], text: string, fingerprint: string) => {
    if (proposal) {
      warnings.push(`${def.name} already proposed this run; ignoring the extra ${kind}.`);
      return `Ignored: ${def.name} has already emitted once this run.`;
    }
    if (text.length > def.maxAdvisoryChars) {
      throw new Error(
        `Text is ${text.length} chars, which exceeds max_advisory_chars (${def.maxAdvisoryChars}). Be brief.`,
      );
    }
    proposal = {
      observer: def.name,
      kind,
      text,
      fingerprint,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/outputs.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/outputs.ts test/outputs.test.ts
git commit -m "feat: add propose and veto output tools for observers"
```

---

## Task 7: Reconciler

**Files:**
- Create: `src/reconciler.ts`
- Test: `test/reconciler.test.ts`

**Interfaces:**
- Consumes: `Proposal`, `DEFAULTS` from `src/types.ts`.
- Produces:
  - `interface ReconcileResult { advisories: Proposal[]; veto: Proposal | null; dropped: Array<{ proposal: Proposal; reason: string }> }`
  - `class Reconciler { constructor(opts?: { maxAdvisoriesPerTurn?: number; vetoBudget?: number }); reconcile(proposals: Proposal[]): ReconcileResult; restore(fingerprints: string[]): void; accepted(): string[] }`

- [ ] **Step 1: Write the failing test**

`test/reconciler.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Reconciler } from "../src/reconciler.ts";
import type { Proposal } from "../src/types.ts";

function p(over: Partial<Proposal> = {}): Proposal {
  return {
    observer: "o", kind: "advisory", text: "t", fingerprint: "fp",
    priority: 50, deliver: "next_prompt", ...over,
  };
}

describe("Reconciler", () => {
  it("passes a single advisory through", () => {
    const r = new Reconciler();
    expect(r.reconcile([p()]).advisories).toHaveLength(1);
  });

  it("caps advisories at maxAdvisoriesPerTurn, keeping the highest priority", () => {
    const r = new Reconciler({ maxAdvisoriesPerTurn: 2 });
    const out = r.reconcile([
      p({ fingerprint: "a", priority: 10 }),
      p({ fingerprint: "b", priority: 90 }),
      p({ fingerprint: "c", priority: 50 }),
    ]);
    expect(out.advisories.map((x) => x.fingerprint)).toEqual(["b", "c"]);
    expect(out.dropped.map((d) => d.proposal.fingerprint)).toEqual(["a"]);
  });

  it("drops a fingerprint already accepted earlier in the session", () => {
    const r = new Reconciler();
    expect(r.reconcile([p({ fingerprint: "x" })]).advisories).toHaveLength(1);
    const second = r.reconcile([p({ fingerprint: "x" })]);
    expect(second.advisories).toHaveLength(0);
    expect(second.dropped[0]?.reason).toMatch(/already/i);
  });

  it("does not mark dropped proposals as accepted", () => {
    const r = new Reconciler({ maxAdvisoriesPerTurn: 1 });
    r.reconcile([p({ fingerprint: "a", priority: 90 }), p({ fingerprint: "b", priority: 10 })]);
    // "b" was dropped for budget, not seen — it must still be eligible later.
    expect(r.reconcile([p({ fingerprint: "b", priority: 10 })]).advisories).toHaveLength(1);
  });

  it("returns at most one veto", () => {
    const r = new Reconciler();
    const out = r.reconcile([
      p({ kind: "veto", fingerprint: "v1", priority: 10 }),
      p({ kind: "veto", fingerprint: "v2", priority: 90 }),
    ]);
    expect(out.veto?.fingerprint).toBe("v2");
  });

  it("exhausts the veto budget per fingerprint", () => {
    const r = new Reconciler({ vetoBudget: 2 });
    const veto = () => r.reconcile([p({ kind: "veto", fingerprint: "g" })]).veto;
    expect(veto()).not.toBeNull();
    expect(veto()).not.toBeNull();
    expect(veto()).toBeNull();
  });

  it("keeps separate budgets for different veto fingerprints", () => {
    const r = new Reconciler({ vetoBudget: 1 });
    expect(r.reconcile([p({ kind: "veto", fingerprint: "g1" })]).veto).not.toBeNull();
    expect(r.reconcile([p({ kind: "veto", fingerprint: "g2" })]).veto).not.toBeNull();
  });

  it("restores accepted fingerprints so dedupe survives reload", () => {
    const r = new Reconciler();
    r.restore(["seen"]);
    expect(r.reconcile([p({ fingerprint: "seen" })]).advisories).toHaveLength(0);
  });

  it("reports accepted fingerprints for persistence", () => {
    const r = new Reconciler();
    r.reconcile([p({ fingerprint: "kept" })]);
    expect(r.accepted()).toEqual(["kept"]);
  });

  it("handles an empty input", () => {
    const out = new Reconciler().reconcile([]);
    expect(out).toEqual({ advisories: [], veto: null, dropped: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reconciler.test.ts`
Expected: FAIL — `Cannot find module '../src/reconciler.ts'`

- [ ] **Step 3: Write `src/reconciler.ts`**

```ts
import { DEFAULTS, type Proposal } from "./types.ts";

export interface ReconcileResult {
  advisories: Proposal[];
  veto: Proposal | null;
  dropped: Array<{ proposal: Proposal; reason: string }>;
}

export interface ReconcilerOptions {
  maxAdvisoriesPerTurn?: number;
  vetoBudget?: number;
}

/**
 * Decides which proposals reach the main agent.
 *
 * An observer proposes; this decides. Without a strict budget here the
 * "observers never answer for you" property degrades into several agents
 * talking over each other.
 */
export class Reconciler {
  readonly #maxAdvisories: number;
  readonly #vetoBudget: number;
  readonly #acceptedFingerprints = new Set<string>();
  readonly #vetoSpend = new Map<string, number>();

  constructor(opts: ReconcilerOptions = {}) {
    this.#maxAdvisories = opts.maxAdvisoriesPerTurn ?? DEFAULTS.maxAdvisoriesPerTurn;
    this.#vetoBudget = opts.vetoBudget ?? DEFAULTS.vetoBudget;
  }

  /** Rebuild dedupe state after a reload or resume. */
  restore(fingerprints: string[]): void {
    for (const fp of fingerprints) this.#acceptedFingerprints.add(fp);
  }

  accepted(): string[] {
    return [...this.#acceptedFingerprints];
  }

  reconcile(proposals: Proposal[]): ReconcileResult {
    const dropped: ReconcileResult["dropped"] = [];

    const fresh = proposals.filter((proposal) => {
      if (this.#acceptedFingerprints.has(proposal.fingerprint)) {
        dropped.push({ proposal, reason: "already delivered earlier in this session" });
        return false;
      }
      return true;
    });

    const byPriority = (a: Proposal, b: Proposal) => b.priority - a.priority;

    const advisories = fresh.filter((x) => x.kind === "advisory").sort(byPriority);
    const kept = advisories.slice(0, this.#maxAdvisories);
    for (const proposal of advisories.slice(this.#maxAdvisories)) {
      dropped.push({ proposal, reason: "over the per-turn advisory budget" });
    }

    let veto: Proposal | null = null;
    for (const candidate of fresh.filter((x) => x.kind === "veto").sort(byPriority)) {
      if (veto) {
        dropped.push({ proposal: candidate, reason: "another veto was already accepted this turn" });
        continue;
      }
      const spent = this.#vetoSpend.get(candidate.fingerprint) ?? 0;
      if (spent >= this.#vetoBudget) {
        dropped.push({ proposal: candidate, reason: `veto budget of ${this.#vetoBudget} exhausted` });
        continue;
      }
      this.#vetoSpend.set(candidate.fingerprint, spent + 1);
      veto = candidate;
    }

    // Only accepted proposals are remembered. A proposal dropped for budget must
    // stay eligible next turn, otherwise a busy turn silently discards advice.
    for (const proposal of kept) this.#acceptedFingerprints.add(proposal.fingerprint);
    if (veto) this.#acceptedFingerprints.add(veto.fingerprint);

    return { advisories: kept, veto, dropped };
  }
}
```

Note: a veto's fingerprint is added to the accepted set *and* tracked in `#vetoSpend`. The accepted-set check runs first, so a repeat veto is deduped before it reaches the budget. The budget therefore governs distinct-but-recurring vetoes across compaction and reload, where the accepted set may have been restored partially.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reconciler.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Fix the veto-dedupe interaction**

The test `exhausts the veto budget per fingerprint` expects the same fingerprint to veto twice with `vetoBudget: 2`, but `#acceptedFingerprints` would drop the second. Vetoes must be exempt from the accepted-set filter, since re-vetoing the same unmet goal is the whole point. Change the filter to skip vetoes:

```ts
    const fresh = proposals.filter((proposal) => {
      if (proposal.kind === "veto") return true; // budget governs vetoes, not dedupe
      if (this.#acceptedFingerprints.has(proposal.fingerprint)) {
        dropped.push({ proposal, reason: "already delivered earlier in this session" });
        return false;
      }
      return true;
    });
```

and stop recording vetoes in the accepted set:

```ts
    for (const proposal of kept) this.#acceptedFingerprints.add(proposal.fingerprint);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/reconciler.test.ts && npx tsc --noEmit`
Expected: PASS — all 10 tests

- [ ] **Step 7: Commit**

```bash
git add src/reconciler.ts test/reconciler.test.ts
git commit -m "feat: add reconciler with dedupe, priority budget and veto budget"
```

---

## Task 8: ProposalBus

**Files:**
- Create: `src/bus.ts`
- Test: `test/bus.test.ts`

**Interfaces:**
- Consumes: `Proposal`, `DEFAULTS` from `src/types.ts`.
- Produces:
  - `interface ObserverRun { (signal: AbortSignal): Promise<Proposal | null> }`
  - `interface BusStatus { runs: number; failures: number; consecutiveFailures: number; disabled: boolean; lastError?: string }`
  - `class ProposalBus { kick(name, timeoutMs, run: ObserverRun): void; drain(): Proposal[]; status(name): BusStatus; isDisabled(name): boolean; settle(): Promise<void>; abortAll(): void }`

`settle()` exists for tests only — production code never awaits it.

- [ ] **Step 1: Write the failing test**

`test/bus.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { ProposalBus } from "../src/bus.ts";
import type { Proposal } from "../src/types.ts";

const proposal = (fp: string): Proposal => ({
  observer: "o", kind: "advisory", text: "t", fingerprint: fp, priority: 50, deliver: "next_prompt",
});

describe("ProposalBus", () => {
  it("kick returns immediately without awaiting the run", () => {
    const bus = new ProposalBus();
    let settled = false;
    bus.kick("o", 1000, async () => {
      await new Promise((r) => setTimeout(r, 20));
      settled = true;
      return proposal("a");
    });
    expect(settled).toBe(false);
    expect(bus.drain()).toEqual([]);
  });

  it("queues a proposal that a later drain collects", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => proposal("a"));
    await bus.settle();
    expect(bus.drain().map((p) => p.fingerprint)).toEqual(["a"]);
  });

  it("drain empties the queue", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => proposal("a"));
    await bus.settle();
    bus.drain();
    expect(bus.drain()).toEqual([]);
  });

  it("drops a re-kick while a run is in flight", async () => {
    const bus = new ProposalBus();
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return proposal("a");
    });
    bus.kick("o", 1000, run);
    bus.kick("o", 1000, run);
    await bus.settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing run and counts a failure", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => {
      throw new Error("boom");
    });
    await expect(bus.settle()).resolves.toBeUndefined();
    expect(bus.status("o").failures).toBe(1);
    expect(bus.status("o").lastError).toContain("boom");
  });

  it("times out a hanging run and counts it as a failure", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 10, async (signal) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return null;
    });
    await bus.settle();
    expect(bus.status("o").failures).toBe(1);
  });

  it("times out a run that ignores its abort signal", async () => {
    const bus = new ProposalBus();
    // Deliberately uncooperative: never settles, never listens for abort.
    bus.kick("o", 10, () => new Promise<Proposal | null>(() => {}));
    await bus.settle();
    expect(bus.status("o").failures).toBe(1);
    expect(bus.status("o").lastError).toContain("timed out");
    // The slot must be released, or the observer is silently wedged forever.
    const run = vi.fn(async () => proposal("a"));
    bus.kick("o", 1000, run);
    await bus.settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores a late proposal from a run abandoned at timeout", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 10, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return proposal("late");
    });
    await bus.settle();
    await new Promise((r) => setTimeout(r, 80));
    expect(bus.drain()).toEqual([]);
    expect(bus.status("o").failures).toBe(1);
  });

  it("disables an observer after three consecutive failures", async () => {
    const bus = new ProposalBus();
    for (let i = 0; i < 3; i++) {
      bus.kick("o", 1000, async () => {
        throw new Error("boom");
      });
      await bus.settle();
    }
    expect(bus.isDisabled("o")).toBe(true);

    const run = vi.fn(async () => proposal("a"));
    bus.kick("o", 1000, run);
    await bus.settle();
    expect(run).not.toHaveBeenCalled();
  });

  it("resets the consecutive counter on success", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => {
      throw new Error("boom");
    });
    await bus.settle();
    bus.kick("o", 1000, async () => null);
    await bus.settle();
    expect(bus.status("o").consecutiveFailures).toBe(0);
    expect(bus.status("o").failures).toBe(1);
  });

  it("records a run that proposes nothing as a success", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => null);
    await bus.settle();
    expect(bus.status("o").runs).toBe(1);
    expect(bus.status("o").failures).toBe(0);
    expect(bus.drain()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bus.test.ts`
Expected: FAIL — `Cannot find module '../src/bus.ts'`

- [ ] **Step 3: Write `src/bus.ts`**

```ts
import { DEFAULTS, type Proposal } from "./types.ts";

export type ObserverRun = (signal: AbortSignal) => Promise<Proposal | null>;

export interface BusStatus {
  runs: number;
  failures: number;
  consecutiveFailures: number;
  disabled: boolean;
  lastError?: string;
}

interface Entry extends BusStatus {
  inflight?: Promise<void>;
  controller?: AbortController;
}

/**
 * Schedules observer runs without ever blocking the main agent loop.
 *
 * kick() starts a run and returns synchronously. Whatever has landed by the
 * next delivery point gets drained; anything still in flight waits for the one
 * after. Failures are absorbed here and never reach a lifecycle handler.
 */
export class ProposalBus {
  readonly #queue: Proposal[] = [];
  readonly #entries = new Map<string, Entry>();
  readonly #maxConsecutive: number;

  constructor(opts: { maxConsecutiveFailures?: number } = {}) {
    this.#maxConsecutive = opts.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures;
  }

  #entry(name: string): Entry {
    let entry = this.#entries.get(name);
    if (!entry) {
      entry = { runs: 0, failures: 0, consecutiveFailures: 0, disabled: false };
      this.#entries.set(name, entry);
    }
    return entry;
  }

  kick(name: string, timeoutMs: number, run: ObserverRun): void {
    const entry = this.#entry(name);
    if (entry.disabled) return;
    if (entry.inflight) return; // one run per observer at a time; a re-kick is dropped, not queued

    const controller = new AbortController();
    entry.controller = controller;

    // The timeout must settle the bus's OWN bookkeeping, not merely signal the run.
    // A run that ignores its AbortSignal (or awaits something that never rejects on
    // abort) would otherwise leave entry.inflight pending forever: the observer is
    // then permanently silent, because every later kick hits the in-flight guard —
    // yet status() reports runs: 0, failures: 0, disabled: false. Racing guarantees
    // the failure is counted and the slot is released no matter how the run behaves.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("observer run timed out"));
        reject(new Error("observer run timed out"));
      }, timeoutMs);
    });

    const runPromise = run(controller.signal);
    // An abandoned run that rejects AFTER the race was already decided must not
    // surface as an unhandled rejection.
    runPromise.catch(() => {});

    entry.inflight = Promise.race([runPromise, timeout])
      .then((proposal) => {
        entry.runs += 1;
        entry.consecutiveFailures = 0;
        if (proposal) this.#queue.push(proposal);
      })
      .catch((error: unknown) => {
        entry.runs += 1;
        entry.failures += 1;
        entry.consecutiveFailures += 1;
        entry.lastError = error instanceof Error ? error.message : String(error);
        if (entry.consecutiveFailures >= this.#maxConsecutive) entry.disabled = true;
      })
      .finally(() => {
        clearTimeout(timer);
        entry.inflight = undefined;
        entry.controller = undefined;
      });
  }

  /** Non-blocking: returns and clears whatever has landed so far. */
  drain(): Proposal[] {
    return this.#queue.splice(0, this.#queue.length);
  }

  status(name: string): BusStatus {
    const { runs, failures, consecutiveFailures, disabled, lastError } = this.#entry(name);
    return { runs, failures, consecutiveFailures, disabled, lastError };
  }

  isDisabled(name: string): boolean {
    return this.#entry(name).disabled;
  }

  abortAll(): void {
    for (const entry of this.#entries.values()) entry.controller?.abort();
  }

  /** Test helper. Production code must never await observer runs. */
  async settle(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((e) => e.inflight).filter(Boolean));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bus.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bus.ts test/bus.test.ts
git commit -m "feat: add non-blocking proposal bus with timeout and failure tracking"
```

---

## Task 9: Settings

**Files:**
- Create: `src/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: `DEFAULTS` from `src/types.ts`.
- Produces:
  - `interface ObserverSettings { enabled: boolean; maxAdvisoriesPerTurn: number; vetoBudget: number; defaultModel?: string; disable: string[] }`
  - `parseSettings(raw: unknown): ObserverSettings`
  - `isObserverEnabled(def: { name: string; enabled: boolean }, settings: ObserverSettings): boolean`

- [ ] **Step 1: Write the failing test**

`test/settings.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isObserverEnabled, parseSettings } from "../src/settings.ts";

describe("parseSettings", () => {
  it("returns defaults for undefined", () => {
    expect(parseSettings(undefined)).toEqual({
      enabled: true, maxAdvisoriesPerTurn: 2, vetoBudget: 3, defaultModel: undefined, disable: [],
    });
  });

  it("reads provided values", () => {
    const s = parseSettings({
      enabled: false, maxAdvisoriesPerTurn: 5, vetoBudget: 1,
      defaultModel: "lunaroute/deepseek-v4-flash", disable: ["verification"],
    });
    expect(s.enabled).toBe(false);
    expect(s.maxAdvisoriesPerTurn).toBe(5);
    expect(s.vetoBudget).toBe(1);
    expect(s.defaultModel).toBe("lunaroute/deepseek-v4-flash");
    expect(s.disable).toEqual(["verification"]);
  });

  it("ignores malformed values rather than throwing", () => {
    const s = parseSettings({ maxAdvisoriesPerTurn: "lots", disable: "nope", vetoBudget: -1 });
    expect(s.maxAdvisoriesPerTurn).toBe(2);
    expect(s.vetoBudget).toBe(3);
    expect(s.disable).toEqual([]);
  });

  it("ignores a non-object", () => {
    expect(parseSettings("nope").enabled).toBe(true);
  });

  it('honors enabled: "false" instead of coercing it to true', () => {
    // Boolean("false") is true. Coercion here would silently invert the user's intent,
    // which is the same defect definitions.ts already had to fix.
    expect(parseSettings({ enabled: "false" }).enabled).toBe(false);
    expect(parseSettings({ enabled: "true" }).enabled).toBe(true);
  });

  it("falls back rather than coercing a nonsense enabled value", () => {
    expect(parseSettings({ enabled: "yes" }).enabled).toBe(true);
    expect(parseSettings({ enabled: 0 }).enabled).toBe(true);
  });

  it("rejects a boolean where a count is expected", () => {
    // Number(true) === 1, which would silently read as "one advisory per turn".
    expect(parseSettings({ maxAdvisoriesPerTurn: true }).maxAdvisoriesPerTurn).toBe(2);
  });

  it("clamps counts to the safety ceiling", () => {
    expect(parseSettings({ maxAdvisoriesPerTurn: 999999 }).maxAdvisoriesPerTurn).toBe(10);
    expect(parseSettings({ vetoBudget: 999999 }).vetoBudget).toBe(10);
  });

  it("drops non-string and blank entries from disable", () => {
    expect(parseSettings({ disable: ["a", "", "  ", null, 7, {}, " b "] }).disable).toEqual(["a", "b"]);
  });
});

describe("isObserverEnabled", () => {
  const base = parseSettings(undefined);

  it("is on when the file says enabled and settings do not disable it", () => {
    expect(isObserverEnabled({ name: "a", enabled: true }, base)).toBe(true);
  });

  it("is off when the file disables it", () => {
    expect(isObserverEnabled({ name: "a", enabled: false }, base)).toBe(false);
  });

  it("is off when settings disable it", () => {
    const s = parseSettings({ disable: ["a"] });
    expect(isObserverEnabled({ name: "a", enabled: true }, s)).toBe(false);
  });

  it("is off for every observer when the whole feature is disabled", () => {
    const s = parseSettings({ enabled: false });
    expect(isObserverEnabled({ name: "a", enabled: true }, s)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/settings.test.ts`
Expected: FAIL — `Cannot find module '../src/settings.ts'`

- [ ] **Step 3: Write `src/settings.ts`**

```ts
import { DEFAULTS } from "./types.ts";

export interface ObserverSettings {
  enabled: boolean;
  maxAdvisoriesPerTurn: number;
  vetoBudget: number;
  defaultModel?: string;
  disable: string[];
}

/** Safety ceilings on user-supplied values. Not preferences — these bound how much an
 *  observer can inject into the main agent even if a settings file asks for more. */
const MAX_ADVISORIES_LIMIT = 10;
const MAX_VETO_BUDGET_LIMIT = 10;

function positiveIntOr(value: unknown, fallback: number, max: number): number {
  // Reject booleans explicitly: Number(true) === 1, which would silently accept
  // `maxAdvisoriesPerTurn: true` as the number 1.
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return fallback;
  // Upper bound is a safety limit, not a preference. The reconciler's per-turn cap and
  // the veto budget are the only things bounding how much an observer can inject into
  // the main agent; an unbounded value from a hand-edited settings file (a typo adding
  // a digit) would re-enable exactly the runaway loop the budget exists to prevent.
  return Math.min(num, max);
}

/** Accepts a real boolean or the strings "true"/"false", matching the observer-file
 *  convention in definitions.ts. Anything else falls back rather than coercing:
 *  Boolean("false") is true, which would invert the user's stated intent. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Tolerant by design: bad settings degrade to defaults rather than blocking startup.
 *  This is the deliberate difference from definitions.ts, which errors on bad input —
 *  a broken observer file names one broken observer, a broken settings file would
 *  otherwise take down every observer at once. */
export function parseSettings(raw: unknown): ObserverSettings {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const defaultModel = typeof obj.defaultModel === "string" && obj.defaultModel.trim() !== ""
    ? obj.defaultModel.trim()
    : undefined;

  return {
    enabled: booleanOr(obj.enabled, true),
    maxAdvisoriesPerTurn: positiveIntOr(obj.maxAdvisoriesPerTurn, DEFAULTS.maxAdvisoriesPerTurn, MAX_ADVISORIES_LIMIT),
    vetoBudget: positiveIntOr(obj.vetoBudget, DEFAULTS.vetoBudget, MAX_VETO_BUDGET_LIMIT),
    defaultModel,
    disable: Array.isArray(obj.disable)
      ? obj.disable.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim())
      : [],
  };
}

/** Either switch being off means off. */
export function isObserverEnabled(
  def: { name: string; enabled: boolean },
  settings: ObserverSettings,
): boolean {
  if (!settings.enabled) return false;
  if (!def.enabled) return false;
  return !settings.disable.includes(def.name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/settings.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts test/settings.test.ts
git commit -m "feat: parse observers settings block"
```

---

## Task 10: Memory store and slug derivation

**Files:**
- Create: `src/memory.ts`
- Test: `test/memory.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `deriveSlug(text: string): string`
  - `deriveDescription(text: string): string`
  - `writeMemoryNote(opts: { cwd: string; text: string; type?: string }): { path: string; slug: string }`

Nothing in this codebase *reads* `.pi/memory` — the memory-recall observer greps it with its own tools. This module is write-only.

- [ ] **Step 1: Write the failing test**

`test/memory.test.ts`:
```ts
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deriveDescription, deriveSlug, writeMemoryNote } from "../src/memory.ts";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-observers-mem-"));
});

describe("deriveSlug", () => {
  it("kebab-cases the first six words", () => {
    expect(deriveSlug("The build uses Vite not Webpack for speed reasons")).toBe(
      "the-build-uses-vite-not-webpack",
    );
  });

  it("strips punctuation and collapses separators", () => {
    expect(deriveSlug("Don't use `sed`; prefer the Edit tool!")).toBe("don-t-use-sed-prefer-the");
  });

  it("falls back to 'note' for text with no usable characters", () => {
    expect(deriveSlug("!!! ???")).toBe("note");
  });
});

describe("deriveDescription", () => {
  it("takes the first sentence", () => {
    expect(deriveDescription("Uses Vite. Not Webpack.")).toBe("Uses Vite.");
  });

  it("truncates past 100 chars", () => {
    const d = deriveDescription("x".repeat(200));
    expect(d.length).toBeLessThanOrEqual(100);
  });
});

describe("writeMemoryNote", () => {
  it("writes a note with frontmatter", () => {
    const { path, slug } = writeMemoryNote({ cwd, text: "The build uses Vite not Webpack" });
    expect(slug).toBe("the-build-uses-vite-not-webpack");
    const content = readFileSync(path, "utf8");
    expect(content).toContain("name: the-build-uses-vite-not-webpack");
    expect(content).toContain("type: project");
    expect(content).toContain("The build uses Vite not Webpack");
  });

  it("honours an explicit type", () => {
    const { path } = writeMemoryNote({ cwd, text: "Prefer tabs", type: "feedback" });
    expect(readFileSync(path, "utf8")).toContain("type: feedback");
  });

  it("suffixes on slug collision instead of overwriting", () => {
    const first = writeMemoryNote({ cwd, text: "Same words here now ok yes" });
    const second = writeMemoryNote({ cwd, text: "Same words here now ok yes" });
    expect(second.slug).toBe(`${first.slug}-2`);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });

  it("creates the memory directory if absent", () => {
    const { path } = writeMemoryNote({ cwd, text: "anything at all here" });
    expect(existsSync(path)).toBe(true);
  });

  it("rejects empty text", () => {
    expect(() => writeMemoryNote({ cwd, text: "   " })).toThrow(/empty/i);
  });

  it("writes frontmatter that actually parses when the text contains YAML syntax", () => {
    // Unquoted, each of these breaks the note: a colon fails to parse, a leading "-"
    // becomes a sequence, and a leading "#" parses as null, silently losing the text.
    for (const text of ["Use Vite: not Webpack", "#1 rule: no bash", "- prefer tabs"]) {
      const { path } = writeMemoryNote({ cwd, text });
      const raw = readFileSync(path, "utf8");
      const fm = parse(raw.split("---")[1] as string);
      expect(typeof fm.description).toBe("string");
      expect(fm.description.length).toBeGreaterThan(0);
    }
  });

  it("falls back to project for an unrecognised type", () => {
    const { path } = writeMemoryNote({ cwd, text: "some note here", type: "bogus\ninjected: yes" });
    const fm = parse(readFileSync(path, "utf8").split("---")[1] as string);
    expect(fm.type).toBe("project");
    expect(fm.injected).toBeUndefined();
  });
});

describe("deriveSlug — non-Latin", () => {
  it("keeps non-Latin words instead of collapsing to the fallback", () => {
    // An [a-z0-9] class would reduce every one of these to "note", so a user writing
    // in Hebrew or Chinese would get note, note-2, note-3 with no descriptive filename.
    expect(deriveSlug("הערה בעברית")).not.toBe("note");
    expect(deriveSlug("中文笔记")).not.toBe("note");
    expect(deriveSlug("café déjà vu")).toBe("café-déjà-vu");
  });
});

describe("deriveDescription — truncation safety", () => {
  it("does not split a surrogate pair at the cap", () => {
    const d = deriveDescription("x".repeat(98) + "\u{1F600}" + "y".repeat(50));
    expect(d).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(d).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory.test.ts`
Expected: FAIL — `Cannot find module '../src/memory.ts'`

- [ ] **Step 3: Write `src/memory.ts`**

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const MAX_DESCRIPTION = 100;
const SLUG_WORDS = 6;

/** The note `type` vocabulary from the design doc. An unrecognised value falls back
 *  rather than being written through: `type` reaches here from a `--type` flag, and an
 *  arbitrary string would both break the frontmatter and defeat any later filtering. */
const NOTE_TYPES = ["project", "feedback", "reference", "user"] as const;
const DEFAULT_NOTE_TYPE = "project";

/** Deterministic, no model call: first six words, kebab-cased.
 *  Unicode-aware on purpose. An [a-z0-9] class silently reduces any non-Latin note to
 *  the fallback slug, so every Hebrew or Chinese note would land as note, note-2,
 *  note-3 — losing the descriptive filename that is the whole point of the slug. It
 *  also mangles accented Latin ("café déjà vu" -> "caf-d-j-vu"). */
export function deriveSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, SLUG_WORDS)
    .join("-");
  return slug === "" ? "note" : slug;
}

/** First sentence, truncated. This is what the recall observer ranks against. */
export function deriveDescription(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const match = trimmed.match(/^.*?[.!?](\s|$)/);
  const sentence = (match ? match[0] : trimmed).trim();
  if (sentence.length <= MAX_DESCRIPTION) return sentence;
  // Truncate by code point: slice() on UTF-16 units can cut a surrogate pair in half
  // and emit a lone surrogate, producing invalid UTF-8 in the written file.
  const cut = Array.from(sentence).slice(0, MAX_DESCRIPTION - 1).join("").trimEnd();
  return `${cut}…`;
}

export function memoryDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "memory");
}

export function writeMemoryNote(opts: { cwd: string; text: string; type?: string }): {
  path: string;
  slug: string;
} {
  const text = opts.text.trim();
  if (text === "") throw new Error("Cannot write an empty memory note.");

  const dir = memoryDir(opts.cwd);
  mkdirSync(dir, { recursive: true });

  const base = deriveSlug(text);
  let slug = base;
  let n = 1;
  while (existsSync(join(dir, `${slug}.md`))) {
    n += 1;
    slug = `${base}-${n}`;
  }

  const path = join(dir, `${slug}.md`);
  const type = NOTE_TYPES.includes(opts.type as (typeof NOTE_TYPES)[number])
    ? (opts.type as string)
    : DEFAULT_NOTE_TYPE;
  // description is arbitrary user text and MUST be quoted. Unquoted, a colon makes the
  // frontmatter fail to parse, a leading "-" turns it into a sequence, and a leading "#"
  // makes the whole value parse as null — silently discarding the description with no
  // error anywhere. JSON.stringify emits a double-quoted scalar that YAML accepts, with
  // quotes and backslashes escaped, and it is fully deterministic.
  const content = `---
name: ${slug}
description: ${JSON.stringify(deriveDescription(text))}
type: ${type}
---

${text}
`;
  writeFileSync(path, content, "utf8");
  return { path, slug };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/memory.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory.ts test/memory.test.ts
git commit -m "feat: write .pi/memory notes with deterministic slugs"
```

---

## Task 11: Observer runner

**Files:**
- Create: `src/runner.ts`
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: `createOutputTools` from `src/outputs.ts`; `renderSlices` from `src/slices.ts`; `ObserverDefinition`, `Proposal`, `SliceState` from `src/types.ts`; `ModelLike` from `src/models.ts`.
- Produces:
  - `interface ObserverRunner { name: string; run(state: SliceState, signal: AbortSignal): Promise<Proposal | null>; dispose(): void }`
  - `createObserverRunner(opts: CreateRunnerOptions): Promise<ObserverRunner>`
  - `buildObserverSystemPrompt(def: ObserverDefinition): string`

`createObserverRunner` takes an injectable `createSession` factory defaulting to the real SDK call, so tests never touch a model.

- [ ] **Step 1: Write the failing test**

`test/runner.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { buildObserverSystemPrompt, createObserverRunner } from "../src/runner.ts";
import type { ObserverDefinition } from "../src/types.ts";

function defOf(over: Partial<ObserverDefinition> = {}): ObserverDefinition {
  return {
    name: "memory-recall", description: "d", enabled: true, on: "turn_end",
    sees: ["last_user_message"], tools: ["read", "grep"], can: ["advise"],
    deliver: "next_prompt", fallback: [], thinking: "low", priority: 50,
    maxAdvisoryChars: 300, timeoutMs: 20000, systemPrompt: "Watch memory.",
    sourcePath: "/o.md", scope: "builtin", ...over,
  };
}

describe("buildObserverSystemPrompt", () => {
  it("includes the file body", () => {
    expect(buildObserverSystemPrompt(defOf())).toContain("Watch memory.");
  });

  it("tells an advise-only observer to call propose or stay silent", () => {
    const prompt = buildObserverSystemPrompt(defOf({ can: ["advise"] }));
    expect(prompt).toContain("propose");
    expect(prompt).not.toContain("call `veto`");
  });

  it("mentions veto only when permitted", () => {
    expect(buildObserverSystemPrompt(defOf({ can: ["advise", "veto"] }))).toContain("veto");
  });

  it("states that observers are read-only", () => {
    expect(buildObserverSystemPrompt(defOf())).toMatch(/read-only/i);
  });
});

describe("createObserverRunner", () => {
  function fakeSessionFactory(onPrompt: (tools: unknown[]) => void) {
    return vi.fn(async (opts: { customTools?: unknown[] }) => ({
      session: {
        prompt: vi.fn(async () => onPrompt(opts.customTools ?? [])),
        dispose: vi.fn(),
      },
    }));
  }

  it("creates the session once and reuses it across runs", async () => {
    const factory = fakeSessionFactory(() => {});
    const runner = await createObserverRunner({
      def: defOf(), model: { provider: "p", id: "m" }, cwd: "/tmp",
      agentDir: "/tmp/agent", createSession: factory as never,
    });
    await runner.run({ lastUserMessage: "a" }, new AbortController().signal);
    await runner.run({ lastUserMessage: "b" }, new AbortController().signal);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("returns the proposal the observer emitted via its tool", async () => {
    // The fake invokes propose the way a model would.
    const factory = fakeSessionFactory(async (tools) => {
      // biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
      const propose = (tools as any[]).find((t) => t.name === "propose");
      await propose.execute("id", { advisory: "see note X", fingerprint: "fp" }, undefined, undefined, {});
    });
    const runner = await createObserverRunner({
      def: defOf(), model: { provider: "p", id: "m" }, cwd: "/tmp",
      agentDir: "/tmp/agent", createSession: factory as never,
    });
    const proposal = await runner.run({ lastUserMessage: "a" }, new AbortController().signal);
    expect(proposal).toMatchObject({ observer: "memory-recall", text: "see note X" });
  });

  it("returns null when the observer stays silent", async () => {
    const factory = fakeSessionFactory(() => {});
    const runner = await createObserverRunner({
      def: defOf(), model: { provider: "p", id: "m" }, cwd: "/tmp",
      agentDir: "/tmp/agent", createSession: factory as never,
    });
    expect(await runner.run({}, new AbortController().signal)).toBeNull();
  });

  it("restricts the session to the definition's tools", async () => {
    const factory = fakeSessionFactory(() => {});
    await createObserverRunner({
      def: defOf({ tools: ["read"] }), model: { provider: "p", id: "m" },
      cwd: "/tmp", agentDir: "/tmp/agent", createSession: factory as never,
    });
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ tools: ["read"] });
  });

  it("aborts the session when the signal fires and returns null", async () => {
    const abort = vi.fn(async () => {});
    let release: () => void = () => {};
    const factory = vi.fn(async () => ({
      session: {
        prompt: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })),
        abort,
        dispose: vi.fn(),
      },
    }));
    const runner = await createObserverRunner({
      def: defOf(), model: { provider: "p", id: "m" }, cwd: "/tmp",
      agentDir: "/tmp/agent", createSession: factory as never,
    });
    const controller = new AbortController();
    const pending = runner.run({ lastUserMessage: "a" }, controller.signal);
    controller.abort();
    // The bridge must have called through to the session; an observer that ignores the
    // signal keeps burning tokens after the bus has stopped waiting for it.
    expect(abort).toHaveBeenCalledTimes(1);
    release();
    expect(await pending).toBeNull();
  });

  it("does not accumulate abort listeners across runs", async () => {
    const abort = vi.fn(async () => {});
    const factory = vi.fn(async () => ({
      session: { prompt: vi.fn(async () => {}), abort, dispose: vi.fn() },
    }));
    const runner = await createObserverRunner({
      def: defOf(), model: { provider: "p", id: "m" }, cwd: "/tmp",
      agentDir: "/tmp/agent", createSession: factory as never,
    });
    const controller = new AbortController();
    // Five completed runs on one signal. The session outlives them all, so a listener
    // left behind by each run would still be attached.
    for (let i = 0; i < 5; i++) await runner.run({}, controller.signal);
    controller.abort();
    // Each listener is registered { once: true }, so five leaked listeners would fire
    // five times on this single abort. Exactly zero is correct here: every run already
    // finished, so every listener should have been removed in its finally block.
    expect(abort).toHaveBeenCalledTimes(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — `Cannot find module '../src/runner.ts'`

- [ ] **Step 3: Write `src/runner.ts`**

```ts
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ModelLike } from "./models.ts";
import { createOutputTools } from "./outputs.ts";
import { renderSlices } from "./slices.ts";
import type { ObserverDefinition, Proposal, SliceState } from "./types.ts";

export interface ObserverRunner {
  name: string;
  run(state: SliceState, signal: AbortSignal): Promise<Proposal | null>;
  dispose(): void;
}

// Structural type so tests can substitute a fake without importing pi's session types.
type SessionFactory = (opts: Record<string, unknown>) => Promise<{
  session: { prompt(text: string): Promise<unknown>; dispose(): void };
}>;

export interface CreateRunnerOptions {
  def: ObserverDefinition;
  model: ModelLike;
  cwd: string;
  agentDir: string;
  /** Injectable for tests. Defaults to the real SDK call. */
  createSession?: SessionFactory;
}

export function buildObserverSystemPrompt(def: ObserverDefinition): string {
  const canVeto = def.can.includes("veto");
  const canAdvise = def.can.includes("advise");

  const emitLines: string[] = [];
  if (canAdvise) {
    emitLines.push(
      "- To offer advice, call `propose` exactly once with a short advisory and a stable fingerprint.",
    );
  }
  if (canVeto) {
    emitLines.push(
      "- To hold the turn open because required work is not done, call `veto` exactly once.",
    );
  }

  return `${def.systemPrompt.trim()}

---

You are a background observer running alongside a coding agent. You watch exactly one
axis of quality and nothing else.

You are read-only. You cannot edit files, run commands, or answer on the agent's behalf.
Your prose reply is discarded — only tool calls are read.

${emitLines.join("\n")}
- If you have nothing genuinely useful to add, call nothing at all. Staying silent is
  the correct and common outcome. Do not narrate that you found nothing.

Be brief. At most ${def.maxAdvisoryChars} characters. One or two sentences.
The fingerprint must identify the specific advice so it is not repeated later.`;
}

export async function createObserverRunner(opts: CreateRunnerOptions): Promise<ObserverRunner> {
  const { def, model, cwd, agentDir } = opts;
  const systemPrompt = buildObserverSystemPrompt(def);

  // Hermetic: without these the nested session loads this very extension and
  // recursively spawns observers inside observers.
  //
  // Use the TYPED options `systemPrompt` / `appendSystemPrompt`, NOT the
  // `systemPromptOverride` / `appendSystemPromptOverride` pair. Those two exist in pi's
  // compiled resource-loader at runtime but are absent from the exported
  // DefaultResourceLoaderOptions type, so an object literal carrying them fails tsc's
  // excess-property check — and an undocumented runtime option could disappear in a
  // later release with no type error to warn us.
  //
  // `systemPrompt` is a prompt *source*: pi treats it as a file path when one exists at
  // that path and as a literal otherwise. Observer prompts are multi-line prose, never a
  // path, so they resolve as literals. Passing it also suppresses pi's own system-prompt
  // file discovery, which is the point. `appendSystemPrompt: []` likewise suppresses
  // discovery of an append-prompt file (an empty array is truthy, so pi skips the
  // discovery branch); omitting it would let a project's append file leak in.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    appendSystemPrompt: [],
  });
  await resourceLoader.reload();

  // Output tools are rebuilt per run so each run gets a fresh collector; the
  // session itself persists, so its context accumulates across wakes.
  let current = createOutputTools(def);

  const factory: SessionFactory =
    opts.createSession ?? (createAgentSession as unknown as SessionFactory);

  const { session } = await factory({
    cwd,
    agentDir,
    model: model as never,
    thinkingLevel: def.thinking,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    tools: def.tools,
    customTools: current.tools,
  });

  return {
    name: def.name,
    async run(state, signal) {
      if (signal.aborted) return null;
      current = createOutputTools(def);
      const rendered = renderSlices(def.sees, state);
      const prompt = rendered === "" ? "Observe now." : `Observe now.\n\n${rendered}`;

      // session.prompt() takes no AbortSignal — PromptOptions carries none — so the only
      // way to cancel an in-flight run is session.abort(). Without this bridge, an
      // aborted or timed-out observer keeps running and burning tokens: the bus stops
      // waiting for it, but nothing stops the run itself.
      const onAbort = () => {
        void session.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await session.prompt(prompt);
      } finally {
        // Always remove it: the session outlives the run, and a listener per run would
        // accumulate for the life of the session.
        signal.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) return null;
      return current.collector.take();
    },
    dispose() {
      session.dispose();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runner.test.ts && npx tsc --noEmit`
Expected: PASS

Note: the test's "returns the proposal" case invokes the tool captured at session-creation time. Because `run()` rebuilds `current`, the captured array is stale. Fix by creating the tools once and having them delegate to a mutable collector reference:

- [ ] **Step 5: Fix the stale-tools bug**

Replace the per-run rebuild with a single tool set bound to a swappable collector. In `src/outputs.ts`, add a reset to the collector:

```ts
  const collector: ProposalCollector = {
    take: () => proposal,
    reset: () => {
      proposal = null;
      warnings.length = 0;
    },
    warnings,
  };
```

and extend the interface:

```ts
export interface ProposalCollector {
  take(): Proposal | null;
  reset(): void;
  warnings: string[];
}
```

Then in `src/runner.ts`, build tools once and reset between runs:

```ts
  const { tools, collector } = createOutputTools(def);
  // ... pass `customTools: tools` to the factory ...

    async run(state, signal) {
      if (signal.aborted) return null;
      collector.reset();
      const rendered = renderSlices(def.sees, state);
      const prompt = rendered === "" ? "Observe now." : `Observe now.\n\n${rendered}`;
      await session.prompt(prompt);
      return collector.take();
    },
```

Add a test to `test/outputs.test.ts` for the reset:

```ts
  it("reset clears the proposal between runs", async () => {
    const { tools, collector } = createOutputTools(defOf());
    await call(tools[0], { advisory: "first", fingerprint: "a" });
    collector.reset();
    expect(collector.take()).toBeNull();
    await call(tools[0], { advisory: "second", fingerprint: "b" });
    expect(collector.take()?.text).toBe("second");
  });
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/runner.ts src/outputs.ts test/runner.test.ts test/outputs.test.ts
git commit -m "feat: run observers in persistent hermetic nested sessions"
```

---

## Task 12: Commands

**Files:**
- Create: `src/commands.ts`
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `writeMemoryNote` from `src/memory.ts`; `ProposalBus` from `src/bus.ts`; `ObserverDefinition` from `src/types.ts`; `ModelResolution` from `src/models.ts`.
- Produces:
  - `goalFilePath(cwd: string): string`
  - `writeGoal(cwd: string, text: string): string` — empty text clears the goal, returning `""`
  - `readGoal(cwd: string): string | undefined`
  - `formatObserverStatus(rows: StatusRow[]): string`
  - `interface StatusRow { name: string; enabled: boolean; model: string; runs: number; failures: number; disabled: boolean; accepted: number; dropped: number }`

Command *registration* happens in Task 13; this task provides the pure logic those handlers call.

- [ ] **Step 1: Write the failing test**

`test/commands.test.ts`:
```ts
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { formatObserverStatus, goalFilePath, readGoal, writeGoal } from "../src/commands.ts";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-observers-cmd-"));
});

describe("goal file", () => {
  it("returns undefined when no goal is set", () => {
    expect(readGoal(cwd)).toBeUndefined();
  });

  it("writes then reads a goal", () => {
    writeGoal(cwd, "Ship the parser");
    expect(readGoal(cwd)).toBe("Ship the parser");
    expect(existsSync(goalFilePath(cwd))).toBe(true);
  });

  it("clears the goal when given empty text", () => {
    writeGoal(cwd, "Ship the parser");
    writeGoal(cwd, "   ");
    expect(readGoal(cwd)).toBeUndefined();
  });

  it("overwrites rather than appending", () => {
    writeGoal(cwd, "First");
    writeGoal(cwd, "Second");
    expect(readGoal(cwd)).toBe("Second");
  });
});

describe("formatObserverStatus", () => {
  it("says so when nothing is loaded", () => {
    expect(formatObserverStatus([])).toMatch(/no observers/i);
  });

  it("lists each observer with model and counts", () => {
    const out = formatObserverStatus([
      { name: "memory-recall", enabled: true, model: "lunaroute/deepseek-v4-flash", runs: 3, failures: 0, disabled: false, accepted: 2, dropped: 1 },
      { name: "verification", enabled: false, model: "-", runs: 0, failures: 0, disabled: false, accepted: 0, dropped: 0 },
    ]);
    expect(out).toContain("memory-recall");
    expect(out).toContain("lunaroute/deepseek-v4-flash");
    expect(out).toContain("verification");
    expect(out).toMatch(/disabled|off/i);
  });

  it("reports accepted and dropped counts, not just runs", () => {
    // An observer that runs constantly and has everything dropped is working and
    // useless; with only a run count it looks identical to a healthy one.
    const out = formatObserverStatus([
      { name: "noisy", enabled: true, model: "m", runs: 9, failures: 0, disabled: false, accepted: 0, dropped: 9 },
    ]);
    expect(out).toMatch(/0 accepted/);
    expect(out).toMatch(/9 dropped/);
  });

  it("shows failures for an observer that is failing but not yet disabled", () => {
    // Reporting failures only after the disable threshold hides the warning signal.
    const out = formatObserverStatus([
      { name: "shaky", enabled: true, model: "m", runs: 5, failures: 2, disabled: false, accepted: 1, dropped: 0 },
    ]);
    expect(out).toMatch(/2 failures/);
  });

  it("flags an observer disabled by repeated failures", () => {
    const out = formatObserverStatus([
      { name: "flaky", enabled: true, model: "m", runs: 3, failures: 3, disabled: true, accepted: 0, dropped: 0 },
    ]);
    expect(out).toMatch(/failure/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — `Cannot find module '../src/commands.ts'`

- [ ] **Step 3: Write `src/commands.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface StatusRow {
  name: string;
  enabled: boolean;
  model: string;
  runs: number;
  failures: number;
  disabled: boolean;
  /** Proposals this observer had accepted by the reconciler this session. */
  accepted: number;
  /** Proposals the reconciler dropped — deduped, over-length, capped, or budget-spent. */
  dropped: number;
}

export function goalFilePath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "observers", "state", "goal.md");
}

/** Writing empty text clears the goal. Returns the stored goal, or "" if cleared. */
export function writeGoal(cwd: string, text: string): string {
  const path = goalFilePath(cwd);
  const trimmed = text.trim();

  if (trimmed === "") {
    if (existsSync(path)) rmSync(path);
    return "";
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${trimmed}\n`, "utf8");
  return trimmed;
}

export function readGoal(cwd: string): string | undefined {
  const path = goalFilePath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

export function formatObserverStatus(rows: StatusRow[]): string {
  if (rows.length === 0) return "No observers loaded.";

  return rows
    .map((row) => {
      const state = row.disabled
        ? `disabled after ${row.failures} failure${row.failures === 1 ? "" : "s"}`
        : row.enabled
          ? "on"
          : "off";

      if (!row.enabled) return `${row.name} [${state}] ${row.model}`;

      // Failures must show even when the observer is still running. An observer failing
      // intermittently but not yet at the disable threshold is exactly what a user needs
      // to see, and reporting it only after it is disabled hides the warning signal.
      const parts = [`${row.runs} run${row.runs === 1 ? "" : "s"}`];
      if (!row.disabled && row.failures > 0) {
        parts.push(`${row.failures} failure${row.failures === 1 ? "" : "s"}`);
      }
      // The spec requires accepted vs dropped: an observer that runs constantly and has
      // everything dropped is working and useless, which looks identical to a healthy one
      // if only the run count is shown.
      parts.push(`${row.accepted} accepted`, `${row.dropped} dropped`);
      return `${row.name} [${state}] ${row.model} — ${parts.join(", ")}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/commands.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts test/commands.test.ts
git commit -m "feat: add goal file handling and observer status formatting"
```

---

## Task 13: Extension wiring

**Files:**
- Create: `src/index.ts`
- Test: `test/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-12.
- Produces: the default-export extension factory, plus two exported pure helpers used by its handlers:
  - `collectSliceState(opts: { sees: SliceName[]; ctx: unknown; turnToolCalls: ToolCallRecord[]; commands: Array<{ name: string; description?: string; source: string }> }): SliceState`
  - `formatAdvisories(advisories: Proposal[]): string`

- [ ] **Step 1: Write the failing test**

`test/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatAdvisories } from "../src/index.ts";
import type { Proposal } from "../src/types.ts";

const p = (observer: string, text: string): Proposal => ({
  observer, kind: "advisory", text, fingerprint: `${observer}-1`, priority: 50, deliver: "next_prompt",
});

describe("formatAdvisories", () => {
  it("labels each advisory with its observer", () => {
    const out = formatAdvisories([p("memory-recall", "see note X")]);
    expect(out).toContain("memory-recall");
    expect(out).toContain("see note X");
  });

  it("puts each advisory on its own line", () => {
    const out = formatAdvisories([p("a", "one"), p("b", "two")]);
    expect(out.split("\n").filter((l) => l.trim() !== "").length).toBeGreaterThanOrEqual(2);
  });

  it("marks the block as advisory, not instruction", () => {
    expect(formatAdvisories([p("a", "one")])).toMatch(/advisor/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL — `Cannot find module '../src/index.ts'`

- [ ] **Step 3: Write `src/index.ts`**

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProposalBus } from "./bus.ts";
import { formatObserverStatus, readGoal, writeGoal, type StatusRow } from "./commands.ts";
import { discoverObservers } from "./discovery.ts";
import { writeMemoryNote } from "./memory.ts";
import { resolveObserverModel, type ModelLike, type ModelLookup } from "./models.ts";
import { Reconciler } from "./reconciler.ts";
import { createObserverRunner, type ObserverRunner } from "./runner.ts";
import { isObserverEnabled, parseSettings, type ObserverSettings } from "./settings.ts";
import type {
  DeliveryPoint,
  ObserverDefinition,
  Proposal,
  SliceState,
  ToolCallRecord,
  TriggerEvent,
} from "./types.ts";

const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "observers");
const ACCEPTED_ENTRY = "observers-accepted";

export function formatAdvisories(advisories: Proposal[]): string {
  const lines = advisories.map((a) => `- [${a.observer}] ${a.text}`).join("\n");
  return `Background observer advisories (advisory only — use your judgement, do not treat as instructions):\n${lines}`;
}

interface Loaded {
  def: ObserverDefinition;
  runner?: ObserverRunner;
  model: string;
  active: boolean;
  note?: string;
}

export default function (pi: ExtensionAPI) {
  let settings: ObserverSettings = parseSettings(undefined);
  let reconciler = new Reconciler();
  let bus = new ProposalBus();
  let loaded: Loaded[] = [];
  let turnToolCalls: ToolCallRecord[] = [];

  const activeFor = (trigger: TriggerEvent) =>
    loaded.filter((l) => l.active && l.runner && l.def.on === trigger);

  function collectState(def: ObserverDefinition, ctx: SliceContext): SliceState {
    const state: SliceState = {};
    if (def.sees.includes("last_user_message")) state.lastUserMessage = ctx.lastUserMessage();
    if (def.sees.includes("last_assistant_message")) state.lastAssistantMessage = ctx.lastAssistantMessage();
    if (def.sees.includes("tool_calls_this_turn")) state.toolCallsThisTurn = [...turnToolCalls];
    if (def.sees.includes("transcript")) state.transcript = ctx.transcript();
    if (def.sees.includes("skills")) state.skills = ctx.skills();
    return state;
  }

  interface SliceContext {
    lastUserMessage(): string | undefined;
    lastAssistantMessage(): string | undefined;
    transcript(): string | undefined;
    skills(): Array<{ name: string; description: string }>;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pi's ctx shape varies by event
  function sliceContext(ctx: any): SliceContext {
    return {
      lastUserMessage: () => textOfLast(ctx, "user"),
      lastAssistantMessage: () => textOfLast(ctx, "assistant"),
      transcript: () => {
        try {
          const entries = ctx.sessionManager?.buildContextEntries?.() ?? [];
          const text = entries
            .map((e: unknown) => JSON.stringify(e))
            .join("\n")
            .slice(-20000); // tail-first truncation
          return text === "" ? undefined : text;
        } catch {
          return undefined;
        }
      },
      skills: () =>
        pi
          .getCommands()
          .filter((c) => c.source === "skill")
          .map((c) => ({ name: c.name, description: c.description ?? "" })),
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: pi message shapes
  function textOfLast(ctx: any, role: "user" | "assistant"): string | undefined {
    try {
      const entries = ctx.sessionManager?.getBranch?.() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry?.type !== "message" || entry.message?.role !== role) continue;
        const content = entry.message.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const text = content
            .filter((c: { type?: string }) => c?.type === "text")
            .map((c: { text?: string }) => c.text ?? "")
            .join("\n")
            .trim();
          if (text !== "") return text;
        }
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pi ctx
  function kickAll(trigger: TriggerEvent, ctx: any) {
    const sc = sliceContext(ctx);
    for (const entry of activeFor(trigger)) {
      const state = collectState(entry.def, sc);
      // Fire-and-forget. Never awaited: an observer must not add latency to a turn.
      bus.kick(entry.def.name, entry.def.timeoutMs, (signal) => entry.runner!.run(state, signal));
    }
  }

  function drainFor(point: DeliveryPoint): Proposal[] {
    const all = bus.drain();
    const mine = all.filter((p) => p.deliver === point || (p.kind === "veto" && point === "settle"));
    // Anything not for this delivery point goes back for a later one.
    for (const proposal of all) if (!mine.includes(proposal)) requeue(proposal);
    const { advisories, veto, dropped } = reconciler.reconcile(mine);
    if (veto) pendingVeto = veto;
    // Tally per observer for /observers. The reconciler is stateless about who proposed
    // what across calls, and the bus only counts runs — so an observer that runs
    // constantly and has everything dropped would otherwise look identical to a healthy
    // one. This is the only place both outcomes are visible.
    for (const a of advisories) tallyFor(a.observer).accepted += 1;
    if (veto) tallyFor(veto.observer).accepted += 1;
    for (const d of dropped) tallyFor(d.proposal.observer).dropped += 1;
    for (const a of advisories) pi.appendEntry(ACCEPTED_ENTRY, { fingerprint: a.fingerprint });
    return advisories;
  }

  /** Per-observer accepted/dropped counts for the /observers command. */
  const tallies = new Map<string, { accepted: number; dropped: number }>();
  function tallyFor(name: string): { accepted: number; dropped: number } {
    let t = tallies.get(name);
    if (!t) {
      t = { accepted: 0, dropped: 0 };
      tallies.set(name, t);
    }
    return t;
  }

  const held: Proposal[] = [];
  let pendingVeto: Proposal | null = null;
  const requeue = (p: Proposal) => held.push(p);

  pi.on("session_start", async (_event, ctx) => {
    settings = parseSettings(readSettingsBlock(ctx));
    reconciler = new Reconciler({
      maxAdvisoriesPerTurn: settings.maxAdvisoriesPerTurn,
      vetoBudget: settings.vetoBudget,
    });
    bus = new ProposalBus();
    held.length = 0;
    pendingVeto = null;

    // Dedupe must survive /reload and resume.
    const seen: string[] = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      // biome-ignore lint/suspicious/noExplicitAny: custom entry shape
      const e = entry as any;
      if (e.type === "custom" && e.customType === ACCEPTED_ENTRY && e.data?.fingerprint) {
        seen.push(String(e.data.fingerprint));
      }
    }
    reconciler.restore(seen);

    const { observers, errors } = discoverObservers({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      builtinDir: BUILTIN_DIR,
    });

    for (const error of errors) {
      if (ctx.hasUI) ctx.ui.notify(`observer "${error.file}": ${error.message}`, "error");
    }

    const lookup = modelLookup(ctx);
    loaded = [];

    for (const def of observers) {
      const enabled = isObserverEnabled(def, settings);
      if (!enabled) {
        loaded.push({ def, model: "-", active: false, note: "disabled" });
        continue;
      }

      const resolution = resolveObserverModel(def, lookup, {
        defaultModel: settings.defaultModel,
        sessionModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      });

      if (resolution.status === "disabled") {
        loaded.push({ def, model: "-", active: false, note: resolution.reason });
        if (ctx.hasUI) ctx.ui.notify(`observer "${def.name}" disabled: ${resolution.reason}`, "warn");
        continue;
      }

      try {
        const runner = await createObserverRunner({
          def,
          model: resolution.model,
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
        });
        loaded.push({
          def,
          runner,
          model: `${resolution.model.provider}/${resolution.model.id}`,
          active: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        loaded.push({ def, model: "-", active: false, note: message });
      }
    }
  });

  pi.on("turn_start", async () => {
    turnToolCalls = [];
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    turnToolCalls.push({
      name: event.toolName,
      args: summarizeArgs(event),
      isError: Boolean(event.isError),
    });
    kickAll("tool_execution_end", ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    kickAll("turn_end", ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    kickAll("before_agent_start", ctx);
    const advisories = drainFor("next_prompt");
    if (advisories.length === 0) return;
    return {
      message: {
        customType: "observer-advisory",
        content: formatAdvisories(advisories),
        display: true,
      },
    };
  });

  pi.on("context", async (event) => {
    const advisories = drainFor("next_turn");
    if (advisories.length === 0) return;
    return {
      messages: [
        ...event.messages,
        { role: "user", content: [{ type: "text", text: formatAdvisories(advisories) }] },
      ],
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    kickAll("agent_settled", ctx);
    const advisories = drainFor("settle");

    if (pendingVeto) {
      const veto = pendingVeto;
      pendingVeto = null;
      pi.sendMessage(
        {
          customType: "observer-veto",
          content: `Observer "${veto.observer}" is holding this turn open: ${veto.text}`,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }

    if (advisories.length > 0) {
      pi.sendMessage(
        { customType: "observer-advisory", content: formatAdvisories(advisories), display: true },
        { deliverAs: "followUp" },
      );
    }
  });

  pi.on("session_shutdown", async () => {
    bus.abortAll();
    for (const entry of loaded) {
      try {
        entry.runner?.dispose();
      } catch {
        /* dispose must be idempotent and silent */
      }
    }
    loaded = [];
  });

  pi.registerCommand("observers", {
    description: "Show observer status; enable or disable one for this session",
    handler: async (args, ctx) => {
      const [verb, name] = args.trim().split(/\s+/);
      if ((verb === "enable" || verb === "disable") && name) {
        const entry = loaded.find((l) => l.def.name === name);
        if (!entry) {
          ctx.ui.notify(`No observer named "${name}".`, "error");
          return;
        }
        entry.active = verb === "enable" && Boolean(entry.runner);
        ctx.ui.notify(`Observer "${name}" ${entry.active ? "enabled" : "disabled"}.`, "info");
        return;
      }

      const rows: StatusRow[] = loaded.map((l) => {
        const status = bus.status(l.def.name);
        const tally = tallyFor(l.def.name);
        return {
          name: l.def.name,
          enabled: l.active,
          model: l.model,
          runs: status.runs,
          failures: status.failures,
          disabled: status.disabled,
          accepted: tally.accepted,
          dropped: tally.dropped,
        };
      });
      ctx.ui.notify(formatObserverStatus(rows), "info");
    },
  });

  pi.registerCommand("goal", {
    description: "Declare the goal the goal-tracking observer holds you to (empty clears it)",
    handler: async (args, ctx) => {
      const stored = writeGoal(ctx.cwd, args);
      ctx.ui.notify(stored === "" ? "Goal cleared." : `Goal set: ${stored}`, "info");
    },
  });

  pi.registerCommand("remember", {
    description: "Write a note to .pi/memory for the memory-recall observer",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (text === "") {
        const goal = readGoal(ctx.cwd);
        ctx.ui.notify(goal ? `Current goal: ${goal}` : "Nothing to remember.", "info");
        return;
      }
      try {
        const { slug } = writeMemoryNote({ cwd: ctx.cwd, text });
        ctx.ui.notify(`Remembered as ${slug}.`, "success");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: pi ctx
function readSettingsBlock(ctx: any): unknown {
  // SettingsManager has NO generic get(key) accessor — verified against pi 0.83.0.
  // It exposes getGlobalSettings() / getProjectSettings(), each returning a Settings
  // object. Project settings override global ones.
  try {
    const global = ctx.settingsManager?.getGlobalSettings?.() ?? {};
    const project = ctx.settingsManager?.getProjectSettings?.() ?? {};
    const merged = { ...(global.observers ?? {}), ...(project.observers ?? {}) };
    return Object.keys(merged).length > 0 ? merged : undefined;
  } catch {
    return undefined;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: pi ctx
function modelLookup(ctx: any): ModelLookup {
  return {
    find: (provider, id) => ctx.modelRegistry?.find?.(provider, id) as ModelLike | undefined,
    all: () => (ctx.modelRegistry?.getAll?.() ?? []) as ModelLike[],
  };
}

// biome-ignore lint/suspicious/noExplicitAny: pi event
function summarizeArgs(event: any): string {
  try {
    const args = event.args ?? {};
    const text = typeof args === "string" ? args : JSON.stringify(args);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/index.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Model registry and settings APIs — already verified**

Both were verified against pi 0.83.0 during planning; the code above already reflects
the real shapes. Do not change them without re-checking:

- `ModelRegistry.getAll(): Model[]` exists and is what `modelLookup()` uses. There is
  also `getAvailable()`, which filters to models whose provider is authenticated —
  consider it if unauthenticated models cause noise, but `getAll()` matches the
  resolution chain's intent (fall back loudly, not silently).
- `SettingsManager` has **no** generic `get(key)`. It exposes `getGlobalSettings()`
  and `getProjectSettings()`, each returning a `Settings` object. `readSettingsBlock()`
  above merges `observers` off both, project winning.

- [ ] **Step 6: Session-entry shape — already verified**

Verified against pi 0.83.0; `textOfLast()` above already matches the real shapes. For
reference, so you can check rather than trust:

- `SessionManager.getBranch() / getEntries() / buildContextEntries()` all return
  `SessionEntry[]`.
- `SessionMessageEntry` is `{ type: "message", message: AgentMessage }`.
- `UserMessage.content` is `string | (TextContent | ImageContent)[]` — the string case
  is real and must be handled.
- `AssistantMessage.content` is always an array: `(TextContent | ThinkingContent |
  ToolCall)[]`. Filtering to `type === "text"` is what excludes thinking blocks, which
  the spec requires. Do not widen that filter.
- `CustomEntry` is `{ type: "custom", customType: string, data?: T }`, which is what
  the reconciler-replay scan in `session_start` relies on.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: wire observers into pi lifecycle with delivery points and commands"
```

---

## Task 14: Bundled observer definitions

**Files:**
- Create: `observers/memory-recall.md`, `observers/skill-recall.md`, `observers/goal-tracker.md`, `observers/verification.md`
- Test: `test/bundled.test.ts`

**Interfaces:**
- Consumes: `discoverObservers` from `src/discovery.ts`.
- Produces: the four shipped definitions. No code.

- [ ] **Step 1: Write the failing test**

`test/bundled.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverObservers } from "../src/discovery.ts";

const BUILTIN_DIR = join(import.meta.dirname, "..", "observers");

function load() {
  const empty = mkdtempSync(join(tmpdir(), "pi-observers-bundled-"));
  return discoverObservers({ cwd: empty, agentDir: empty, builtinDir: BUILTIN_DIR });
}

describe("bundled observers", () => {
  it("all four parse with no errors", () => {
    const { observers, errors } = load();
    expect(errors).toEqual([]);
    expect(observers.map((o) => o.name).sort()).toEqual([
      "goal-tracker", "memory-recall", "skill-recall", "verification",
    ]);
  });

  it("ships enabled states matching Muse Code's defaults", () => {
    const byName = Object.fromEntries(load().observers.map((o) => [o.name, o]));
    expect(byName["memory-recall"]?.enabled).toBe(true);
    expect(byName["skill-recall"]?.enabled).toBe(true);
    expect(byName["goal-tracker"]?.enabled).toBe(true);
    expect(byName.verification?.enabled).toBe(false);
  });

  it("only goal-tracker may veto", () => {
    for (const o of load().observers) {
      expect(o.can.includes("veto")).toBe(o.name === "goal-tracker");
    }
  });

  it("none request a mutating tool", () => {
    for (const o of load().observers) {
      for (const tool of o.tools) {
        expect(["read", "grep", "find", "ls"]).toContain(tool);
      }
    }
  });

  it("uses the triggers and delivery points from the spec", () => {
    const byName = Object.fromEntries(load().observers.map((o) => [o.name, o]));
    expect(byName["memory-recall"]).toMatchObject({ on: "turn_end", deliver: "next_prompt" });
    expect(byName["skill-recall"]).toMatchObject({ on: "before_agent_start", deliver: "next_prompt" });
    expect(byName["goal-tracker"]).toMatchObject({ on: "agent_settled", deliver: "settle" });
    expect(byName.verification).toMatchObject({ on: "agent_settled", deliver: "settle" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bundled.test.ts`
Expected: FAIL — no observers found

- [ ] **Step 3: Write `observers/memory-recall.md`**

```markdown
---
name: memory-recall
description: Surface a project memory note relevant to the next reply
enabled: true
on: turn_end
sees: [last_user_message]
tools: [read, grep]
can: [advise]
deliver: next_prompt
priority: 40
max_advisory_chars: 300
---
You watch one axis: whether a stored project memory is relevant to what the user
just asked.

Project memory lives in `.pi/memory/*.md`. Each note has YAML frontmatter with a
`description` field summarising it in one line.

Your procedure:
1. Grep `.pi/memory/` for the `description:` lines.
2. If no such directory or no notes exist, emit nothing. This is normal.
3. Judge whether any note bears directly on the user's request.
4. If exactly one does, read it and propose a single sentence pointing the agent at
   it and stating the salient fact.

Propose only for a note that would change what the agent does. A note that is merely
topically adjacent is not worth interrupting for. When in doubt, stay silent.
```

- [ ] **Step 4: Write `observers/skill-recall.md`**

```markdown
---
name: skill-recall
description: Surface a project skill the task should load first
enabled: true
on: before_agent_start
sees: [last_user_message, skills]
can: [advise]
deliver: next_prompt
priority: 60
max_advisory_chars: 250
---
You watch one axis: whether an available skill should be loaded before this task
proceeds.

You are given the user's request and the list of available skills with their
descriptions. Judge whether one of them is clearly the right procedure for this
request.

Propose only when the match is strong and the skill would meaningfully change the
approach. Name the skill exactly as listed. One sentence.

If no skill clearly fits, or the request is conversational, emit nothing. Most turns
need no skill, and a wrong suggestion costs more than a missed one.
```

- [ ] **Step 5: Write `observers/goal-tracker.md`**

```markdown
---
name: goal-tracker
description: Hold the agent to a declared goal until the work is actually done
enabled: true
on: agent_settled
sees: [last_user_message, transcript]
tools: [read]
can: [advise, veto]
deliver: settle
priority: 90
max_advisory_chars: 300
---
You watch one axis: whether the declared goal has actually been met.

Read `.pi/observers/state/goal.md`. If that file does not exist or is empty, emit
nothing — there is no goal to enforce.

If a goal is declared, judge from the transcript whether the work it describes is
genuinely finished. Finished means done, not planned, described, or promised.

- If it is finished, emit nothing.
- If it is plainly unfinished, call `veto` once with a single sentence naming exactly
  what remains.

Use the goal text itself as your fingerprint so repeated vetoes for the same goal
share a budget.

Be conservative. Veto only when you are confident work remains — a wrong veto sends
the agent back to work it already completed. Ambiguity means stay silent.
```

- [ ] **Step 6: Write `observers/verification.md`**

```markdown
---
name: verification
description: Check that the agent ran the work it claims it finished
enabled: false
on: agent_settled
sees: [last_assistant_message, tool_calls_this_turn]
tools: [read]
can: [advise]
deliver: settle
priority: 70
max_advisory_chars: 300
---
You watch one axis: whether the agent's claims match the tool record.

You are given the agent's final message and the list of tools it actually invoked
this turn, with their arguments and error status.

Extract concrete, checkable claims from the message — "ran the tests", "the build
passes", "verified the fix". For each, look for a matching tool call that would
substantiate it.

Propose only when there is a clear mismatch: a specific claim of work performed with
no corresponding successful tool call. Quote the claim.

Do not flag: statements of intent, descriptions of what code does, or claims about
work from earlier turns. Reasoning and explanation need no tool call. If everything
claimed is supported, emit nothing.
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/bundled.test.ts && npx vitest run && npx tsc --noEmit`
Expected: PASS — the full suite

- [ ] **Step 8: Commit**

```bash
git add observers/ test/bundled.test.ts
git commit -m "feat: ship Muse Code's four observers as bundled definitions"
```

---

## Task 15: Integration tests and README

**Files:**
- Create: `test/integration.test.ts`, `README.md`
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: `ProposalBus`, `Reconciler`, `createObserverRunner`.
- Produces: no new source. Proves the injection path and failure handling end to end without spending a token.

- [ ] **Step 1: Write the failing test**

`test/integration.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { ProposalBus } from "../src/bus.ts";
import { Reconciler } from "../src/reconciler.ts";
import { createObserverRunner } from "../src/runner.ts";
import type { DeliveryPoint, ObserverDefinition, Proposal } from "../src/types.ts";

function defOf(over: Partial<ObserverDefinition> = {}): ObserverDefinition {
  return {
    name: "fake", description: "d", enabled: true, on: "turn_end", sees: [], tools: [],
    can: ["advise"], deliver: "next_prompt", fallback: [], thinking: "low", priority: 50,
    maxAdvisoryChars: 300, timeoutMs: 50, systemPrompt: "b", sourcePath: "/o.md",
    scope: "builtin", ...over,
  };
}

/** A fake session whose "model" always calls propose once. */
function proposingFactory(text: string) {
  return vi.fn(async (opts: { customTools?: unknown[] }) => ({
    session: {
      prompt: vi.fn(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
        const propose = (opts.customTools as any[]).find((t) => t.name === "propose");
        await propose.execute("id", { advisory: text, fingerprint: "fp" }, undefined, undefined, {});
      }),
      dispose: vi.fn(),
    },
  }));
}

async function runOnce(def: ObserverDefinition, factory: unknown) {
  const bus = new ProposalBus();
  const runner = await createObserverRunner({
    def, model: { provider: "p", id: "m" }, cwd: "/tmp",
    agentDir: "/tmp/agent", createSession: factory as never,
  });
  bus.kick(def.name, def.timeoutMs, (signal) => runner.run({}, signal));
  await bus.settle();
  return bus;
}

describe("injection path", () => {
  it.each<DeliveryPoint>(["next_prompt", "next_turn", "settle"])(
    "carries a proposal through to the %s delivery point",
    async (deliver) => {
      const bus = await runOnce(defOf({ deliver }), proposingFactory("advice"));
      const proposals = bus.drain();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.deliver).toBe(deliver);

      const { advisories } = new Reconciler().reconcile(proposals);
      expect(advisories).toHaveLength(1);
      expect(advisories[0]?.text).toBe("advice");
    },
  );

  it("a veto reaches the reconciler as a veto", async () => {
    const factory = vi.fn(async (opts: { customTools?: unknown[] }) => ({
      session: {
        prompt: vi.fn(async () => {
          // biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
          const veto = (opts.customTools as any[]).find((t) => t.name === "veto");
          await veto.execute("id", { reason: "tests not run", fingerprint: "g" }, undefined, undefined, {});
        }),
        dispose: vi.fn(),
      },
    }));
    const bus = await runOnce(defOf({ can: ["advise", "veto"], deliver: "settle" }), factory);
    const { veto } = new Reconciler().reconcile(bus.drain());
    expect(veto?.text).toBe("tests not run");
  });
});

describe("failure containment", () => {
  it("a throwing observer produces no proposal and does not reject", async () => {
    const factory = vi.fn(async () => ({
      session: {
        prompt: vi.fn(async () => {
          throw new Error("model exploded");
        }),
        dispose: vi.fn(),
      },
    }));
    const bus = await runOnce(defOf(), factory);
    expect(bus.drain()).toEqual([]);
    expect(bus.status("fake").failures).toBe(1);
  });

  it("a hanging observer times out and counts a failure", async () => {
    const factory = vi.fn(async () => ({
      session: {
        prompt: vi.fn(() => new Promise(() => {})), // never resolves
        dispose: vi.fn(),
      },
    }));
    const bus = new ProposalBus();
    const def = defOf({ timeoutMs: 20 });
    const runner = await createObserverRunner({
      def, model: { provider: "p", id: "m" }, cwd: "/tmp",
      agentDir: "/tmp/agent", createSession: factory as never,
    });
    bus.kick(def.name, def.timeoutMs, (signal) =>
      Promise.race([
        runner.run({}, signal),
        new Promise<Proposal | null>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("timed out"))),
        ),
      ]),
    );
    await bus.settle();
    expect(bus.status("fake").failures).toBe(1);
    expect(bus.drain()).toEqual([]);
  });

  it("three consecutive failures disable the observer", async () => {
    const bus = new ProposalBus();
    for (let i = 0; i < 3; i++) {
      bus.kick("fake", 100, async () => {
        throw new Error("nope");
      });
      await bus.settle();
    }
    expect(bus.isDisabled("fake")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — the hanging-observer case fails because `run()` awaits `session.prompt` without racing the signal

- [ ] **Step 3: Make the runner abort-aware**

In `src/runner.ts`, race the prompt against the abort signal so a hung model call honours `timeout_ms`:

```ts
    async run(state, signal) {
      if (signal.aborted) return null;
      collector.reset();
      const rendered = renderSlices(def.sees, state);
      const prompt = rendered === "" ? "Observe now." : `Observe now.\n\n${rendered}`;

      await Promise.race([
        session.prompt(prompt),
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new Error("observer run aborted"));
          signal.addEventListener("abort", () => reject(new Error("observer run aborted")), {
            once: true,
          });
        }),
      ]);

      return collector.take();
    },
```

Then simplify the integration test's hanging case to call `runner.run` directly:

```ts
    bus.kick(def.name, def.timeoutMs, (signal) => runner.run({}, signal));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit && npx biome check src/ test/`
Expected: PASS across the whole suite

- [ ] **Step 5: Write `README.md`**

```markdown
# pi-observers

File-defined observer agents for [pi](https://pi.dev). Observers watch one axis of
quality each, propose at most a short advisory, and a reconciler decides what reaches
the main agent. They are read-only and never answer on the agent's behalf.

The pattern is taken from Meta's Muse Code. Its four observers ship as bundled
examples — they are plain files in the same format any observer uses.

## Install

    pi install npm:pi-observers

Or load directly for development:

    pi -e ./src/index.ts

## Bundled observers

| Observer | Watches | Default |
|---|---|---|
| `memory-recall` | a relevant note in `.pi/memory/` | on |
| `skill-recall` | a skill the task should load first | on |
| `goal-tracker` | whether a declared goal is actually met (may veto) | on |
| `verification` | whether claimed work matches the tool record | off |

## Writing an observer

Drop a markdown file in `.pi/observers/` (project) or `~/.pi/agent/observers/`
(global). Same-named files override the bundled ones; project beats global beats
bundled.

    ---
    name: my-observer
    description: What single axis this watches
    on: turn_end                    # before_agent_start | turn_end | tool_execution_end | agent_settled
    sees: [last_user_message]       # last_assistant_message | tool_calls_this_turn | transcript | skills
    tools: [read, grep]             # read-only only: read, grep, find, ls
    can: [advise]                   # advise, veto
    deliver: next_prompt            # next_prompt | next_turn | settle
    model: lunaroute/deepseek-v4-flash
    fallback: [anthropic/claude-haiku-4-5]
    priority: 50
    ---
    Your system prompt. Call `propose` once, or nothing at all.

Observers cannot write. Anything an observer needs beyond its `sees:` slices, it
fetches with `read`/`grep`.

## Commands

| Command | Effect |
|---|---|
| `/observers` | Status: resolved model, runs, failures |
| `/observers enable\|disable <name>` | Toggle for this session |
| `/goal <text>` | Declare the goal `goal-tracker` enforces (empty clears) |
| `/remember <text>` | Write a note to `.pi/memory/` |

## Settings

    {
      "observers": {
        "enabled": true,
        "maxAdvisoriesPerTurn": 2,
        "vetoBudget": 3,
        "defaultModel": "lunaroute/deepseek-v4-flash",
        "disable": ["verification"]
      }
    }

## Design

See `docs/superpowers/specs/2026-08-05-pi-observers-design.md`.
```

- [ ] **Step 6: Commit**

```bash
git add test/integration.test.ts README.md src/runner.ts
git commit -m "test: prove injection path and failure containment end to end"
```

---

## Task 16: Manual verification

**Files:**
- Modify: none. This task produces a verification record, not code.

**Interfaces:**
- Consumes: the whole extension.
- Produces: confirmation the extension loads and behaves correctly inside real pi.

- [ ] **Step 1: Create a scratch project**

```bash
mkdir -p /tmp/pi-observers-manual && cd /tmp/pi-observers-manual && git init -q
```

- [ ] **Step 2: Load the extension and check discovery**

Run from the pi-observers checkout:
```bash
cd /tmp/pi-observers-manual && pi -e <path-to>/pi-observers/src/index.ts
```
Then in pi, run `/observers`.
Expected: four observers listed. `memory-recall`, `skill-recall`, `goal-tracker` show a resolved `provider/model`; `verification` shows `[off]`.

If any observer shows `disabled:` with a model reason, the fallback chain found nothing — set `observers.defaultModel` in settings to a model you have authenticated.

- [ ] **Step 3: Verify no recursion**

In the same session, confirm the startup emitted no repeated observer-loading notices and that `/observers` lists exactly four entries, not sixteen. Recursion would show as observers loading inside observer sessions.

- [ ] **Step 4: Verify the advisory path**

```
/remember The parser lives in src/parse.ts and must stay dependency-free
```
Then ask: `where should I add the new token type?`
Expected: a `memory-recall` advisory referencing the note appears before or alongside the agent's reply. Confirm it renders as an advisory block, not as a user instruction.

- [ ] **Step 5: Verify the veto path and its budget**

```
/goal Add a failing test for empty input and make it pass
```
Then ask the agent to do something unrelated and let it settle.
Expected: `goal-tracker` vetoes once, the turn reopens, and after at most 3 vetoes for the same goal the budget stops it. Confirm it does not loop indefinitely.

- [ ] **Step 6: Verify non-blocking behaviour**

Ask a trivial question (`what is 2+2`) and observe response latency.
Expected: the reply is not visibly delayed by observer runs. Observers report on subsequent turns, not by holding this one.

- [ ] **Step 7: Clear the goal and commit the verification record**

```
/goal
```
Then record the outcome:
```bash
cd <path-to>/pi-observers
cat >> README.md <<'EOF'

## Verified

Manually verified against pi 0.83.0: discovery, no recursion, advisory delivery,
veto budget, and non-blocking turn latency.
EOF
git add README.md && git commit -m "docs: record manual verification against pi 0.83.0"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 concept, four declarative properties | 2, 14 |
| §3 file format, precedence, unknown-field rejection | 2, 3 |
| §4 triggers | 2 (validation), 13 (wiring) |
| §5 slices, `(unavailable)` markers | 5, 13 |
| §6 read-only tool allowlist, enforced | 2 |
| §7 propose/veto contract, silence, second-call warning | 6 |
| §8 three delivery points, veto always at settle | 13, 15 |
| §9 six-step model resolution, defaultModel substitution | 4 |
| §10 lifecycle, persistence, non-blocking, reconciler, replay | 8, 11, 7, 13 |
| §11 four bundled observers with spec'd triggers/delivery | 14 |
| §11 memory store format | 10 |
| §12 settings | 9 |
| §13 commands | 12, 13 |
| §14 error handling: swallow, timeout, 3-strikes, load errors | 8, 13, 15 |
| §15 module layout | all |
| §16 testing | every task, plus 15 |

Two spec items were folded rather than given their own task: `src/memory.ts` is
write-only (nothing in code reads `.pi/memory` — the observer greps it), so it merged
with the command logic in Task 10/12; and `src/commands.ts` splits pure logic (Task 12)
from registration (Task 13), because registration needs the wired-up bus and loaded
observers.

**Placeholder scan:** no TBD/TODO. Every code step has runnable code. Tasks 7, 11 and
15 each contain a deliberate bug-then-fix step, which is honest about a real
interaction the first implementation gets wrong rather than pretending it is obvious.

**Type consistency:** `ObserverDefinition` field names are identical across Tasks 1-14.
`Proposal` shape is fixed in Task 1 and used unchanged in 6, 7, 8, 13, 15.
`ProposalCollector` gains `reset()` in Task 11 Step 5, and the interface change is
written out there rather than assumed. `ModelLookup.all()` is used consistently in
Tasks 4 and 13; Task 13 Step 5 verifies the real pi method name backing it.

**Known risk carried into implementation:** Task 13 depends on three pi APIs whose exact
shapes were not verified during planning — `ModelRegistry`'s list-all method,
`SettingsManager`'s key accessor, and the session-entry shape for extracting message
text. Steps 5 and 6 of Task 13 verify the first two against the installed package. All
three are wrapped in try/catch so a mismatch degrades to defaults rather than crashing,
but the implementer must confirm them, not assume them.
