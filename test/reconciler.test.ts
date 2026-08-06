import { describe, expect, it } from "vitest";
import { Reconciler } from "../src/reconciler.ts";
import type { Proposal } from "../src/types.ts";

function p(over: Partial<Proposal> = {}): Proposal {
  return {
    observer: "o", kind: "advisory", text: "t", fingerprint: "fp",
    priority: 50, deliver: "next_prompt", ...over,
  };
}

describe("Reconciler", () => {
  // Tests from the brief

  it("passes a single advisory through", () => {
    const r = new Reconciler();
    expect(r.reconcile([p()]).advisories).toHaveLength(1);
  });

  it("caps advisories at maxAdvisoriesPerTurn, keeping the highest priority", () => {
    const r = new Reconciler({ maxAdvisoriesPerTurn: 2 });
    const out = r.reconcile([
      p({ fingerprint: "a", priority: 10 }),
      p({ fingerprint: "b", priority: 90 }),
      p({ fingerprint: "c", priority: 50 }),
    ]);
    expect(out.advisories.map((x) => x.fingerprint)).toEqual(["b", "c"]);
    expect(out.dropped.map((d) => d.proposal.fingerprint)).toEqual(["a"]);
  });

  it("drops a fingerprint already accepted earlier in the session", () => {
    const r = new Reconciler();
    expect(r.reconcile([p({ fingerprint: "x" })]).advisories).toHaveLength(1);
    const second = r.reconcile([p({ fingerprint: "x" })]);
    expect(second.advisories).toHaveLength(0);
    expect(second.dropped[0]?.reason).toMatch(/already/i);
  });

  it("does not mark dropped proposals as accepted", () => {
    const r = new Reconciler({ maxAdvisoriesPerTurn: 1 });
    r.reconcile([p({ fingerprint: "a", priority: 90 }), p({ fingerprint: "b", priority: 10 })]);
    // "b" was dropped for budget, not seen — it must still be eligible later.
    expect(r.reconcile([p({ fingerprint: "b", priority: 10 })]).advisories).toHaveLength(1);
  });

  it("returns at most one veto", () => {
    const r = new Reconciler();
    const out = r.reconcile([
      p({ kind: "veto", fingerprint: "v1", priority: 10 }),
      p({ kind: "veto", fingerprint: "v2", priority: 90 }),
    ]);
    expect(out.veto?.fingerprint).toBe("v2");
  });

  it("exhausts the veto budget per fingerprint", () => {
    const r = new Reconciler({ vetoBudget: 2 });
    const veto = () => r.reconcile([p({ kind: "veto", fingerprint: "g" })]).veto;
    expect(veto()).not.toBeNull();
    expect(veto()).not.toBeNull();
    expect(veto()).toBeNull();
  });

  it("keeps separate budgets for different veto fingerprints", () => {
    const r = new Reconciler({ vetoBudget: 1 });
    expect(r.reconcile([p({ kind: "veto", fingerprint: "g1" })]).veto).not.toBeNull();
    expect(r.reconcile([p({ kind: "veto", fingerprint: "g2" })]).veto).not.toBeNull();
  });

  it("restores accepted fingerprints so dedupe survives reload", () => {
    const r = new Reconciler();
    r.restore(["seen"]);
    expect(r.reconcile([p({ fingerprint: "seen" })]).advisories).toHaveLength(0);
  });

  it("reports accepted fingerprints for persistence", () => {
    const r = new Reconciler();
    r.reconcile([p({ fingerprint: "kept" })]);
    expect(r.accepted()).toEqual(["kept"]);
  });

  it("handles an empty input", () => {
    const out = new Reconciler().reconcile([]);
    expect(out).toEqual({ advisories: [], veto: null, dropped: [] });
  });

  // Exploratory tests for edge cases and rigorous behavior

  describe("Exploratory: veto and advisory with same fingerprint", () => {
    it("does not interfere when both have same fingerprint", () => {
      const r = new Reconciler({ maxAdvisoriesPerTurn: 2 });
      const out = r.reconcile([
        p({ kind: "advisory", fingerprint: "shared", priority: 50, text: "advisory" }),
        p({ kind: "veto", fingerprint: "shared", priority: 60, text: "veto" }),
      ]);
      // Veto should be selected (higher priority), advisory should also pass through
      expect(out.veto?.fingerprint).toBe("shared");
      expect(out.veto?.kind).toBe("veto");
      // But the advisory with same fingerprint should still be considered (veto doesn't add to accepted set)
      expect(out.advisories.some((a) => a.fingerprint === "shared" && a.kind === "advisory")).toBe(true);
    });

    it("veto with same fingerprint on second turn allows advisory again", () => {
      const r = new Reconciler();
      // First turn: deliver advisory
      const first = r.reconcile([p({ fingerprint: "x", kind: "advisory" })]);
      expect(first.advisories).toHaveLength(1);
      expect(first.veto).toBeNull();

      // Second turn: same fingerprint as veto (should pass, veto bypasses dedupe)
      const second = r.reconcile([p({ fingerprint: "x", kind: "veto" })]);
      expect(second.veto?.fingerprint).toBe("x");
      // The advisory won't appear since we only get one veto per turn
      // but the key is that the veto can appear with same fingerprint
    });
  });

  describe("Exploratory: budget exhaustion and restore", () => {
    it("after veto budget exhaustion, restore does not affect veto spend", () => {
      const r = new Reconciler({ vetoBudget: 2 });
      // Exhaust budget
      r.reconcile([p({ kind: "veto", fingerprint: "g" })]);
      r.reconcile([p({ kind: "veto", fingerprint: "g" })]);
      const third = r.reconcile([p({ kind: "veto", fingerprint: "g" })]);
      expect(third.veto).toBeNull(); // Budget exhausted

      // Restore accepted (which shouldn't affect veto spend)
      r.restore(["unrelated"]);
      const fourth = r.reconcile([p({ kind: "veto", fingerprint: "g" })]);
      expect(fourth.veto).toBeNull(); // Still exhausted
    });

    it("restore affects advisory dedup but not veto budget", () => {
      const r = new Reconciler();
      r.reconcile([p({ kind: "advisory", fingerprint: "adv" })]);
      expect(r.accepted()).toContain("adv");

      // New reconciler, restore the accepted set
      const r2 = new Reconciler({ vetoBudget: 1 });
      r2.restore(r.accepted());

      // Advisory with same fingerprint should be deduped
      const out = r2.reconcile([p({ kind: "advisory", fingerprint: "adv" })]);
      expect(out.advisories).toHaveLength(0);

      // But veto with same fingerprint should pass (not in veto spend)
      const out2 = r2.reconcile([p({ kind: "veto", fingerprint: "adv" })]);
      expect(out2.veto?.fingerprint).toBe("adv");
    });
  });

  describe("Exploratory: deterministic ordering with equal priority", () => {
    it("orders advisories by input order when priorities are equal", () => {
      const r = new Reconciler({ maxAdvisoriesPerTurn: 3 });
      const out = r.reconcile([
        p({ fingerprint: "a", priority: 50 }),
        p({ fingerprint: "b", priority: 50 }),
        p({ fingerprint: "c", priority: 50 }),
      ]);
      // All have same priority, so sort is stable; they should preserve input order
      // (JavaScript sort is stable as of ES2019)
      const fps = out.advisories.map((x) => x.fingerprint);
      expect(fps).toEqual(["a", "b", "c"]);
    });

    it("with equal priority, higher priority wins if cap is hit", () => {
      const r = new Reconciler({ maxAdvisoriesPerTurn: 2 });
      const out = r.reconcile([
        p({ fingerprint: "a", priority: 50 }),
        p({ fingerprint: "b", priority: 50 }),
        p({ fingerprint: "c", priority: 50 }),
      ]);
      // All have equal priority. First two should pass, third should be dropped.
      expect(out.advisories).toHaveLength(2);
      expect(out.dropped).toHaveLength(1);
      expect(out.dropped[0]?.proposal.fingerprint).toBe("c");
    });
  });

  describe("Exploratory: advisory dropped on turn 1 re-proposed on turn 2", () => {
    it("advisory dropped for budget is re-delivered on next turn", () => {
      const r = new Reconciler({ maxAdvisoriesPerTurn: 1 });

      // Turn 1: two advisories, budget allows 1
      const turn1 = r.reconcile([
        p({ fingerprint: "high", priority: 90 }),
        p({ fingerprint: "low", priority: 10 }),
      ]);
      expect(turn1.advisories.map((a) => a.fingerprint)).toEqual(["high"]);
      expect(turn1.dropped[0]?.proposal.fingerprint).toBe("low");
      expect(r.accepted()).toEqual(["high"]);

      // Turn 2: re-propose the dropped advisory
      const turn2 = r.reconcile([
        p({ fingerprint: "low", priority: 10 }),
      ]);
      expect(turn2.advisories.map((a) => a.fingerprint)).toEqual(["low"]);
      expect(turn2.dropped).toHaveLength(0);
      expect(r.accepted()).toContain("low");
    });

    it("accepted proposals block re-delivery but dropped ones do not", () => {
      const r = new Reconciler({ maxAdvisoriesPerTurn: 2 });

      // Turn 1: three advisories, budget allows 2
      const turn1 = r.reconcile([
        p({ fingerprint: "accepted1", priority: 90 }),
        p({ fingerprint: "accepted2", priority: 80 }),
        p({ fingerprint: "dropped", priority: 10 }),
      ]);
      expect(turn1.advisories).toHaveLength(2);
      expect(turn1.dropped).toHaveLength(1);

      // Turn 2: re-propose all three
      const turn2 = r.reconcile([
        p({ fingerprint: "accepted1", priority: 90 }),
        p({ fingerprint: "accepted2", priority: 80 }),
        p({ fingerprint: "dropped", priority: 10 }),
      ]);
      // Only the dropped one should be accepted; others are deduped
      expect(turn2.advisories.map((a) => a.fingerprint)).toEqual(["dropped"]);
      expect(turn2.dropped).toHaveLength(2);
      expect(turn2.dropped.every((d) => d.reason.match(/already/i))).toBe(true);
    });
  });

  describe("Exploratory: veto re-proposal behavior", () => {
    it("same veto fingerprint can be delivered multiple times up to budget", () => {
      const r = new Reconciler({ vetoBudget: 3 });
      const deliveries: (string | null)[] = [];

      for (let i = 0; i < 4; i++) {
        const out = r.reconcile([p({ kind: "veto", fingerprint: "goal" })]);
        deliveries.push(out.veto?.fingerprint ?? null);
      }

      // First 3 should be delivered, 4th should be null
      expect(deliveries).toEqual(["goal", "goal", "goal", null]);
    });

    it("mixed veto and advisory with shared fingerprint behaves correctly", () => {
      const r = new Reconciler({ maxAdvisoriesPerTurn: 2, vetoBudget: 2 });

      // Turn 1: advisory + veto on same fingerprint
      const turn1 = r.reconcile([
        p({ kind: "advisory", fingerprint: "shared", priority: 50 }),
        p({ kind: "veto", fingerprint: "shared", priority: 60 }),
      ]);

      // Veto should be selected (higher priority)
      expect(turn1.veto?.fingerprint).toBe("shared");
      expect(turn1.veto?.kind).toBe("veto");
      // Advisory should also be delivered since we allow 2 advisories per turn
      expect(turn1.advisories.some((a) => a.fingerprint === "shared" && a.kind === "advisory")).toBe(true);
      // The advisory is now in the accepted set

      // Turn 2: same fingerprint veto should be delivered (veto bypasses dedupe)
      const turn2 = r.reconcile([
        p({ kind: "veto", fingerprint: "shared", priority: 50 }),
      ]);
      // This veto should be delivered because vetoes bypass the accepted-set filter
      expect(turn2.veto?.fingerprint).toBe("shared");
      expect(turn2.veto?.kind).toBe("veto");

      // Turn 3: re-propose the advisory (should be deduped)
      const turn3 = r.reconcile([
        p({ kind: "advisory", fingerprint: "shared", priority: 50 }),
      ]);
      // Advisory should NOT be delivered because it was already accepted in turn1
      expect(turn3.advisories.map((a) => a.fingerprint)).not.toContain("shared");
      expect(turn3.dropped.some((d) => d.reason.match(/already/i))).toBe(true);
    });
  });
});
