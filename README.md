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
    model: lunaroute/deepseek-v4-flash
    fallback: [anthropic/claude-haiku-4-5]
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
needs to finish. A `can: [veto]` observer must never trigger on its own delivery point
-- a late veto reopens the turn after the one whose work it judged.

`tool_calls_this_turn` accumulates over a whole agent run (your request through the
agent's final answer), not one model round-trip, so an observer reading it at
`turn_end` sees everything the agent has done so far in that run.

#### Known limitation: `skill-recall` advises the next request

`skill-recall` is the one bundled observer that cannot follow the rule above. Its job
is to suggest a skill for the request that is *about to* run, so `before_agent_start`
is the only trigger that sees the right request -- and that handler is also where
`next_prompt` is drained. Its suggestion therefore lands on your **next** request
rather than the current one.

This is a consequence of the non-blocking design, not an oversight. Serving the current
request would mean holding it open while a second model call finished, which is latency
on every request to catch the minority that need a skill. If you want that trade, the
change is a bounded await in the `before_agent_start` handler; nothing in the observer
format needs to change.

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
        "defaultModel": "lunaroute/deepseek-v4-flash",
        "disable": ["verification"]
      }
    }

## Design

See `docs/superpowers/specs/2026-08-05-pi-observers-design.md`.
