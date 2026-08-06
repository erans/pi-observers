# pi-observers

File-defined observer agents for [pi](https://pi.dev). Observers watch one axis of
quality each, propose at most a short advisory, and a reconciler decides what reaches
the main agent. They are read-only and never answer on the agent's behalf.

The pattern is taken from Meta's Muse Code. Its four observers ship as bundled
examples -- they are plain files in the same format any observer uses.

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

Observers never block a turn. A run started by a lifecycle event resolves after that
event's handler has already returned, so **an observer whose `on:` trigger is the same
event that drains its `deliver:` point is always one occurrence late** -- and in a
session with only one such occurrence, it is never delivered at all.

Two triggers drain a delivery point in the same handler that starts the run:

| `on:` | drains |
|---|---|
| `before_agent_start` | `next_prompt` |
| `agent_settled` | `settle` |

So pick a trigger *earlier* than your delivery point. `on: turn_end` with
`deliver: settle` is the reliable pairing for anything judging finished work: an agent
run doing real work has several turns before it settles, which is the room the observer
needs to finish.

A `can: [veto]` observer must never trigger on its own delivery point -- a late veto
reopens the turn after the one whose work it judged. For a veto, "its own delivery
point" is **always `settle`**, whatever `deliver:` says: holding the turn open is only
meaningful there, so every veto is routed to `settle` and the `deliver:` field is
ignored for it. Setting `deliver: next_prompt` on a `can: [veto]` observer does not move
its veto and does not make `on: agent_settled` safe. Read the row above as
`agent_settled` drains every veto, full stop.

`tool_calls_this_turn` accumulates over a whole agent run (your request through the
agent's final answer), not one model round-trip, so an observer reading it at
`turn_end` sees everything the agent has done so far in that run. It is reset when you
send a new request. It is **not** reset when an accepted veto reopens a turn: that path
resumes the existing run rather than starting a new one, so the redo's tool calls are
appended to the ones that preceded the veto. An observer judging a post-veto redo sees
the whole run including the vetoed attempt, which is usually what you want and is worth
knowing if you write a prompt that counts calls.

#### Known limitation: a `goal-tracker` veto can arrive after the work is done

`goal-tracker` triggers on `turn_end` and delivers at `settle`, which keeps it off its
own delivery point -- but it is still racing the agent. Its veto lands on the first
`settle` that follows its model call, and if the agent finishes the rest of its work
faster than that call takes, the veto arrives after the run is over. It then reopens the
turn and the agent addresses the unmet goal a beat later than it could have.

The residual is *latency, not incorrectness*: what arrives late is a veto that was true
when it was formed and is still true now, since the goal is still unmet. It never sends
the agent back over work it had rightly moved past. Closing it entirely would mean
blocking the turn on a model call, which the design refuses for every observer.

#### Known limitation: `skill-recall` advises the next request

`skill-recall` is the one bundled observer that cannot follow the rule above. Its job
is to suggest a skill for the request that is *about to* run, so `before_agent_start`
is the only trigger that sees the right request -- and that handler is also where
`next_prompt` is drained. Its suggestion therefore lands on your **next** request
rather than the current one.

At that trigger the request has not been recorded in the session yet, so
`last_user_message` is taken from the event rather than looked up. Reading the session
there returns the *previous* request, or nothing at all on the first request of a
session -- which is what `skill-recall` was actually being handed until this was fixed:
an empty slice, and a prompt asking it to choose a skill with no request in hand.

This is a consequence of the non-blocking design, not an oversight. Serving the current
request would mean holding it open while a second model call finished, which is latency
on every request to catch the minority that need a skill. If you want that trade, the
change is a bounded await in the `before_agent_start` handler; nothing in the observer
format needs to change.

#### Known limitation: a `next_prompt` advisory needs a next prompt

The same mechanism, one delivery point over. `verification` triggers at `agent_settled`
and delivers at `next_prompt`, which is drained at `before_agent_start` -- so if you
close the session, or never send another request, its advice about the run that just
finished is never shown.

Advice that misses its moment is deferred rather than discarded, in two places, and both
are bounded at 100 proposals with the oldest dropped first:

- a proposal whose delivery point has not come round yet waits for it;
- an advisory that was ready at a `settle` where a veto took priority waits for the next
  `settle`, and is then released at no more than `maxAdvisoriesPerTurn` per turn.

The second queue does not survive a `/reload`, and either queue can drop its oldest
entries under sustained load. When that happens the advisory is counted as **dropped**
for its observer in `/observers`, with the reason, and the observer is free to raise the
same point again -- it is not silently recorded as delivered.

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
