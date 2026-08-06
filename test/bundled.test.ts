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
      "goal-tracker",
      "memory-recall",
      "skill-recall",
      "verification",
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
    expect(byName["skill-recall"]).toMatchObject({
      on: "before_agent_start",
      deliver: "next_prompt",
    });
    // Both moved off `agent_settled`. See SELF_DRAINING_TRIGGERS below for why.
    expect(byName["goal-tracker"]).toMatchObject({ on: "turn_end", deliver: "settle" });
    // verification reads the agent's FINAL message, which only exists at agent_settled:
    // the last turn_end is followed by agent_settled within microseconds, so a turn_end
    // trigger always delivers a proposal formed from some earlier, mid-run message.
    // It advises rather than vetoes, so next_prompt (drained at before_agent_start) is
    // both correct and the earliest point the advice can be used.
    expect(byName.verification).toMatchObject({ on: "agent_settled", deliver: "next_prompt" });
  });

  /**
   * The delivery point each lifecycle handler in src/index.ts drains in the SAME
   * synchronous body in which it kicks its observers.
   *
   * An observer whose trigger appears here, mapped to its own delivery point, can never
   * be delivered on the occurrence that triggered it: bus.kick() resolves the run on a
   * later tick -- deliberately, so an observer never adds latency to a turn -- so the
   * run cannot have landed by the drain that immediately follows. Its proposal always
   * waits for the NEXT occurrence, and in a session with only one, it is never
   * delivered at all.
   */
  const SELF_DRAINING_TRIGGERS: Record<string, string> = {
    before_agent_start: "next_prompt",
    agent_settled: "settle",
  };

  it("never lets a veto-capable observer trigger on its own delivery point", () => {
    // The rule, not the instance. A veto that arrives one occurrence late reopens the
    // turn AFTER the one whose work it judged, sending the agent back to redo work it
    // has already moved past -- which is wrong, not merely delayed.
    let checked = 0;
    for (const o of load().observers) {
      if (!o.can.includes("veto")) continue;
      checked += 1;
      // What matters is where the proposal is ACTUALLY drained, not what `deliver:`
      // says. src/index.ts routes every veto to `settle` regardless of the definition
      // (a veto is only actionable while the turn can still be reopened), so an
      // `on: agent_settled` veto-capable observer is self-draining whatever `deliver`
      // claims -- and reading `o.deliver` here would wave it through.
      const effectiveDeliver = o.can.includes("veto") ? "settle" : o.deliver;
      expect(SELF_DRAINING_TRIGGERS[o.on]).not.toBe(effectiveDeliver);
    }
    // Without this the test passes by checking nothing the day someone drops the last
    // veto-capable observer.
    expect(checked).toBeGreaterThan(0);
  });

  it("pins skill-recall as the only accepted self-draining observer", () => {
    // skill-recall genuinely cannot be moved: its job is to suggest a skill for the
    // request that is about to run, and there is no earlier trigger that still sees
    // that request. It advises the NEXT request instead, which is documented in its
    // definition and in the README. This test exists so the exception cannot quietly
    // grow a second member.
    const selfDraining = load()
      .observers.filter((o) => SELF_DRAINING_TRIGGERS[o.on] === o.deliver)
      .map((o) => o.name);
    expect(selfDraining).toEqual(["skill-recall"]);
  });
});
