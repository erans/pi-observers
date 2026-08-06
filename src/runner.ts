import {
  type CreateAgentSessionOptions,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
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

/**
 * The slice of `AgentSession` the runner actually uses. Narrow on purpose: tests
 * substitute a fake through `createSession`, and this states exactly what such a
 * fake owes us. The real `createAgentSession` satisfies it structurally.
 */
interface ObserverSession {
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export type SessionFactory = (
  opts: CreateAgentSessionOptions,
) => Promise<{ session: ObserverSession }>;

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
  if (emitLines.length === 0) {
    // `can: ""` in frontmatter parses to an empty list, and createOutputTools then
    // registers nothing. Inviting a call that does not exist would waste the turn.
    emitLines.push("- You have no output tools available. There is nothing for you to call.");
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
  // `systemPromptOverride` / `appendSystemPromptOverride` pair: those are transform
  // callbacks over whatever pi discovered, not replacements, and relying on them
  // would leave the discovery itself running. Had the observer prompt silently
  // failed to apply, every observer would run with pi's default CODING-AGENT
  // system prompt and lose the whole read-only, propose-or-stay-silent framing.
  //
  // `systemPrompt` is a prompt *source*: pi treats it as a file path when one exists
  // at that path and as a literal otherwise. Observer prompts are multi-line prose,
  // never a path, so they resolve as literals. Passing it also suppresses pi's own
  // system-prompt file discovery, which is the point. `appendSystemPrompt: []`
  // likewise suppresses discovery of an append-prompt file (pi only discovers when
  // the option is absent, and an empty array is present); omitting it would let a
  // project's append file leak into every observer.
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

  // Built ONCE, before the session exists, and never replaced. The model only ever
  // sees the tool objects handed to createAgentSession, so rebuilding them per run
  // would leave it writing into a collector nobody reads. The collector is reset
  // instead, at the top of each run. The session itself persists, so its context
  // accumulates across wakes rather than re-reading the same files every turn.
  const { tools, collector } = createOutputTools(def);

  const factory: SessionFactory = opts.createSession ?? createAgentSession;

  const { session } = await factory({
    cwd,
    agentDir,
    // ModelLike is our narrow view of pi's Model; the registry hands us the real one.
    model: model as never,
    thinkingLevel: def.thinking,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    tools: def.tools,
    customTools: tools,
  });

  let disposed = false;
  let running = false;

  return {
    name: def.name,
    async run(state, signal) {
      // A kick that outlived dispose() has nothing to say; prompting a disposed
      // session is undefined behaviour, and silence is the observer's normal output.
      if (disposed) return null;
      if (signal.aborted) return null;
      // One collector serves every run, so two overlapping runs would misattribute
      // one run's proposal to the other. This IS reachable in production: ProposalBus
      // races each run against a timeout and clears its own `inflight` slot in a
      // `.finally()` that fires the instant the timeout wins — independently of
      // whether the underlying session.prompt() has actually returned. A wedged run
      // therefore leaves `running` true here long after the bus is willing to issue
      // the next kick. Failing loudly turns that wedge into three counted failures
      // (and a disabled observer) instead of a crossed or lost proposal.
      if (running) {
        throw new Error(
          `Observer ${def.name} is already running: a previous run has not finished ` +
            "(it may be wedged past its own timeout, which releases the bus's slot " +
            "without stopping the underlying prompt) rather than this call being a " +
            "caller error.",
        );
      }
      running = true;

      collector.reset();
      const rendered = renderSlices(def.sees, state);
      const prompt = rendered === "" ? "Observe now." : `Observe now.\n\n${rendered}`;

      // session.prompt() takes no AbortSignal — PromptOptions carries none — so the
      // only way to cancel an in-flight run is session.abort(). Without this bridge,
      // an aborted or timed-out observer keeps running and burning tokens: the bus
      // stops waiting for it, but nothing stops the run itself.
      const onAbort = () => {
        // Fire and forget, and synchronously: deferring would let the caller's own
        // abort() return before the session hears about it. A failed abort must not
        // surface as an unhandled rejection.
        void session.abort().catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        // Untrusted slice content is folded into `prompt` above. pi's prompt-template,
        // skill-command and extension-command expansion is already starved of
        // anything to expand into (noExtensions/noSkills/noPromptTemplates above leave
        // the resourceLoader empty), and separately gated on the text starting with
        // "/" — which our wake text never does, only because it happens to start
        // "Observe now.". Passing expandPromptTemplates: false makes the injection
        // safety structural instead of resting on either of those: expansion cannot
        // run here even if a future change repopulated the loader or changed the
        // wake prefix.
        await session.prompt(prompt, { expandPromptTemplates: false });
      } finally {
        // Always remove it: the session outlives the run, and a listener per run
        // would accumulate for the life of the session.
        signal.removeEventListener("abort", onAbort);
        running = false;
      }
      // Whatever landed after the bus stopped waiting is not ours to deliver.
      if (signal.aborted) return null;
      return collector.take();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // A run started before dispose() owns no signal telling it to stop; without
      // this, it would keep prompting a session we are about to tear down. Fire
      // and forget, like the abort bridge above: a failed abort must not surface
      // as an unhandled rejection, and dispose() itself is synchronous.
      if (running) void session.abort().catch(() => {});
      session.dispose();
    },
  };
}
