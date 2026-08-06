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
