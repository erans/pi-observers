import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createOutputTools } from "../src/outputs.ts";
import { buildObserverSystemPrompt, createObserverRunner } from "../src/runner.ts";
import { renderSlices } from "../src/slices.ts";
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

  // --- beyond the brief -------------------------------------------------

  it("tells a veto-only observer about veto and never about propose", () => {
    const prompt = buildObserverSystemPrompt(defOf({ can: ["veto"] }));
    expect(prompt).toContain("call `veto`");
    expect(prompt).not.toContain("call `propose`");
  });

  it("does not invite any tool call when the definition permits neither", () => {
    // `can: ""` in frontmatter parses to [], so createOutputTools registers no
    // tools at all. Inviting a call the model cannot make wastes a turn.
    const prompt = buildObserverSystemPrompt(defOf({ can: [] }));
    expect(prompt).not.toContain("call `propose`");
    expect(prompt).not.toContain("call `veto`");
    expect(prompt).toMatch(/no output tools/i);
  });

  it("states the definition's own character budget", () => {
    expect(buildObserverSystemPrompt(defOf({ maxAdvisoryChars: 137 }))).toContain("137");
    expect(buildObserverSystemPrompt(defOf({ maxAdvisoryChars: 137 }))).not.toContain("300");
  });

  it("puts the file body first, trimmed", () => {
    const prompt = buildObserverSystemPrompt(defOf({ systemPrompt: "\n\n  Watch memory.  \n\n" }));
    expect(prompt.startsWith("Watch memory.\n")).toBe(true);
  });

  it("tells the observer its prose reply is discarded", () => {
    expect(buildObserverSystemPrompt(defOf())).toMatch(/prose reply is discarded/i);
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

// ---------------------------------------------------------------------------
// Beyond the brief. Everything below probes a way the runner could be wrong
// while still passing every test above.
// ---------------------------------------------------------------------------

/** A fake pi session whose prompt() behaviour the test supplies. */
function harness(
  // biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
  onPrompt: (ctx: { tools: any[]; text: string }) => unknown = () => {},
) {
  // biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
  let tools: any[] = [];
  const prompts: string[] = [];
  const session = {
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      await onPrompt({ tools, text });
    }),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural stand-in for pi options
  const factory = vi.fn(async (opts: any) => {
    tools = opts.customTools ?? [];
    return { session };
  });
  return { factory, session, prompts, options: () => factory.mock.calls[0]?.[0] };
}

// biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
const emit = (tools: any[], name: string, params: unknown) =>
  tools.find((t) => t.name === name)?.execute("id", params, undefined, undefined, {});

function build(h: ReturnType<typeof harness>, over: Partial<ObserverDefinition> = {}) {
  return createObserverRunner({
    def: defOf(over), model: { provider: "p", id: "m" }, cwd: "/tmp",
    agentDir: "/tmp/agent", createSession: h.factory as never,
  });
}

describe("createObserverRunner (exploratory)", () => {
  /**
   * A cwd/agentDir pair seeded with every file pi would otherwise fold into a
   * session: a global SYSTEM.md, a global APPEND_SYSTEM.md, a project context
   * file, a user skill, an extension, a prompt template and a theme. Asserting
   * emptiness against a bare /tmp would pass no matter what the loader was told,
   * so the fixture is what gives the hermeticity assertions teeth.
   *
   * Extensions, prompt templates and themes were the gap in the original fixture:
   * with nothing seeded for them, `getExtensions().extensions === []` and friends
   * were vacuously true whether or not `noExtensions`/`noPromptTemplates`/
   * `noThemes` were even passed. Each one now has a real file that pi's loader
   * would pick up unless the suppression is doing its job.
   */
  function leakyFixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-observers-runner-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(agentDir, "skills", "leaky"), { recursive: true });
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(agentDir, "prompts"), { recursive: true });
    mkdirSync(join(agentDir, "themes"), { recursive: true });
    writeFileSync(join(agentDir, "SYSTEM.md"), "GLOBAL-SYSTEM-PROMPT-LEAK\n");
    writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL-APPEND-LEAK\n");
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT-CONTEXT-LEAK\n");
    writeFileSync(
      join(agentDir, "skills", "leaky", "SKILL.md"),
      "---\nname: leaky\ndescription: should never reach an observer\n---\n\nbody\n",
    );
    writeFileSync(join(agentDir, "extensions", "leaky.js"), "export default function(pi){}\n");
    writeFileSync(
      join(agentDir, "prompts", "leaky.md"),
      "---\nname: leaky-prompt\ndescription: x\n---\nbody\n",
    );
    // A full, schema-valid theme (copied from pi's built-in dark.json, renamed):
    // a theme missing required color tokens fails validation and never reaches
    // `getThemes().themes` at all, which would make a `noThemes` assertion pass
    // vacuously the same way the original fixture did for the other three.
    writeFileSync(
      join(agentDir, "themes", "leaky.json"),
      JSON.stringify({
        name: "leaky-theme",
        vars: {
          cyan: "#00d7ff", blue: "#5f87ff", green: "#b5bd68", red: "#cc6666",
          yellow: "#ffff00", text: "#d4d4d4", gray: "#808080", dimGray: "#666666",
          darkGray: "#505050", accent: "#8abeb7", selectedBg: "#3a3a4a",
          userMsgBg: "#343541", toolPendingBg: "#282832", toolSuccessBg: "#283228",
          toolErrorBg: "#3c2828", customMsgBg: "#2d2838",
        },
        colors: {
          accent: "accent", border: "blue", borderAccent: "cyan", borderMuted: "darkGray",
          success: "green", error: "red", warning: "yellow", muted: "gray", dim: "dimGray",
          text: "text", thinkingText: "gray", selectedBg: "selectedBg",
          userMessageBg: "userMsgBg", userMessageText: "text", customMessageBg: "customMsgBg",
          customMessageText: "text", customMessageLabel: "#9575cd",
          toolPendingBg: "toolPendingBg", toolSuccessBg: "toolSuccessBg",
          toolErrorBg: "toolErrorBg", toolTitle: "text", toolOutput: "gray",
          mdHeading: "#f0c674", mdLink: "#81a2be", mdLinkUrl: "dimGray", mdCode: "accent",
          mdCodeBlock: "green", mdCodeBlockBorder: "gray", mdQuote: "gray",
          mdQuoteBorder: "gray", mdHr: "gray", mdListBullet: "accent",
          toolDiffAdded: "green", toolDiffRemoved: "red", toolDiffContext: "gray",
          syntaxComment: "#6A9955", syntaxKeyword: "#569CD6", syntaxFunction: "#DCDCAA",
          syntaxVariable: "#9CDCFE", syntaxString: "#CE9178", syntaxNumber: "#B5CEA8",
          syntaxType: "#4EC9B0", syntaxOperator: "#D4D4D4", syntaxPunctuation: "#D4D4D4",
          thinkingOff: "darkGray", thinkingMinimal: "#6e6e6e", thinkingLow: "#5f87af",
          thinkingMedium: "#81a2be", thinkingHigh: "#b294bb", thinkingXhigh: "#d183e8",
          thinkingMax: "#ff5fff", bashMode: "green",
        },
      }),
    );
    fixtures.push(root);
    return { cwd, agentDir };
  }

  const fixtures: string[] = [];
  afterAll(() => {
    for (const root of fixtures) rmSync(root, { recursive: true, force: true });
  });

  it("hands the session a resource loader carrying the observer's own system prompt", async () => {
    // Defect guard: if the loader options ever stop applying, every observer runs
    // with pi's default coding-agent prompt and loses the read-only framing.
    const h = harness();
    const { cwd, agentDir } = leakyFixture();
    await createObserverRunner({
      def: defOf(), model: { provider: "p", id: "m" }, cwd, agentDir,
      createSession: h.factory as never,
    });
    const loader = h.options().resourceLoader;
    expect(loader.getSystemPrompt()).toBe(buildObserverSystemPrompt(defOf()));
    expect(loader.getSystemPrompt()).toContain("read-only");
    expect(loader.getSystemPrompt()).not.toContain("GLOBAL-SYSTEM-PROMPT-LEAK");
    // Defect guard for the *sibling* mistake: `systemPromptOverride` is a transform
    // callback over whatever pi discovered on disk, not a replacement. Swapping the
    // shipped `systemPrompt` option for `systemPromptOverride: () => systemPrompt`
    // would pass every assertion above (the callback's return value is what
    // `getSystemPrompt()` reports) while still running `discoverSystemPromptFile()`
    // against the fixture's real SYSTEM.md — which is exactly the discovery this
    // hermetic construction exists to suppress. `getSystemPromptSource()` is the
    // only observable that tells the two apart: it reports the discovered file's
    // path under the override form, and is undefined under the literal-source form
    // shipped here.
    expect(loader.getSystemPromptSource()).toBeUndefined();
  });

  it("suppresses append-prompt discovery so no project file leaks in", async () => {
    const h = harness();
    const { cwd, agentDir } = leakyFixture();
    await createObserverRunner({
      def: defOf(), model: { provider: "p", id: "m" }, cwd, agentDir,
      createSession: h.factory as never,
    });
    expect(h.options().resourceLoader.getAppendSystemPrompt()).toEqual([]);
    expect(h.options().resourceLoader.getAppendSystemPromptSources()).toEqual([]);
  });

  it("loads no extensions, skills, prompts, themes or context files into the nested session", async () => {
    const h = harness();
    const { cwd, agentDir } = leakyFixture();
    await createObserverRunner({
      def: defOf(), model: { provider: "p", id: "m" }, cwd, agentDir,
      createSession: h.factory as never,
    });
    const loader = h.options().resourceLoader;
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  });

  it("passes cwd, agentDir, model, thinking level and output tools to the factory", async () => {
    const h = harness();
    await build(h, { thinking: "medium", can: ["advise", "veto"] });
    const opts = h.options();
    expect(opts.cwd).toBe("/tmp");
    expect(opts.agentDir).toBe("/tmp/agent");
    expect(opts.model).toEqual({ provider: "p", id: "m" });
    expect(opts.thinkingLevel).toBe("medium");
    // biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
    expect(opts.customTools.map((t: any) => t.name).sort()).toEqual(["propose", "veto"]);
    // A real `SessionManager.create(cwd)` would also satisfy `toBeDefined()` and would
    // write observer transcripts into the user's own session store. `isPersisted()` is
    // the one observable that tells `create()` and `inMemory()` apart.
    expect(opts.sessionManager).toBeDefined();
    expect(opts.sessionManager.isPersisted()).toBe(false);
  });

  it("names itself after the definition", async () => {
    const h = harness();
    expect((await build(h)).name).toBe("memory-recall");
  });

  it("renders the requested slices into the prompt body", async () => {
    const h = harness();
    const runner = await build(h);
    await runner.run({ lastUserMessage: "banana pudding" }, new AbortController().signal);
    expect(h.prompts[0]).toContain("banana pudding");
    expect(h.prompts[0]).toBe(
      `Observe now.\n\n${renderSlices(["last_user_message"], { lastUserMessage: "banana pudding" })}`,
    );
  });

  it("sends a bare wake when the observer sees nothing", async () => {
    const h = harness();
    const runner = await build(h, { sees: [] });
    await runner.run({ lastUserMessage: "ignored" }, new AbortController().signal);
    expect(h.prompts[0]).toBe("Observe now.");
  });

  it("disables prompt-template/skill/extension-command expansion on every prompt call", async () => {
    // Untrusted slice content lands in this text. pi only expands prompt templates,
    // skill commands and extension commands when the text starts with "/" AND
    // expandPromptTemplates is not false — the wake text here never starts with "/",
    // but that must not be the only thing preventing expansion: a future edit to the
    // "Observe now." prefix must not silently reopen this path.
    const h = harness();
    const runner = await build(h);
    await runner.run({ lastUserMessage: "a" }, new AbortController().signal);
    // biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
    const call = (h.session.prompt as any).mock.calls[0];
    expect(call[1]).toMatchObject({ expandPromptTemplates: false });
  });

  it("passes each run's own state, not the first run's", async () => {
    const h = harness();
    const runner = await build(h);
    await runner.run({ lastUserMessage: "first" }, new AbortController().signal);
    await runner.run({ lastUserMessage: "second" }, new AbortController().signal);
    expect(h.prompts[1]).toContain("second");
    expect(h.prompts[1]).not.toContain("first");
  });

  it("does not replay the first run's proposal when the second run stays silent", async () => {
    // The tools are created once and bound to a collector that outlives the run,
    // so without a reset the second run inherits the first run's proposal.
    let turn = 0;
    const h = harness(async ({ tools }) => {
      turn += 1;
      if (turn === 1) await emit(tools, "propose", { advisory: "first", fingerprint: "a" });
    });
    const runner = await build(h);
    const first = await runner.run({}, new AbortController().signal);
    const second = await runner.run({}, new AbortController().signal);
    expect(first?.text).toBe("first");
    expect(second).toBeNull();
  });

  it("emits again on a later run after a silent one", async () => {
    let turn = 0;
    const h = harness(async ({ tools }) => {
      turn += 1;
      if (turn === 2) await emit(tools, "propose", { advisory: "later", fingerprint: "b" });
    });
    const runner = await build(h);
    await runner.run({}, new AbortController().signal);
    expect((await runner.run({}, new AbortController().signal))?.text).toBe("later");
  });

  it("routes the tools captured at session creation, not a stale collector", async () => {
    // The model only ever sees the tool objects handed to createAgentSession once.
    // If run() rebuilt the tool set, those objects would write to a dead collector.
    const h = harness(async ({ tools }) => {
      await emit(tools, "propose", { advisory: "still wired", fingerprint: "c" });
    });
    const runner = await build(h);
    await runner.run({}, new AbortController().signal);
    const second = await runner.run({}, new AbortController().signal);
    expect(second?.text).toBe("still wired");
  });

  it("propagates a failing prompt() and leaves no listener behind", async () => {
    const h = harness(() => {
      throw new Error("model exploded");
    });
    const runner = await build(h);
    const controller = new AbortController();
    await expect(runner.run({}, controller.signal)).rejects.toThrow("model exploded");
    controller.abort();
    // A listener leaked by the failing run would call through to the session here.
    expect(h.session.abort).toHaveBeenCalledTimes(0);
  });

  it("does not carry a failed run's proposal into the next run", async () => {
    let turn = 0;
    const h = harness(async ({ tools }) => {
      turn += 1;
      if (turn === 1) {
        await emit(tools, "propose", { advisory: "doomed", fingerprint: "d" });
        throw new Error("model exploded after proposing");
      }
    });
    const runner = await build(h);
    await expect(runner.run({}, new AbortController().signal)).rejects.toThrow();
    expect(await runner.run({}, new AbortController().signal)).toBeNull();
  });

  it("discards a proposal made before the signal fired", async () => {
    let release: () => void = () => {};
    const h = harness(async ({ tools }) => {
      await emit(tools, "propose", { advisory: "too late", fingerprint: "e" });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const runner = await build(h);
    const controller = new AbortController();
    const pending = runner.run({}, controller.signal);
    await Promise.resolve();
    controller.abort();
    release();
    expect(await pending).toBeNull();
  });

  it("does not prompt at all when the signal is already aborted", async () => {
    const h = harness();
    const runner = await build(h);
    const controller = new AbortController();
    controller.abort();
    expect(await runner.run({}, controller.signal)).toBeNull();
    expect(h.session.prompt).toHaveBeenCalledTimes(0);
  });

  it("disposes the session exactly once however many times dispose is called", async () => {
    const h = harness();
    const runner = await build(h);
    runner.dispose();
    runner.dispose();
    runner.dispose();
    expect(h.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("stays silent instead of prompting a disposed session", async () => {
    const h = harness();
    const runner = await build(h);
    runner.dispose();
    expect(await runner.run({ lastUserMessage: "a" }, new AbortController().signal)).toBeNull();
    expect(h.session.prompt).toHaveBeenCalledTimes(0);
  });

  it("aborts a run that is still in flight when dispose is called", async () => {
    // Without this, a run started before dispose() keeps prompting a session that
    // dispose() has already torn down.
    let release: () => void = () => {};
    const h = harness(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runner = await build(h);
    const pending = runner.run({}, new AbortController().signal);
    runner.dispose();
    expect(h.session.abort).toHaveBeenCalledTimes(1);
    release();
    await pending;
  });

  it("refuses overlapping runs rather than crossing their collectors", async () => {
    let release: () => void = () => {};
    const h = harness(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runner = await build(h);
    const first = runner.run({}, new AbortController().signal);
    await expect(runner.run({}, new AbortController().signal)).rejects.toThrow(/already running/i);
    release();
    await first;
    expect(h.session.prompt).toHaveBeenCalledTimes(1);
  });

  it("accepts a further run once an overlapping attempt was rejected", async () => {
    let release: () => void = () => {};
    const h = harness(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runner = await build(h);
    const first = runner.run({}, new AbortController().signal);
    await expect(runner.run({}, new AbortController().signal)).rejects.toThrow(/already running/i);
    release();
    await first;
    release = () => {};
    // The in-flight flag must clear in a finally, not only on the happy path.
    const h2Promise = runner.run({}, new AbortController().signal);
    release();
    await h2Promise;
    expect(h.session.prompt).toHaveBeenCalledTimes(2);
  });

  it("gives a veto-only observer just the veto tool and returns its veto", async () => {
    const h = harness(async ({ tools }) => {
      await emit(tools, "veto", { reason: "tests not run", fingerprint: "v1" });
    });
    const runner = await build(h, { can: ["veto"] });
    // biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
    expect(h.options().customTools.map((t: any) => t.name)).toEqual(["veto"]);
    expect(await runner.run({}, new AbortController().signal)).toMatchObject({
      kind: "veto", text: "tests not run", observer: "memory-recall",
    });
  });

  it("registers no output tools when the definition permits neither capability", async () => {
    const h = harness();
    const runner = await build(h, { can: [] });
    expect(h.options().customTools).toEqual([]);
    expect(await runner.run({}, new AbortController().signal)).toBeNull();
  });

  it("carries the definition's priority and deliver onto the proposal", async () => {
    const h = harness(async ({ tools }) => {
      await emit(tools, "propose", { advisory: "x", fingerprint: "f" });
    });
    const runner = await build(h, { priority: 12, deliver: "settle" });
    expect(await runner.run({}, new AbortController().signal)).toMatchObject({
      priority: 12, deliver: "settle",
    });
  });
});

// The runner keeps one collector for the life of the session, so reset() is the
// only thing separating one wake from the next. Tested here, next to its only
// consumer, so test/outputs.test.ts stays exactly as it was reviewed.
describe("collector reset (the contract the runner relies on)", () => {
  it("clears the proposal and the warnings, and admits a new proposal", async () => {
    const { tools, collector } = createOutputTools(defOf({ maxAdvisoryChars: 300 }));
    await emit(tools, "propose", { advisory: "first", fingerprint: "a" });
    await emit(tools, "propose", { advisory: "ignored", fingerprint: "b" });
    expect(collector.take()?.text).toBe("first");
    expect(collector.warnings.length).toBe(1);

    collector.reset();
    expect(collector.take()).toBeNull();
    expect(collector.warnings).toEqual([]);

    await emit(tools, "propose", { advisory: "second", fingerprint: "c" });
    expect(collector.take()?.text).toBe("second");
  });

  it("keeps the warnings array identity so a captured reference stays live", () => {
    const { collector } = createOutputTools(defOf());
    const captured = collector.warnings;
    collector.reset();
    expect(collector.warnings).toBe(captured);
  });
});
