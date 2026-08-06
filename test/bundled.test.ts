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
      "goal-tracker", "memory-recall", "skill-recall", "verification",
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
    expect(byName["skill-recall"]).toMatchObject({ on: "before_agent_start", deliver: "next_prompt" });
    expect(byName["goal-tracker"]).toMatchObject({ on: "agent_settled", deliver: "settle" });
    expect(byName.verification).toMatchObject({ on: "agent_settled", deliver: "settle" });
  });
});
