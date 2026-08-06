# Porting Muse Code's background observer agents to a pi extension

Research notes + implementation blueprint. Date: 2026-08-05.
Verified against pi `@earendil-works/pi-coding-agent` **0.83.0** (installed locally).

---

## 1. What Muse Code actually does

Sources: [Meta research blog](https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2),
[developer blog](https://developer.meta.com/ai/resources/blog/build-with-muse-code/).

### Architecture
- "A simple agent loop plus a set of async background agents."
- Background agents are **persistent** — alive for the whole session, not respawned per
  task. Meta credits this with avoiding "redundant information gathering" and cutting
  latency / steering burden on long multi-step work.
- They "carry out next steps and choose when to communicate back to the main agent" —
  push, not poll.
- Runtime is an **append-only local event log** of every model call, tool invocation,
  approval and edit. That makes it "replay-exact and restart-safe."
- Ships three skills: `/plan` (plan gated on approval), `/grill` (stress-test the plan
  until it holds), `/goal` (drive to a stated objective).

### The observer/reconciler pattern (the interesting part)

> Alongside the main session, Muse Code runs a team of background observer agents. Each
> one watches a single axis of quality, and can insert a short advisory into the main
> agent's next turn **without an interruption**. An observer never answers for you: it
> **proposes**, a **reconciler decides**, and only an accepted proposal reaches the main
> agent.

| Observer | Job | Default |
|---|---|---|
| Memory recall | Surface a note from local project memory relevant to the next reply | on |
| Skill recall | Surface a project skill the task should load first | on |
| Goal tracking | Hold the agent to a declared goal; **decline to close the turn** until the work is done | on |
| Verification | Check the agent actually ran the work it claims it finished | off |

Toggled in the settings file.

Three properties worth preserving, because they're what make this different from
"just spawn a subagent":

1. **One axis per observer.** Narrow prompt, cheap model, no scope creep.
2. **Advisory, not authority.** Observers emit proposals. A reconciler dedupes, ranks,
   budgets and drops. At most a couple of lines ever reach the main agent.
3. **Non-interrupting.** The advisory rides along with the next turn; it never yanks
   the main loop mid-stream.

---

## 2. pi's extension surface (the parts that matter here)

Docs: <https://pi.dev/docs/latest/extensions> · local copy at
`$(npm root -g)/@earendil-works/pi-coding-agent/docs/extensions.md`

An extension is a TypeScript module loaded via jiti (no build step) exporting a default
factory that receives `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) { /* ... */ }
```

Discovery: `~/.pi/agent/extensions/*.ts` or `*/index.ts` (global),
`.pi/extensions/**` (project, trusted only), plus `settings.json` `extensions` /
`packages` arrays. Dev loop: `pi -e ./my-ext.ts`, then `/reload`.

### Primitives that map onto Muse's design

| Muse concept | pi primitive |
|---|---|
| Persistent background agent | `createAgentSession()` from the SDK, held in a module-scope map, created in `session_start`, disposed in `session_shutdown` |
| Observer watches the session | `pi.on("turn_end" \| "message_end" \| "tool_execution_end" \| "agent_end", …)` |
| Advisory into next turn, no interruption | `before_agent_start` → `return { message: {...} }` (per user prompt) or the `context` event → `return { messages }` (per agent turn, inside the loop) |
| Push-style "choose when to report" | `pi.sendMessage(msg, { deliverAs: "nextTurn" })` — docs: *"Does not interrupt or trigger anything."* |
| Decline to close the turn | `agent_settled` → `pi.sendMessage(…, { deliverAs: "followUp", triggerTurn: true })` |
| Reconciler | Yours. Plain TS between the proposal queue and the injection point. |
| Replay-exact event log | Already there: the session JSONL. Persist observer state with `pi.appendEntry()`, rebuild it in `session_start` from `ctx.sessionManager.getEntries()`. |
| Settings toggles | `~/.pi/agent/settings.json` (use `CONFIG_DIR_NAME`, never hardcode `.pi`) |
| Cheap observer model | `createAgentSession({ model })` per observer, resolved via `ctx.modelRegistry.find(provider, id)` |

### Lifecycle (abridged from the docs)

```
session_start ─► resources_discover
user prompt
  ├─► input                    (transform / handle)
  ├─► before_agent_start       (inject message, rewrite system prompt)  ◄── advisory lands here
  ├─► agent_start
  │   ┌── turn (loops while the LLM calls tools) ──┐
  │   ├─► turn_start
  │   ├─► context              (modify messages)   ◄── mid-loop advisory lands here
  │   ├─► before_provider_request
  │   ├─► tool_execution_start / tool_call / tool_result / tool_execution_end
  │   └─► turn_end                                  ◄── observers wake here
  ├─► agent_end
  └─► agent_settled            (nothing left to run) ◄── goal observer vetoes here
session_shutdown
```

Two injection points, and the difference matters:

- **`before_agent_start`** fires once per *user prompt*. This is Muse's "next turn"
  for memory/skill recall — the advisory arrives before the agent starts thinking.
  Returns `{ message, systemPrompt }`; the message is persisted in the session and sent
  to the LLM. `systemPrompt` chains across extensions.
- **`context`** fires once per *agent turn* inside the tool loop, with a deep copy of
  the messages that is safe to mutate. This is where a mid-run advisory goes if the
  agent is already 6 tool calls deep and shouldn't be interrupted.

### Nested agents

`createAgentSession()` is the SDK entry point and is fully usable from inside an
extension:

```ts
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),   // ephemeral, no session file
  modelRuntime,
  model,
  tools: ["read", "grep", "find", "ls"],        // read-only observer
});
await session.prompt("...");
session.dispose();
```

`AgentSession` exposes `prompt()`, `steer()`, `followUp()`, `subscribe()`, `messages`,
`abort()`, `dispose()`. Because the session object survives between `prompt()` calls,
**an observer that keeps its session alive keeps its context** — that is exactly Muse's
persistence claim, and it comes free.

### Prior art already on this machine

- `examples/extensions/subagent/` — official example. Discovers `*.md` agent
  definitions with YAML frontmatter (`name`, `description`, `tools`, `model`) from
  `~/.pi/agent/agents/` and `.pi/agents/`, then spawns **a separate `pi` process** per
  invocation in JSON mode. Simple and isolated; heavier than in-process.
- `@tintinweb/pi-subagents` v0.14.3 — already installed here (see `settings.json`
  `packages`). In-process `createAgentSession` runner with background execution,
  concurrency limiting, a live widget, steering, worktree isolation, and — important —
  a **cross-extension RPC over `pi.events`**: `subagents:rpc:ping`, `subagents:rpc:spawn`,
  `subagents:rpc:stop`, plus lifecycle events `subagents:created|started|completed|failed`.

  That RPC is a legitimate shortcut: the observer extension can delegate agent
  spawning to pi-subagents instead of owning a runner. Trade-off is a hard dependency
  and less control over model/turn budget per observer.

---

## 3. Design: `pi-muse` observers

### Module layout

```
~/.pi/agent/extensions/pi-muse/
├── index.ts           # factory: wiring, settings, lifecycle
├── bus.ts             # ProposalBus — observers write, reconciler reads
├── reconciler.ts      # accept/reject/rank/budget
├── runner.ts          # persistent nested AgentSession per observer
└── observers/
    ├── memory.ts
    ├── skill.ts
    ├── goal.ts
    └── verification.ts
```

### Core types

```ts
export interface Proposal {
  observer: "memory" | "skill" | "goal" | "verification";
  /** Higher wins when the budget is tight. */
  priority: number;
  /** The advisory text. Keep it to 1-3 lines — this is a nudge, not a briefing. */
  advisory: string;
  /** "veto" means: do not let the turn close yet. Goal observer only. */
  kind: "advisory" | "veto";
  /** Dedupe key. Same key = same nag; don't repeat it. */
  fingerprint: string;
  turnIndex: number;
}

export interface Observer {
  name: Proposal["observer"];
  enabledByDefault: boolean;
  /** Fired async after each turn. Must never throw into the main loop. */
  observe(ctx: ObserveInput): Promise<Proposal | null>;
}
```

### The bus (non-blocking is the whole point)

Observers are kicked off fire-and-forget at `turn_end`. Whatever has landed by the
next injection point gets considered; whatever hasn't, waits for the one after. The
main loop never awaits an observer.

```ts
// bus.ts
export class ProposalBus {
  #pending: Proposal[] = [];
  #seen = new Set<string>();
  #inflight = new Map<string, Promise<void>>();

  /** Fire-and-forget. Rejections are swallowed — an observer must never break the loop. */
  kick(name: string, work: () => Promise<Proposal | null>) {
    if (this.#inflight.has(name)) return;          // one run per observer at a time
    const p = work()
      .then((proposal) => { if (proposal) this.#pending.push(proposal); })
      .catch(() => {})                              // observers fail silently
      .finally(() => { this.#inflight.delete(name); });
    this.#inflight.set(name, p);
  }

  /** Non-blocking read. Returns and clears whatever is ready right now. */
  drain(): Proposal[] {
    const out = this.#pending.filter((p) => !this.#seen.has(p.fingerprint));
    for (const p of out) this.#seen.add(p.fingerprint);
    this.#pending = [];
    return out;
  }
}
```

### The reconciler

Muse's "an observer never answers for you" only holds if this stays strict.

```ts
// reconciler.ts
const MAX_ADVISORIES_PER_TURN = 2;
const MAX_CHARS = 400;

export function reconcile(proposals: Proposal[]): { advisories: Proposal[]; veto: Proposal | null } {
  const veto = proposals.find((p) => p.kind === "veto") ?? null;

  const advisories = proposals
    .filter((p) => p.kind === "advisory")
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_ADVISORIES_PER_TURN)
    .filter((p) => p.advisory.length <= MAX_CHARS);

  return { advisories, veto };
}
```

Rules worth keeping:
- Hard cap on count and length. An advisory that grows into a paragraph is a second
  agent talking over the first one.
- Dedupe by fingerprint across the whole session — the same nudge twice is noise.
- One veto max per turn, and bound how many times a single goal may veto (see below).

### Wiring

```ts
// index.ts (abridged)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProposalBus } from "./bus.ts";
import { reconcile } from "./reconciler.ts";

export default function (pi: ExtensionAPI) {
  const bus = new ProposalBus();
  let observers: Observer[] = [];
  let settings: MuseSettings;

  // Docs are explicit: start long-lived work in session_start, not in the factory —
  // the factory may run in invocations that never open a session.
  pi.on("session_start", async (_event, ctx) => {
    settings = loadSettings(ctx.cwd);              // reads settings.json via CONFIG_DIR_NAME
    observers = buildObservers(settings, pi, ctx); // each holds its own AgentSession
    restoreState(ctx);                             // replay pi.appendEntry() records
  });

  // Observers wake after each turn and run async. Nothing is awaited here.
  pi.on("turn_end", async (event, ctx) => {
    for (const o of observers) {
      bus.kick(o.name, () => o.observe({ event, ctx, sessionManager: ctx.sessionManager }));
    }
  });

  // Injection point 1: per user prompt.
  pi.on("before_agent_start", async (event, _ctx) => {
    const { advisories } = reconcile(bus.drain());
    if (advisories.length === 0) return;

    pi.appendEntry("muse-advisory", { advisories });   // replayable record

    return {
      message: {
        customType: "muse-advisory",
        content: advisories.map((a) => `[${a.observer}] ${a.advisory}`).join("\n"),
        display: true,
      },
    };
  });

  // Injection point 2: mid-loop, for advisories that can't wait for the next prompt.
  pi.on("context", async (event, _ctx) => {
    const { advisories } = reconcile(bus.drain());
    if (advisories.length === 0) return;
    return {
      messages: [
        ...event.messages,
        { role: "user", content: [{ type: "text", text: formatAdvisory(advisories) }] },
      ],
    };
  });

  // The veto: refuse to let the turn close.
  pi.on("agent_settled", async (_event, ctx) => {
    const { veto } = reconcile(bus.drain());
    if (!veto) return;
    if (!consumeVetoBudget(veto.fingerprint)) return;   // bounded — see below
    pi.sendMessage(
      { customType: "muse-goal", content: veto.advisory, display: true },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  pi.on("session_shutdown", async () => {
    for (const o of observers) await o.dispose?.();     // must be idempotent
    observers = [];
  });
}
```

### Per-observer notes

**Memory recall.** Needs a memory store — pick a convention (`.pi/memory/*.md`, or
reuse whatever the project already has) and index it at `session_start`. The observer
gets the last user message + assistant summary and asks a cheap model "which of these
note titles, if any, is relevant?" Return at most one. Cheapest correct version does
lexical prefiltering in TS and only calls the model on the top few candidates.

**Skill recall.** No model call needed for the shortlist: `pi.getCommands()` returns
every command with `source: "extension" | "prompt" | "skill"` and `sourceInfo.scope`.
Filter to `source === "skill"`, match descriptions against the task, propose
`"Consider loading /skill:<name> before continuing — <description>"`. Guard against
proposing a skill that's already loaded by checking
`ctx.getSystemPromptOptions().skills` (command contexts only).

**Goal tracking.** Two halves:
1. A `/goal` command that records the declared goal via `pi.appendEntry("muse-goal", …)`
   so it survives reload and replay.
2. At `agent_settled`, ask the observer session: "Given this goal and this transcript,
   is the work done? Answer done/not-done plus one line." If not-done, emit a veto.

   **Bound this.** An unbounded veto loop is an infinite agent. Cap at ~2-3 vetoes per
   goal, decrement a budget on each, and surface the count in the widget so the user
   sees it happening. Also check `ctx.isIdle()` and honour `ctx.signal`.

**Verification.** Off by default, matching Muse. It reads the tool record — every
`tool_execution_end` event is observable, and `ctx.sessionManager.getBranch()` has the
persisted toolResult entries — and cross-checks the final assistant message's claims
against it. "Says it ran the tests" → was there a `bash` call whose command matches a
test runner and whose exit code was 0? This one is mostly deterministic; use the model
only to extract claims from prose, not to judge evidence.

### Settings

```jsonc
// ~/.pi/agent/settings.json
{
  "muse": {
    "observers": {
      "memory":       { "enabled": true },
      "skill":        { "enabled": true },
      "goal":         { "enabled": true, "maxVetoes": 3 },
      "verification": { "enabled": false }
    },
    "model": "anthropic/claude-haiku-4-5-20251001",
    "maxAdvisoriesPerTurn": 2
  }
}
```

Read it with `SettingsManager`, or plain `fs` against
`join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")` — the docs warn not to hardcode
`.pi`, since rebranded builds change the config dir name.

---

## 4. Things that will bite

- **Never await an observer in a lifecycle handler.** `turn_end`, `context` and
  `before_agent_start` are all on the critical path. An observer that takes 3s adds 3s
  to every turn. Fire-and-forget, drain what's ready.
- **Observers must not throw.** A rejected promise inside a handler can take the turn
  with it. Swallow everything at the bus boundary.
- **Cost.** Four observers × every turn is a real multiplier. Run them on a small model,
  skip observers whose trigger conditions don't fire (no goal declared → goal observer
  never runs), and return combined `usage` from nested calls so pi's footer and
  `/session` totals stay honest.
- **Veto loops.** Covered above. Budget them.
- **Advisory pollution.** Injected messages persist in the session and count against
  context. Cap length, dedupe by fingerprint, and consider pruning old advisories in
  the `context` handler (it hands you a mutable deep copy for exactly this).
- **Session-replacement staleness.** If you ever call `ctx.newSession()`/`fork()`, the
  `withSession` callback runs in the *old* closure — captured `pi`/`ctx`/`sessionManager`
  objects are stale and throw. Capture plain strings only.
- **`ctx.signal` is undefined when idle.** Don't assume it exists in `session_start`,
  command handlers, or shortcut handlers.
- **Extensions run with full system permissions.** Relevant if observer prompts ever
  incorporate untrusted repo content.

---

## 5. Suggested build order

1. Skeleton extension + `/muse` command that dumps observer status. Confirms loading,
   `/reload`, settings parsing.
2. `ProposalBus` + `reconcile()` with a **fake** observer that emits a canned advisory.
   Proves the injection path end to end without spending a token.
3. Skill recall observer — no nested agent needed, pure `pi.getCommands()`. First real
   value, cheapest to build.
4. `runner.ts`: persistent nested `AgentSession`. Verify it survives across turns and
   that context accumulates.
5. Memory recall on top of the runner.
6. Goal tracking + `/goal` command + veto budget.
7. Verification, off by default.
8. Optional: widget (`ctx.ui.setWidget`) showing which observers ran and what was
   dropped by the reconciler — Muse's value is partly in it being visible.

---

## Sources

- [Introducing Muse Code and Muse Spark 1.2 — Meta Research](https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2)
- [Build with Muse Code — Meta AI Developers](https://developer.meta.com/ai/resources/blog/build-with-muse-code/)
- [Pi extensions reference](https://pi.dev/docs/latest/extensions)
- Local: `$(npm root -g)/@earendil-works/pi-coding-agent/docs/{extensions,sdk,skills,settings}.md`
- Local: `$(npm root -g)/@earendil-works/pi-coding-agent/examples/extensions/subagent/`
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) — installed at v0.14.3
- [Building pi extensions — Vers docs](https://docs.vers.sh/tutorials/pi-extensions)
- [Pi Agent Extensions: Change the Harness, Not Just the Prompt](https://www.aibuilderclub.com/blog/pi-agent-extensions-guide)
