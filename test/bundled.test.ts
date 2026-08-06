import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverObservers } from "../src/discovery.ts";
import { deliveryOptions } from "../src/index.ts";

const BUILTIN_DIR = join(import.meta.dirname, "..", "observers");

function load() {
  const empty = mkdtempSync(join(tmpdir(), "pi-observers-bundled-"));
  return discoverObservers({
    cwd: empty,
    agentDir: empty,
    builtinDir: BUILTIN_DIR,
    projectTrusted: true,
  });
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

  it("ships enabled states matching the design defaults", () => {
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

  it("uses the triggers and delivery modes from the spec", () => {
    const byName = Object.fromEntries(load().observers.map((o) => [o.name, o]));
    expect(byName["memory-recall"]).toMatchObject({ on: "turn_end", deliver: "next_prompt" });
    // skill-recall stays on before_agent_start: it is the only trigger that sees the
    // request about to run. Under arrival-driven delivery its advice reaches that same
    // request as a steer on any run longer than one round-trip.
    expect(byName["skill-recall"]).toMatchObject({
      on: "before_agent_start",
      deliver: "next_prompt",
    });
    // goal-tracker triggers on turn_end so a multi-round-trip run raises the veto while
    // the run is still open; the follow-up queue then holds the run for it.
    expect(byName["goal-tracker"]).toMatchObject({ on: "turn_end", deliver: "settle" });
    // verification reads the agent's FINAL message, which only exists at agent_settled.
    // Its advice arrives moments after the settle and is appended to the idle session:
    // persisted, displayed, and in context for whatever the user asks next.
    expect(byName.verification).toMatchObject({ on: "agent_settled", deliver: "next_prompt" });
  });

  /**
   * The routing rule, exercised through the SHIPPED deliveryOptions, not a copy of it.
   * An earlier incarnation of this file kept its own copy of the routing rule; when the
   * copy and src/index.ts diverged, the test sided with the copy and a veto consumed at
   * the wrong drain point went unnoticed through 600 tests.
   */
  it("routes every veto to a turn-triggering follow-up, whatever deliver: declares", () => {
    for (const deliver of ["next_prompt", "next_turn", "settle"] as const) {
      expect(deliveryOptions({ kind: "veto", deliver })).toEqual({
        deliverAs: "followUp",
        triggerTurn: true,
      });
    }
  });

  it("routes advisories by their declared deliver:, with next_turn folded into steer", () => {
    expect(deliveryOptions({ kind: "advisory", deliver: "next_prompt" })).toEqual({
      deliverAs: "steer",
    });
    expect(deliveryOptions({ kind: "advisory", deliver: "next_turn" })).toEqual({
      deliverAs: "steer",
    });
    expect(deliveryOptions({ kind: "advisory", deliver: "settle" })).toEqual({
      deliverAs: "followUp",
    });
  });
});
