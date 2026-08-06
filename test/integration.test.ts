import { describe, expect, it, vi } from "vitest";
import { ProposalBus } from "../src/bus.ts";
import { Reconciler } from "../src/reconciler.ts";
import { createObserverRunner } from "../src/runner.ts";
import type { DeliveryPoint, ObserverDefinition } from "../src/types.ts";

function defOf(over: Partial<ObserverDefinition> = {}): ObserverDefinition {
  return {
    name: "fake",
    description: "d",
    enabled: true,
    on: "turn_end",
    sees: [],
    tools: [],
    can: ["advise"],
    deliver: "next_prompt",
    fallback: [],
    thinking: "low",
    priority: 50,
    maxAdvisoryChars: 300,
    timeoutMs: 50,
    systemPrompt: "b",
    sourcePath: "/o.md",
    scope: "builtin",
    ...over,
  };
}

/** A fake session whose "model" always calls propose once. */
function proposingFactory(text: string) {
  return vi.fn(async (opts: { customTools?: unknown[] }) => ({
    session: {
      prompt: vi.fn(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: fake tool invocation
        const propose = (opts.customTools as any[]).find((t) => t.name === "propose");
        await propose.execute(
          "id",
          { advisory: text, fingerprint: "fp" },
          undefined,
          undefined,
          {},
        );
      }),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    },
  }));
}

async function runOnce(def: ObserverDefinition, factory: unknown) {
  const bus = new ProposalBus();
  const runner = await createObserverRunner({
    def,
    model: { provider: "p", id: "m" },
    cwd: "/tmp",
    agentDir: "/tmp/agent",
    createSession: factory as never,
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
          await veto.execute(
            "id",
            { reason: "tests not run", fingerprint: "g" },
            undefined,
            undefined,
            {},
          );
        }),
        abort: vi.fn(async () => {}),
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
        abort: vi.fn(async () => {}),
        dispose: vi.fn(),
      },
    }));
    const bus = await runOnce(defOf(), factory);
    expect(bus.drain()).toEqual([]);
    expect(bus.status("fake").failures).toBe(1);
  });

  it("a hanging observer times out and counts a failure", async () => {
    // No outer `Promise.race` against the signal here (unlike the brief this test
    // was drafted from): src/runner.ts already bridges an aborted signal to
    // `session.abort()` internally, and ProposalBus.kick (src/bus.ts) races every
    // run against its own timeout independently of whether `run()` itself ever
    // settles. A hung `session.prompt()` therefore still yields a counted failure
    // through the bus's own timeout branch with no extra racing needed at the
    // call site. Confirmed empirically: the un-simplified brief version (an
    // identical outer race, plus a fake session missing `abort`) passes all
    // assertions but throws an unrelated uncaught `TypeError: session.abort is
    // not a function` from src/runner.ts's abort bridge, because that fake
    // session did not implement the full `ObserverSession` interface. Giving the
    // fake session a real (no-op) `abort` and dropping the redundant outer race
    // removes that uncaught error and still passes.
    const factory = vi.fn(async () => ({
      session: {
        prompt: vi.fn(() => new Promise(() => {})), // never resolves
        abort: vi.fn(async () => {}),
        dispose: vi.fn(),
      },
    }));
    const bus = new ProposalBus();
    const def = defOf({ timeoutMs: 20 });
    const runner = await createObserverRunner({
      def,
      model: { provider: "p", id: "m" },
      cwd: "/tmp",
      agentDir: "/tmp/agent",
      createSession: factory as never,
    });
    bus.kick(def.name, def.timeoutMs, (signal) => runner.run({}, signal));
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
