# pi-observers

File-defined observer agents for [pi](https://pi.dev). Observers watch one axis of
quality each, propose at most a short advisory, and a reconciler decides what reaches
the main agent. They are read-only and never answer on the agent's behalf.

The pattern is inspired by the persistent background agents of Meta's Muse Code
(Meta's own docs are login-gated and name no observer roster; the four bundled here
are this project's design). They ship as worked examples -- plain files in the same
format any observer uses.

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

Drop a markdown file in `.pi/observers/`. Definitions are read from three directories,
lowest precedence first:

| Layer | Directory | Loaded |
|---|---|---|
| bundled | this package's `observers/` | always |
| user | `<agent dir>/observers/` -- `~/.pi/agent/observers/` unless you moved it | always |
| project | `.pi/observers/` in the working directory | **only when the project is trusted** |

A later layer beats an earlier one, so a project definition wins over a user one, which
wins over a bundled one. **Precedence keys on the `name:` field, not the filename** --
to replace the shipped `goal-tracker`, give any file you like `name: goal-tracker` and
yours is used in its place, entirely: prompt, trigger, model, permissions. Overriding
one observer never disturbs the others.

Layers are additive, not exclusive. A bundled observer you have not overridden still
loads -- there is no "use only mine" switch. To run only your own, name the ones you do
not want in `disable` (see Settings).

See [Trust](#trust) for why the project layer is gated and what you see when it is
skipped.

    ---
    name: my-observer
    description: What single axis this watches
    on: turn_end                    # before_agent_start | turn_end | tool_execution_end | agent_settled
    sees: [last_user_message]       # last_assistant_message | tool_calls_this_turn | transcript | skills
    tools: [read, grep]             # read-only only: read, grep, find, ls
    can: [advise]                   # advise, veto
    deliver: next_prompt            # next_prompt | next_turn (both: steer) | settle (follow-up)
    model: anthropic/claude-haiku-4-5
    fallback: [openai-codex/gpt-5.5]
    priority: 50
    ---
    Your system prompt. Call `propose` once, or nothing at all.

Other frontmatter fields, all optional: `enabled` (default `true`), `thinking`
(`off | minimal | low | medium | high | xhigh | max`, default `low`),
`max_advisory_chars` (default `300`), and `timeout_ms` (default `20000`).

Observers cannot write. Anything an observer needs beyond its `sees:` slices, it
fetches with `read`/`grep`.

### Choosing `on:` and `deliver:`

Observers never block a turn, and their proposals are delivered **the moment they are
ready** through pi's own message queues -- there is no waiting for a fixed drain point.
`deliver:` chooses which queue an advisory rides:

| `deliver:` | pi queue | Arrives |
|---|---|---|
| `next_prompt`, `next_turn` | steering | before the run's next model call; appended to the session immediately when idle |
| `settle` | follow-up | once the agent has no more tool calls -- after the work, before the run closes |

The two steering values are aliases: the distinction between them belonged to an older
drain-point design and has no arrival-driven analogue. Use `next_prompt` for guidance
the agent should see as soon as possible, and `settle` for commentary on finished work.

A veto always rides the follow-up queue with a turn trigger, whatever `deliver:` says:
formed mid-run, it holds the run open -- pi will not settle a run past a queued
follow-up -- and formed after the run has settled, it reopens it. At most one veto is
delivered per turn; further vetoes in the same turn are dropped without spending any
budget, and the goal still being unmet next turn is what re-raises them.

Pick `on:` for what the observer needs to *see*, not for when its advice can land:

- `before_agent_start` is the only trigger that sees the request about to run.
- `turn_end` fires once per model round-trip, so a run doing real work kicks the
  observer several times while there is still run left for the advice to land in.
- `agent_settled` is the only trigger that sees the agent's final message.

`tool_calls_this_turn` accumulates over a whole agent run (your request through the
agent's final answer), not one model round-trip, so an observer reading it at
`turn_end` sees everything the agent has done so far in that run. It is reset when you
send a new request. It is **not** reset when an accepted veto reopens a turn: that path
resumes the existing run rather than starting a new one, so the redo's tool calls are
appended to the ones that preceded the veto. An observer judging a post-veto redo sees
the whole run including the vetoed attempt, which is usually what you want and is worth
knowing if you write a prompt that counts calls.

#### What arrival-driven delivery buys, and what it still cannot

Three limitations of the older fixed-drain design are gone or reduced:

- **A `goal-tracker` veto joins the run it judges.** A veto formed while the agent is
  still working is queued as a follow-up, and pi holds the run open for it -- the agent
  addresses the unmet goal inside the same run instead of being sent back after it
  thought it had finished. Only on a single-round-trip answer does the veto form after
  the settle; it then reopens the turn, which is latency, not incorrectness: the goal
  is still unmet when it lands.
- **`skill-recall` reaches the request it read.** Its run starts at
  `before_agent_start` and finishes a few seconds in; the suggestion is steered into
  the run and precedes the next model call. On a single-round-trip answer the run is
  over before the suggestion is ready, and it is appended to the session for the next
  request instead -- the old behaviour, now the fallback rather than the rule.
- **Advice never needs a next prompt to be seen.** A proposal that arrives while the
  session is idle is appended to the session immediately: persisted, displayed, and in
  context for whatever you ask next. Closing the session no longer discards advice that
  was ready; `verification`'s report on the run that just finished is on screen moments
  after the settle.

What remains, and why:

- **A session that ends mid-run discards the run.** In a one-shot `pi -p`, or if you
  quit the instant the answer lands, shutdown aborts observer runs still in flight and
  their verdicts are never formed. Catching them would mean holding shutdown open on a
  model call, which the non-blocking design refuses.
- **A single-round-trip answer is faster than any observer.** An observer's own model
  call measures 1.4-5.5s; a run with no tool work is often shorter. Nothing formed
  during such a run can land inside it. The advice is not lost -- it is appended for
  the next request -- but it cannot inform the answer it was about.

#### Deferral

Delivery is capped at `maxAdvisoriesPerTurn` per turn (the counter resets at each new
request and each settle). Advice over the cap, and advisories that shared a flush with
a veto, are deferred to a later flush rather than dropped -- oldest first, released
into whatever budget the next turn has. The deferral is bounded at 100 proposals with
the oldest evicted first; it does not survive a `/reload`. When an advisory is evicted
the observer's `/observers` row counts it as **dropped**, with the reason, and the
observer is free to raise the same point again -- it is not silently recorded as
delivered.

## Commands

| Command | Effect |
|---|---|
| `/observers` | Status: resolved model, runs, failures, accepted/dropped counts, and why any observer is silent |
| `/observers enable\|disable <name>` | Toggle for this session |
| `/goal <text>` | Declare the goal `goal-tracker` enforces (empty clears) |
| `/remember <text>` | Write a note to `.pi/memory/` |

## Settings

    {
      "observers": {
        "enabled": true,
        "maxAdvisoriesPerTurn": 2,
        "vetoBudget": 3,
        "defaultModel": "anthropic/claude-haiku-4-5",
        "disable": ["verification"]
      }
    }

`maxAdvisoriesPerTurn` and `vetoBudget` are both capped at 10 however high you set them.

### Which model an observer runs on

Every observer is resolved through the same chain, in order, stopping at the first hit:

1. its own `model:`, or `defaultModel` if it declares none
2. each entry in its `fallback:`, in order
3. **the session's own model** -- whatever you are running pi with
4. otherwise the observer is disabled, with the reason shown in `/observers`

Steps 1 and 2 each try an exact match, then a fuzzy one, then the same id under any
provider. So **you do not have to set `defaultModel` at all**: leave it out and every
observer runs on your session model. Setting it is worth doing anyway -- observers are
small, frequent, throwaway calls, and pointing them at something cheap and fast keeps
them off your main model's bill.

A model is only considered for steps 1 and 2 if its provider has configured auth.
That is what makes the chain useful: naming a model you have no credentials for falls
through to your fallbacks and then to the session model, rather than resolving to
something that cannot run.

The gap worth knowing: auth is not the same as *working*. A model that is in pi's
catalog, with auth configured, but which the provider refuses at call time -- a
retired id, a model your account is not entitled to -- resolves successfully. The
observer is then reported active on that model, every run fails, and it is disabled
after three consecutive failures with the provider's error in `/observers`. Nothing
can predict that without making the call; the three-strike disable is the backstop,
and it is why `/observers` reports the last error rather than only a count.

`vetoBudget` is per observer **per fingerprint** -- the string the observer uses to
identify the thing it is objecting to. It is not a bound on its own, because the
fingerprint is chosen by the observer's model: vary it and you get a fresh budget. Two
ceilings derived from `vetoBudget` are the actual bound, and neither is separately
configurable:

| Ceiling | Value | Default | Max |
|---|---|---|---|
| Per observer, any fingerprint | `vetoBudget * 2` | 6 | 20 |
| Session-wide, all observers | `vetoBudget * 4` | 12 | 40 |

They are derived rather than exposed because the only reason anyone raises a backstop is
to get past it, and deriving them keeps the cap of 10 on `vetoBudget` hard-capping them
too. Both survive a `/reload`. When one stops a veto, `/observers` shows it as a dropped
proposal with the ceiling named in the reason.

## Trust

Observer definitions are loaded from three places: the bundled `observers/` directory,
`<agent dir>/observers/`, and the project's own `.pi/observers/`. **The project layer is
loaded only when the project is trusted.**

A definition is not configuration that this extension renders -- it is an agent that
runs, on your credentials, at a trigger the file chooses, reading whatever the process
can read. Precedence keys on the `name` field, so an untrusted project file could
otherwise replace a shipped observer outright rather than merely adding one.

When the layer is skipped and `.pi/observers/` contains at least one `.md` file, you get
a warning at session start and a `not loaded:` line in `/observers` naming the directory
and the reason. An empty `.pi/observers/`, or one holding no definitions, says nothing --
there is nothing that would have loaded. The same two surfaces report a definition that
failed to parse, or a directory that could not be read.

## Design

See `docs/superpowers/specs/2026-08-05-pi-observers-design.md`.
