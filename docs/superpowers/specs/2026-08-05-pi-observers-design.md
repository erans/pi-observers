# pi-observers — design

Date: 2026-08-05
Status: approved, pending implementation plan

A pi extension that runs file-defined **observer agents** alongside the main session.
Each observer watches one axis of quality and may propose a short advisory into the
main agent's work. Observers never answer for the agent and never write: they propose,
a reconciler decides, and only accepted proposals reach the main agent.

The pattern is taken from Meta's Muse Code. The four observers Muse ships are bundled
here as worked examples, but they hold no privileged position — they are plain files in
the same format any user-authored observer uses.

---

## 1. Goals and non-goals

**Goals**

- Define an observer entirely in a markdown file. No TypeScript required to add one.
- Ship Muse Code's four observers as bundled defaults.
- Never let an observer block, slow, or break the main agent loop.
- Never let an observer mutate the workspace.
- Make the framework's expressiveness provable: if the bundled four need no special
  cases, the vocabulary is sufficient.

**Non-goals**

- Not a task-agent spawner. `@tintinweb/pi-subagents` and the official `subagent`
  example already cover delegated work. Observers are passive watchers.
- No autonomous memory writing. Populating `.pi/memory/` is a separate, user-driven act.
- No new agent-definition standard. The format deliberately echoes pi agent frontmatter.

---

## 2. Concept

An observer is a **read-only constrained agent** with four declarative properties:

| Property | Field | Meaning |
|---|---|---|
| When it wakes | `on:` | a pi lifecycle event |
| What it sees | `sees:` | a slice of session state, injected as its prompt |
| What it can fetch | `tools:` | read-only pi tools |
| What it may emit | `can:` | which output tools get registered in its session |

Everything an observer needs beyond its context slice, it fetches itself with `read` /
`grep`. This is the central design decision: **tools are the escape hatch.** It keeps
the `sees:` vocabulary small and stops it growing a special case per observer.

---

## 3. Observer file format

Discovery precedence, same name wins:

1. `.pi/observers/*.md` — project (loaded only after project trust)
2. `~/.pi/agent/observers/*.md` — global (via `getAgentDir()`, honors `$PI_CODING_AGENT_DIR`)
3. bundled defaults shipped in the package

Overriding one observer does not disturb the others.

```yaml
---
name: goal-tracker
description: Hold the agent to a declared goal
enabled: true

on: agent_settled
sees: [last_user_message, transcript]
tools: [read, grep]
can: [advise, veto]
deliver: settle

model: lunaroute/deepseek-v4-flash
fallback: [anthropic/claude-haiku-4-5]
thinking: low
priority: 80
max_advisory_chars: 300
timeout_ms: 20000
---
You watch exactly one axis: whether the goal declared in
.pi/observers/state/goal.md has actually been met.

Read that file. If no goal is declared, emit nothing.
If the goal is met, emit nothing.
If it is not met, call veto once with a single sentence naming what remains.
Never call veto more than once. Never comment on anything but the goal.
```

### Field reference

| Field | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | — | Unique id. Filename need not match. |
| `description` | yes | — | Shown in `/observers`. |
| `enabled` | no | `true` | Off means never loaded, never costed. |
| `on` | yes | — | Trigger event. See §4. |
| `sees` | no | `[]` | Context slices. See §5. |
| `tools` | no | `[]` | Read-only pi tools. See §6. |
| `can` | no | `[advise]` | `advise`, `veto`, or both. See §7. |
| `deliver` | no | `next_prompt` | Where an accepted proposal lands. See §8. |
| `model` | no | settings `defaultModel`, else inherit | Preferred model. See §9. |
| `fallback` | no | `[]` | Ordered alternates. See §9. |
| `thinking` | no | `low` | pi thinking level. |
| `priority` | no | `50` | Reconciler ranking when over budget. |
| `max_advisory_chars` | no | `300` | Proposals longer than this are rejected. |
| `timeout_ms` | no | `20000` | Run is aborted past this; counts as a failure. |

Unknown fields are a load error, not a warning — a typo'd field silently doing nothing
is worse than a startup complaint.

---

## 4. Triggers (`on:`)

Each maps to one pi extension event.

| `on:` | pi event | Fires |
|---|---|---|
| `before_agent_start` | `before_agent_start` | once per user prompt, before the loop |
| `turn_end` | `turn_end` | after each agent turn inside the loop |
| `tool_execution_end` | `tool_execution_end` | after each tool call completes |
| `agent_settled` | `agent_settled` | when pi will not continue on its own |

Exactly one trigger per observer. Multiple triggers would make the dedupe and budget
semantics ambiguous for no proven benefit.

---

## 5. Context slices (`sees:`)

Rendered into the observer's prompt as labelled sections, in the order listed.

| Slice | Content |
|---|---|
| `last_user_message` | Text of the most recent user message. |
| `last_assistant_message` | Text of the most recent assistant message, thinking excluded. |
| `tool_calls_this_turn` | Name, abbreviated args, and error status per tool call in the current turn. |
| `transcript` | Active branch via `sessionManager.buildContextEntries()`, compaction applied, truncated tail-first to a token budget. |
| `skills` | Available skills from `pi.getCommands()` filtered to `source === "skill"`, as name + description. |

Deliberately excluded: goal state, memory notes, changed files. Each of those is a file
an observer reads with its own tools. Adding them as slices would be the first step
toward one slice per bundled observer.

Slices unavailable at a given trigger render as an explicit `(unavailable)` marker
rather than being silently omitted.

---

## 6. Tools

Permitted: `read`, `grep`, `find`, `ls`.

`write`, `edit`, `bash`, and any extension-registered tool not on the allowlist are
rejected at load time with a clear error. This is enforced by the framework, not left
to convention — an observer that can run `bash` is not an observer.

Consequence, accepted deliberately: **an observer cannot maintain its own state file.**
State that must persist across wakes is either written by a command (`/goal`,
`/remember`) or carried in the observer's own accumulating session context.

---

## 7. Output contract (`can:`)

The observer's session is registered with output tools according to `can:`. These are
its only means of emitting anything; its prose final message is discarded.

```ts
// registered when can: includes "advise"
propose({
  advisory: string,      // the nudge, <= max_advisory_chars
  fingerprint: string,   // stable dedupe key for this specific advice
})

// registered when can: includes "veto"
veto({
  reason: string,        // one sentence: what remains undone
  fingerprint: string,
})
```

Not calling either tool is how an observer says "nothing to add". This is the common
case, and it costs one cheap turn with no parsing and no schema round-trip.

A second call in the same run is ignored with a logged warning. `veto` from an observer
whose `can:` omits it is impossible — the tool is simply absent.

---

## 8. Delivery (`deliver:`)

| `deliver:` | Injection point | Mechanism |
|---|---|---|
| `next_prompt` | `before_agent_start` | return `{ message: {...} }` — persisted, sent to the LLM |
| `next_turn` | `context` | append to the returned `messages` deep copy, mid-loop |
| `settle` | `agent_settled` | `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` |

Trigger and delivery are independent fields. An observer may wake at `turn_end` but
deliver at `next_prompt`, which is exactly what memory recall wants: observe cheaply
during the loop, speak before the next prompt.

A `veto` always delivers at `settle` regardless of `deliver:`, since its entire purpose
is to reopen a turn that was about to close.

---

## 9. Model resolution

If a file omits `model:`, the settings `defaultModel` is substituted before resolution
begins. If settings also omit it, resolution starts at step 5.

Resolution order, first hit wins:

1. `model:` exact match in the registry
2. fuzzy match under the named provider (`.`/`-` equivalence, optional trailing
   `-YYYYMMDD` date stamp)
3. same bare model id under any authenticated provider
4. each `fallback:` entry in order, each running steps 1-3
5. the main session's current model
6. **disable the observer** with a visible warning in `/observers` and a startup notice

Never silently inert and never silently expensive. Step 5 exists so a misconfigured
observer still functions; step 6 exists so a totally unresolvable one says so loudly.

---

## 10. Runtime

### Lifecycle

```
session_start      → load settings, discover + validate observer files,
                     resolve models, create one AgentSession per enabled observer,
                     restore reconciler state from session entries
<trigger event>    → bus.kick(observer)          fire-and-forget, never awaited
                     └→ session.prompt(rendered slices)
                        └→ propose()/veto() → proposal queue
<delivery point>   → bus.drain() → reconcile() → inject
session_shutdown   → dispose all sessions (idempotent)
```

Per pi's docs, all long-lived resources are created in `session_start`, never in the
extension factory, and cleaned up idempotently in `session_shutdown`.

### Persistence of observer sessions

One `AgentSession` per observer, created once and reused across every wake. Because the
session object survives, its context accumulates — the observer is not re-reading the
same files every turn. This is Muse's persistence claim, and it falls out of the SDK for
free.

Each observer session uses `SessionManager.inMemory()`. Observer conversations are not
written to the session directory.

### Non-blocking guarantee

`bus.kick()` starts the run and returns immediately. No lifecycle handler ever awaits an
observer. A delivery point drains whatever proposals have landed by then; anything still
in flight is considered at the next delivery point. One run per observer at a time —
a re-trigger while in flight is dropped, not queued.

### Reconciler

```ts
reconcile(proposals) -> { advisories: Proposal[], veto: Proposal | null }
```

1. Drop any proposal whose `fingerprint` was already accepted this session.
2. Drop advisories exceeding their observer's `max_advisory_chars`.
3. Sort by `priority` descending; take at most `maxAdvisoriesPerTurn` (default 2).
4. At most one veto. Each distinct veto `fingerprint` has a budget (default 3); an
   exhausted budget drops the veto and logs it.

The budget is what stops a goal observer from becoming an infinite agent loop.

### Reconciler state and replay

Accepted proposals are recorded with `pi.appendEntry("observers-accepted", { fingerprint,
observer, advisory })`. On `session_start` the reconciler rebuilds its accepted-fingerprint
set and veto budgets by scanning `ctx.sessionManager.getEntries()` for those entries.
Dedupe therefore survives `/reload`, resume, and replay — a resumed session does not
re-surface advice it already gave.

Failure counts are per-process and deliberately not persisted: a reload is a reasonable
moment to give a failing observer another chance.

---

## 11. Bundled observers

All four ship. Enabled state matches Muse Code's own defaults.

| File | `on` | `deliver` | `can` | Enabled |
|---|---|---|---|---|
| `memory-recall.md` | `turn_end` | `next_prompt` | advise | yes |
| `skill-recall.md` | `before_agent_start` | `next_prompt` | advise | yes |
| `goal-tracker.md` | `agent_settled` | `settle` | advise, veto | yes |
| `verification.md` | `agent_settled` | `settle` | advise | **no** |

- **memory-recall** — `sees: [last_user_message]`, `tools: [read, grep]`. Greps
  `.pi/memory/*.md` frontmatter descriptions and surfaces at most one relevant note.
- **skill-recall** — `sees: [last_user_message, skills]`, no tools. Proposes loading a
  skill the task should start with.
- **goal-tracker** — `sees: [last_user_message, transcript]`, `tools: [read]`. Reads
  `.pi/observers/state/goal.md`; vetoes while the goal is unmet.
- **verification** — `sees: [last_assistant_message, tool_calls_this_turn]`,
  `tools: [read]`. Checks claimed work against the actual tool record. Off by default,
  matching Muse.

### Memory store

`.pi/memory/<slug>.md`, one note per file:

```yaml
---
name: slug
description: one line, this is what ranking matches against
type: project | feedback | reference | user
---
The note body.
```

Written only by `/remember`. No observer writes it, and nothing writes it autonomously.
An empty store is fine: memory-recall greps, finds nothing, and emits nothing.

---

## 12. Settings

`~/.pi/agent/settings.json`, or project settings, under a `observers` key. Paths built
with `CONFIG_DIR_NAME`, never a hardcoded `.pi`.

```jsonc
{
  "observers": {
    "enabled": true,
    "maxAdvisoriesPerTurn": 2,
    "vetoBudget": 3,
    "defaultModel": "lunaroute/deepseek-v4-flash",
    "disable": ["verification"]
  }
}
```

Per-file `enabled:` and settings `disable` are both honored; either one off means off.

---

## 13. Commands

| Command | Effect |
|---|---|
| `/observers` | Status: each observer's resolved model, enabled state, runs, failures, proposals accepted vs dropped. |
| `/observers enable\|disable <name>` | Toggle for this session. |
| `/goal <text>` | Write `.pi/observers/state/goal.md`. No argument clears it. |
| `/remember <text>` | Write a note to `.pi/memory/`. See below. |

`/remember` writes `.pi/memory/<slug>.md`. The slug and one-line `description` are
derived from the text deterministically — first six words, lowercased and kebab-cased,
for the slug; the first sentence, truncated to 100 chars, for the description. No model
call. A slug collision appends `-2`, `-3`, and so on. `type` defaults to `project` and
may be set with a `--type` flag.

---

## 14. Error handling

- Every observer run is wrapped; rejections are swallowed at the bus boundary and
  recorded. A failing observer can never propagate into a lifecycle handler.
- `timeout_ms` aborts a run via `AbortSignal`; counts as a failure.
- Three consecutive failures disable that observer for the session, with a notice.
- Invalid frontmatter is a load-time error naming the file and field. The offending
  observer is skipped; others load normally.
- Observer runs honor `ctx.signal` so a user abort cancels in-flight observers.

---

## 15. Module layout

```
src/
  index.ts            factory: wiring, lifecycle, command registration
  settings.ts         load + merge the observers settings block
  definitions.ts      discover, parse, validate observer files
  models.ts           resolution + fallback chain
  runner.ts           persistent AgentSession per observer
  slices.ts           render sees: into prompt sections
  outputs.ts          propose / veto tool definitions
  bus.ts              ProposalBus: kick, drain, failure tracking
  reconciler.ts       dedupe, rank, budget, veto arbitration
  commands/           observers.ts, goal.ts, remember.ts
  memory.ts           .pi/memory read + append
observers/            the four bundled .md files
```

---

## 16. Testing

Logic lives in pure functions so the bulk of the suite needs no model and no pi runtime.

**Unit (vitest, no I/O)**
- frontmatter parse + validation, including every rejection path (unknown field,
  disallowed tool, bad trigger, `veto` without `can: veto`)
- model resolution across all six steps, including the disable case
- `reconcile()`: dedupe, priority ranking, count cap, char cap, veto budget exhaustion
- slice rendering, including `(unavailable)` markers
- memory note parse + ranking

**Integration (fake observer, no tokens)**
- a stub observer emitting a canned proposal, asserted to arrive at each of the three
  delivery points
- a throwing observer, asserted not to break the turn
- a hanging observer, asserted to time out and count a failure
- three failures, asserted to disable

**Manual**
- `pi -e ./src/index.ts` in a scratch project, `/observers` reports four loaded,
  `/goal` then an incomplete task produces exactly one veto

---

## 17. Open items

- Package name `pi-observers`; the working directory is currently `pi-muse`. Rename or
  leave — cosmetic, user's call.
- No git repository initialized in the working directory yet.
- Whether `verification` should ship enabled rather than matching Muse's default.
