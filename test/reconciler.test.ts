import { describe, expect, it } from "vitest";
import { Reconciler } from "../src/reconciler.ts";
import type { Proposal } from "../src/types.ts";

function p(over: Partial<Proposal> = {}): Proposal {
  return {
    observer: "o",
    kind: "advisory",
    text: "t",
    fingerprint: "fp",
    priority: 50,
    deliver: "next_prompt",
    ...over,
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
      expect(out.advisories.some((a) => a.fingerprint === "shared" && a.kind === "advisory")).toBe(
        true,
      );
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

  describe("restore: replayed veto spend", () => {
    it("restores veto spend so a reload does not refund the budget", () => {
      const r = new Reconciler({ vetoBudget: 2 });
      r.restore([], [{ observer: "o", fingerprint: "g", count: 2 }]);
      expect(r.reconcile([p({ kind: "veto", fingerprint: "g" })]).veto).toBeNull();
    });

    it("leaves budget for a fingerprint spent fewer times than the budget", () => {
      const r = new Reconciler({ vetoBudget: 2 });
      r.restore([], [{ observer: "o", fingerprint: "g", count: 1 }]);
      expect(r.reconcile([p({ kind: "veto", fingerprint: "g" })]).veto?.fingerprint).toBe("g");
      expect(r.reconcile([p({ kind: "veto", fingerprint: "g" })]).veto).toBeNull();
    });

    it("reports the exhausted veto as dropped, with a reason", () => {
      const r = new Reconciler({ vetoBudget: 1 });
      r.restore([], [{ observer: "o", fingerprint: "g", count: 1 }]);
      const out = r.reconcile([p({ kind: "veto", fingerprint: "g" })]);
      expect(out.dropped).toHaveLength(1);
      expect(out.dropped[0]?.proposal.fingerprint).toBe("g");
      expect(out.dropped[0]?.reason).toMatch(/budget/i);
    });

    it("keeps veto spend per fingerprint, not global", () => {
      const r = new Reconciler({ vetoBudget: 1 });
      r.restore([], [{ observer: "o", fingerprint: "spent", count: 1 }]);
      expect(r.reconcile([p({ kind: "veto", fingerprint: "other" })]).veto?.fingerprint).toBe(
        "other",
      );
    });

    it("still works when no veto spend is supplied at all", () => {
      const r = new Reconciler({ vetoBudget: 1 });
      r.restore(["adv"]);
      expect(r.reconcile([p({ fingerprint: "adv" })]).advisories).toHaveLength(0);
      expect(r.reconcile([p({ kind: "veto", fingerprint: "adv" })]).veto).not.toBeNull();
    });
  });

  describe("veto ceiling: the fingerprint budget is not a bound", () => {
    it("stops a veto loop that varies its fingerprint every drain", () => {
      // The measured defect: the per-fingerprint budget keys on a string the observer's
      // model chooses, so varying it buys a fresh budget on every drain. With 25 drains
      // a stable fingerprint yields 3 accepted vetoes and a varying one yielded 25 --
      // and since each accepted veto reopens the turn, that is an unbounded loop.
      const r = new Reconciler({ vetoBudget: 3 });
      let accepted = 0;
      for (let drain = 0; drain < 25; drain++) {
        if (r.reconcile([p({ kind: "veto", fingerprint: `varies-${drain}` })]).veto) accepted += 1;
      }
      expect(accepted).toBe(6); // vetoBudget * 2, the per-observer ceiling
    });

    it("still allows the full per-fingerprint budget for a stable fingerprint", () => {
      const r = new Reconciler({ vetoBudget: 3 });
      let accepted = 0;
      for (let drain = 0; drain < 25; drain++) {
        if (r.reconcile([p({ kind: "veto", fingerprint: "stable" })]).veto) accepted += 1;
      }
      expect(accepted).toBe(3);
    });

    it("applies the ceiling per observer, not globally", () => {
      const r = new Reconciler({ vetoBudget: 1 });
      for (let i = 0; i < 5; i++) {
        r.reconcile([p({ kind: "veto", observer: "noisy", fingerprint: `f${i}` })]);
      }
      expect(
        r.reconcile([p({ kind: "veto", observer: "noisy", fingerprint: "new" })]).veto,
      ).toBeNull();
      // A different observer is unaffected.
      expect(
        r.reconcile([p({ kind: "veto", observer: "quiet", fingerprint: "new" })]).veto,
      ).not.toBeNull();
    });

    it("reports a ceilinged veto as dropped, naming the observer", () => {
      const r = new Reconciler({ vetoBudget: 1 });
      r.reconcile([p({ kind: "veto", fingerprint: "a" })]);
      r.reconcile([p({ kind: "veto", fingerprint: "b" })]);
      const out = r.reconcile([p({ kind: "veto", fingerprint: "c" })]);
      expect(out.veto).toBeNull();
      expect(out.dropped[0]?.reason).toMatch(/ceiling/i);
      expect(out.dropped[0]?.reason).toContain("o");
    });

    it("does not let one observer spend another's budget via a colliding fingerprint", () => {
      const r = new Reconciler({ vetoBudget: 1 });
      expect(
        r.reconcile([p({ kind: "veto", observer: "a", fingerprint: "same" })]).veto,
      ).not.toBeNull();
      // Same fingerprint, different observer: its own budget is untouched.
      expect(
        r.reconcile([p({ kind: "veto", observer: "b", fingerprint: "same" })]).veto,
      ).not.toBeNull();
    });

    it("replays the ceiling, so a reload does not refill it", () => {
      const r = new Reconciler({ vetoBudget: 1 });
      r.restore(
        [],
        [
          { observer: "o", fingerprint: "a", count: 1 },
          { observer: "o", fingerprint: "b", count: 1 },
        ],
      );
      expect(r.reconcile([p({ kind: "veto", fingerprint: "fresh" })]).veto).toBeNull();
    });
  });

  describe("session-wide veto ceiling", () => {
    // Measured before this existed: 1, 5, and 50 veto-capable observers produced 6, 30,
    // and 300 accepted vetoes. Nothing bounds the number of observers a project defines
    // -- src/discovery.ts loads every .pi/observers/*.md it finds -- so a per-observer
    // ceiling scales linearly with a count the project controls.
    const acceptedWith = (observerCount: number): number => {
      const r = new Reconciler({ vetoBudget: 3 });
      let accepted = 0;
      for (let drain = 0; drain < 25; drain++) {
        for (let i = 0; i < observerCount; i++) {
          if (
            r.reconcile([p({ kind: "veto", observer: `obs-${i}`, fingerprint: `f${drain}` })]).veto
          ) {
            accepted += 1;
          }
        }
      }
      return accepted;
    };

    it("does not scale with the number of veto-capable observers", () => {
      expect(acceptedWith(1)).toBe(6); // per-observer ceiling, vetoBudget * 2
      expect(acceptedWith(5)).toBe(12); // session ceiling, vetoBudget * 4 -- not 30
      expect(acceptedWith(50)).toBe(12); // and not 300
    });

    it("is derived from vetoBudget, so settings.ts's cap of 10 hard-caps it", () => {
      // Deliberately not its own setting: a backstop's only exposure use is raising it.
      expect(acceptedWith(50)).toBe(12);
      const r = new Reconciler({ vetoBudget: 10 });
      let accepted = 0;
      for (let drain = 0; drain < 200; drain++) {
        if (
          r.reconcile([p({ kind: "veto", observer: `obs-${drain}`, fingerprint: `f${drain}` })])
            .veto
        ) {
          accepted += 1;
        }
      }
      expect(accepted).toBe(40);
    });

    it("names the session ceiling in its own drop reason, not the per-observer one", () => {
      const r = new Reconciler({ vetoBudget: 1 });
      for (let i = 0; i < 4; i++) {
        r.reconcile([p({ kind: "veto", observer: `obs-${i}`, fingerprint: "g" })]);
      }
      const out = r.reconcile([p({ kind: "veto", observer: "fresh", fingerprint: "g" })]);
      expect(out.veto).toBeNull();
      expect(out.dropped[0]?.reason).toMatch(/session-wide/i);
      expect(out.dropped[0]?.reason).not.toMatch(/ceiling of \d+ vetoes this session/);
    });

    it("lets a single observer hit its own ceiling first, so the diagnosis stays specific", () => {
      // The session multiplier is strictly larger than the per-observer one, or the
      // session ceiling would mask the more useful message for the common case.
      const r = new Reconciler({ vetoBudget: 1 });
      r.reconcile([p({ kind: "veto", fingerprint: "a" })]);
      r.reconcile([p({ kind: "veto", fingerprint: "b" })]);
      const out = r.reconcile([p({ kind: "veto", fingerprint: "c" })]);
      expect(out.dropped[0]?.reason).toMatch(/observer "o"/);
    });

    it("replays the session ceiling, so a reload does not refill it", () => {
      const r = new Reconciler({ vetoBudget: 1 });
      r.restore(
        [],
        Array.from({ length: 4 }, (_, i) => ({
          observer: `obs-${i}`,
          fingerprint: "g",
          count: 1,
        })),
      );
      expect(
        r.reconcile([p({ kind: "veto", observer: "fresh", fingerprint: "g" })]).veto,
      ).toBeNull();
    });
  });

  describe("vetoKey: the composite must be injective", () => {
    it("does not collide when a part contains the separator", () => {
      // observer "a" + fingerprint "b:c" once produced the same key as observer "a:b"
      // + fingerprint "c", and restore()'s set() overwrite turned that into a REFUND of
      // an exhausted budget. Neither part is under this module's control: `observer` is
      // frontmatter, `fingerprint` comes off a model tool call.
      expect(Reconciler.vetoKey("a", "b:c")).not.toBe(Reconciler.vetoKey("a:b", "c"));
    });

    it("does not collide when a part contains the NUL used as the length delimiter", () => {
      const nul = "\u0000";
      expect(Reconciler.vetoKey("a", `b${nul}c`)).not.toBe(Reconciler.vetoKey(`a${nul}b`, "c"));
      expect(Reconciler.vetoKey(`${nul}`, "x")).not.toBe(Reconciler.vetoKey("", `${nul}x`));
    });

    it("does not collide on a plain concatenation boundary", () => {
      expect(Reconciler.vetoKey("ab", "c")).not.toBe(Reconciler.vetoKey("a", "bc"));
    });

    it("refuses to refund an exhausted budget through a colliding replay", () => {
      // The behavioural consequence, not just the string property.
      // Budget 3 so a replayed count of 1 is strictly LOWER than what has been spent:
      // that is the direction in which a colliding key refunds rather than exhausts.
      const r = new Reconciler({ vetoBudget: 3 });
      for (let i = 0; i < 3; i++) {
        expect(
          r.reconcile([p({ kind: "veto", observer: "a", fingerprint: "b:c" })]).veto,
        ).not.toBeNull();
      }
      expect(r.reconcile([p({ kind: "veto", observer: "a", fingerprint: "b:c" })]).veto).toBeNull();
      // A different observer/fingerprint pair that collided under the old `:` join.
      r.restore([], [{ observer: "a:b", fingerprint: "c", count: 1 }]);
      expect(r.reconcile([p({ kind: "veto", observer: "a", fingerprint: "b:c" })]).veto).toBeNull();
    });
  });

  describe("restore: replayed state is untrusted input", () => {
    // Session entries are replayed on every reload and accumulate across sessions, and
    // the fingerprints in them come off a model tool call with no length limit
    // anywhere upstream. Unbounded replay is a durable memory-growth vector for a
    // repo-resident observer definition.

    it("bounds how many fingerprints a replay can add", () => {
      const r = new Reconciler();
      const many = Array.from({ length: 5000 }, (_, i) => `fp-${i}`);
      r.restore(many);
      expect(r.accepted().length).toBeLessThanOrEqual(1000);
    });

    it("keeps the most recent fingerprints, not the oldest", () => {
      // The recently accepted advisory is the one about to be repeated. Keeping the
      // head would silence dedupe exactly where it matters.
      const r = new Reconciler();
      const many = Array.from({ length: 5000 }, (_, i) => `fp-${i}`);
      r.restore(many);
      expect(r.accepted()).toContain("fp-4999");
      expect(r.accepted()).not.toContain("fp-0");
    });

    it("rejects an over-long fingerprint rather than truncating it", () => {
      // Truncating would collapse two advisories sharing a long prefix onto one key,
      // silently suppressing the second. Rejecting only costs a repeated advisory.
      const r = new Reconciler();
      const huge = "x".repeat(5000);
      r.restore([huge]);
      expect(r.accepted()).toHaveLength(0);
      expect(r.reconcile([p({ fingerprint: huge })]).advisories).toHaveLength(1);
    });

    it("ignores blank and non-string fingerprints", () => {
      const r = new Reconciler();
      r.restore(["", "   ", null as unknown as string, 42 as unknown as string, "real"]);
      expect(r.accepted()).toEqual(["real"]);
    });

    it("rejects an over-long fingerprint on the veto-spend key too", () => {
      // The key is what bounds the spend map, so validating only the first restore
      // argument leaves the same growth vector open on the second.
      const r = new Reconciler({ vetoBudget: 1 });
      const huge = "x".repeat(5000);
      r.restore([], [{ observer: "o", fingerprint: huge, count: 1 }]);
      // The key was rejected, so no spend was recorded and the veto is still affordable.
      expect(r.reconcile([p({ kind: "veto", fingerprint: huge })]).veto).not.toBeNull();
    });

    it("rejects an over-long observer name on the veto-spend key", () => {
      // `observer` is frontmatter from a repo-resident definition -- if anything the
      // more attacker-controlled half of the key.
      const r = new Reconciler({ vetoBudget: 1 });
      const huge = "o".repeat(5000);
      r.restore([], [{ observer: huge, fingerprint: "g", count: 1 }]);
      expect(
        r.reconcile([p({ kind: "veto", observer: huge, fingerprint: "g" })]).veto,
      ).not.toBeNull();
    });

    it("restores nothing at all when the observer is blank or not a string", () => {
      // `observer` gates BOTH halves: with no usable observer there is no ceiling to
      // credit and no key to spend against.
      const r = new Reconciler({ vetoBudget: 1 });
      r.restore(
        [],
        [
          { observer: "   ", fingerprint: "g", count: 1 },
          { observer: 42 as unknown as string, fingerprint: "g", count: 1 },
          { observer: null as unknown as string, fingerprint: "g", count: 1 },
        ],
      );
      // Before reconcile(), which would credit the ceiling itself and mask this.
      expect(r.stateSize().vetoObservers).toBe(0);
      expect(r.stateSize().vetoSpend).toBe(0);
      expect(r.reconcile([p({ kind: "veto", fingerprint: "g" })]).veto).not.toBeNull();
    });

    it("still credits the ceiling when only the FINGERPRINT is unusable", () => {
      // The refund. `fingerprint` is model-chosen and has no length limit upstream, so
      // skipping the whole entry on a bad fingerprint let an observer decide whether its
      // own ceiling survived a reload -- by emitting a 5000-character fingerprint, or a
      // blank one. Measured before the fix: six such entries bought six more vetoes.
      // The ceiling exists to be the part the model cannot influence.
      const r = new Reconciler({ vetoBudget: 1 });
      r.restore(
        [],
        [
          { observer: "o", fingerprint: "x".repeat(5000), count: 1 },
          { observer: "o", fingerprint: "", count: 1 },
        ],
      );
      // Ceiling (vetoBudget * 2 = 2) is spent, so a fresh fingerprint buys nothing.
      expect(r.reconcile([p({ kind: "veto", fingerprint: "brand-new" })]).veto).toBeNull();
      // ...but the unusable fingerprints were NOT admitted to the keyed spend map.
      expect(r.stateSize().vetoSpend).toBe(0);
      expect(r.stateSize().vetoObservers).toBe(1);
    });

    it("bounds how many veto-spend entries a replay can add", () => {
      // Distinct observers, so the per-observer ceiling does not mask the map cap.
      const r = new Reconciler({ vetoBudget: 1 });
      const many = Array.from({ length: 5000 }, (_, i) => ({
        observer: `obs-${i}`,
        fingerprint: "g",
        count: 1,
      }));
      r.restore([], many);
      // Asserted on the map sizes, not on a reconcile() outcome: once the session
      // ceiling is exhausted every subsequent decision is identical whatever the replay
      // size, so a behavioural assertion here would pass for any cap at all.
      expect(r.stateSize().vetoSpend).toBe(1000);
      expect(r.stateSize().vetoObservers).toBe(1000);
    });

    it("bounds the ceiling map when every fingerprint is unusable", () => {
      // Crediting the ceiling on a valid observer alone means an entry can now grow the
      // ceiling map WITHOUT growing the spend map. A cap that watches only the spend map
      // therefore never trips, and the growth vector reopens on the other side.
      const r = new Reconciler({ vetoBudget: 1 });
      r.restore(
        [],
        Array.from({ length: 5000 }, (_, i) => ({
          observer: `obs-${i}`,
          fingerprint: "",
          count: 1,
        })),
      );
      expect(r.stateSize().vetoSpend).toBe(0);
      expect(r.stateSize().vetoObservers).toBe(1000);
    });

    it("bounds the spend map for a single observer with many fingerprints", () => {
      // The other half of the cap. One observer emitting 5000 distinct fingerprints is
      // the shape a runaway model actually produces, and the existing test used 5000
      // distinct OBSERVERS -- so a mutant removing the cap grew vetoSpend to 5000 here
      // and nothing noticed.
      const r = new Reconciler({ vetoBudget: 1 });
      r.restore(
        [],
        Array.from({ length: 5000 }, (_, i) => ({
          observer: "one",
          fingerprint: `fp-${i}`,
          count: 1,
        })),
      );
      expect(r.stateSize().vetoSpend).toBe(1000);
      expect(r.stateSize().vetoObservers).toBe(1);
    });

    it("clamps a replayed count to the budget rather than storing it verbatim", () => {
      // This clamp used to be inert -- `spent >= budget` compared the same way whether
      // the stored value was the budget or MAX_SAFE_INTEGER. It stopped being inert when
      // the ceiling started being credited from `spent`, because the ceiling is a SUM.
      // An entry claiming a count of 4 against a budget of 3 now costs a different
      // amount of ceiling depending on whether it is clamped.
      const r = new Reconciler({ vetoBudget: 3 });
      r.restore([], [{ observer: "o", fingerprint: "g", count: 4 }]);
      let accepted = 0;
      for (let i = 0; i < 10; i++) {
        if (r.reconcile([p({ kind: "veto", fingerprint: `f-${i}` })]).veto) accepted += 1;
      }
      // Ceiling 6, of which the replay spends 3 (clamped), not 4.
      expect(accepted).toBe(3);
    });

    it("bounds the restored fingerprint set too", () => {
      const r = new Reconciler();
      r.restore(
        Array.from({ length: 5000 }, (_, i) => `fp-${i}`),
        [],
      );
      expect(r.stateSize().fingerprints).toBe(1000);
      // The MOST RECENT are kept: a recently accepted advisory is the one an observer
      // is about to repeat.
      expect(r.accepted()).toContain("fp-4999");
      expect(r.accepted()).not.toContain("fp-0");
    });

    it("ignores a spend count that is not a positive integer", () => {
      // A fresh Reconciler per case, with vetoBudget 1 so that a count that WERE
      // accepted would exhaust the budget outright. Sharing one reconciler across the
      // cases would run into the session ceiling and stop testing the count check.
      const bad: Array<[string, number]> = [
        ["zero", 0],
        ["negative", -3],
        ["fractional", 1.5],
        ["NaN", Number.NaN],
        ["numeric string", "2" as unknown as number],
      ];
      for (const [label, count] of bad) {
        const r = new Reconciler({ vetoBudget: 1 });
        r.restore([], [{ observer: "o", fingerprint: "g", count }]);
        expect(r.stateSize().vetoSpend, label).toBe(0);
        expect(r.stateSize().vetoObservers, label).toBe(0);
        expect(r.reconcile([p({ kind: "veto", fingerprint: "g" })]).veto, label).not.toBeNull();
      }
    });

    it("treats an implausibly high spend count as exhausted", () => {
      // The clamp itself is NOT pinned by this test and cannot be: `spent >= budget`
      // behaves identically whether the stored value is the budget or MAX_SAFE_INTEGER,
      // so clamping is behaviourally equivalent to storing verbatim. It is kept as
      // storage hygiene only. What this test does pin is the direction of the decision:
      // an absurd replayed count must refuse the veto, not admit it.
      const r = new Reconciler({ vetoBudget: 2 });
      r.restore([], [{ observer: "o", fingerprint: "g", count: Number.MAX_SAFE_INTEGER }]);
      expect(r.reconcile([p({ kind: "veto", fingerprint: "g" })]).veto).toBeNull();
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
      const turn2 = r.reconcile([p({ fingerprint: "low", priority: 10 })]);
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
      expect(
        turn1.advisories.some((a) => a.fingerprint === "shared" && a.kind === "advisory"),
      ).toBe(true);
      // The advisory is now in the accepted set

      // Turn 2: same fingerprint veto should be delivered (veto bypasses dedupe)
      const turn2 = r.reconcile([p({ kind: "veto", fingerprint: "shared", priority: 50 })]);
      // This veto should be delivered because vetoes bypass the accepted-set filter
      expect(turn2.veto?.fingerprint).toBe("shared");
      expect(turn2.veto?.kind).toBe("veto");

      // Turn 3: re-propose the advisory (should be deduped)
      const turn3 = r.reconcile([p({ kind: "advisory", fingerprint: "shared", priority: 50 })]);
      // Advisory should NOT be delivered because it was already accepted in turn1
      expect(turn3.advisories.map((a) => a.fingerprint)).not.toContain("shared");
      expect(turn3.dropped.some((d) => d.reason.match(/already/i))).toBe(true);
    });
  });

  describe("Exploratory: same-fingerprint advisory collapsing within a single batch", () => {
    it("collapses two same-fingerprint advisories in one call, keeping the higher priority", () => {
      const r = new Reconciler();
      const out = r.reconcile([
        p({ fingerprint: "dup", priority: 10, text: "low" }),
        p({ fingerprint: "dup", priority: 90, text: "high" }),
      ]);
      expect(out.advisories).toHaveLength(1);
      expect(out.advisories[0]?.text).toBe("high");
      expect(out.dropped).toHaveLength(1);
      expect(out.dropped[0]?.proposal.text).toBe("low");
      expect(out.dropped[0]?.reason).toMatch(/duplicate/i);
    });

    it("with equal priority, keeps the earlier one deterministically", () => {
      const r = new Reconciler();
      const out = r.reconcile([
        p({ fingerprint: "dup", priority: 50, text: "first" }),
        p({ fingerprint: "dup", priority: 50, text: "second" }),
      ]);
      expect(out.advisories).toHaveLength(1);
      expect(out.advisories[0]?.text).toBe("first");
      expect(out.dropped).toHaveLength(1);
      expect(out.dropped[0]?.proposal.text).toBe("second");
    });

    it("a collapsed duplicate does not consume a per-turn slot", () => {
      const r = new Reconciler({ maxAdvisoriesPerTurn: 2 });
      const out = r.reconcile([
        p({ fingerprint: "a", priority: 50, text: "dupA-1" }),
        p({ fingerprint: "a", priority: 50, text: "dupA-2" }),
        p({ fingerprint: "b", priority: 10, text: "distinctB" }),
      ]);
      expect(out.advisories.map((x) => x.fingerprint)).toEqual(["a", "b"]);
      expect(out.dropped.map((d) => d.proposal.text)).toEqual(["dupA-2"]);
    });

    it("does not leak into the accepted set if the survivor is itself dropped by the priority cap", () => {
      const r = new Reconciler({ maxAdvisoriesPerTurn: 1 });
      const turn1 = r.reconcile([
        p({ fingerprint: "high", priority: 90 }),
        p({ fingerprint: "dup", priority: 10, text: "dup-low" }),
        p({ fingerprint: "dup", priority: 5, text: "dup-lower" }),
      ]);
      expect(turn1.advisories.map((a) => a.fingerprint)).toEqual(["high"]);
      // "dup" survivor (priority 10) lost to the per-turn cap, not to collapsing,
      // so it must remain eligible next turn.
      expect(r.accepted()).toEqual(["high"]);

      const turn2 = r.reconcile([p({ fingerprint: "dup", priority: 10, text: "dup-low" })]);
      expect(turn2.advisories.map((a) => a.fingerprint)).toEqual(["dup"]);
      expect(turn2.dropped).toHaveLength(0);
    });

    it("two vetoes sharing a fingerprint are not collapsed; budget alone governs them", () => {
      const r = new Reconciler({ vetoBudget: 2 });
      const out = r.reconcile([
        p({ kind: "veto", fingerprint: "v", priority: 10, text: "veto-low" }),
        p({ kind: "veto", fingerprint: "v", priority: 90, text: "veto-high" }),
      ]);
      // Only one veto can be selected per turn (the higher priority one), but this is the
      // existing "at most one veto per turn" rule, not fingerprint collapsing — the lower
      // one is dropped for that reason, not as a "duplicate".
      expect(out.veto?.text).toBe("veto-high");
      expect(out.dropped).toHaveLength(1);
      expect(out.dropped[0]?.reason).not.toMatch(/duplicate/i);
      expect(out.dropped[0]?.reason).toMatch(/another veto/i);

      // Budget still allows the same fingerprint to veto again on a later turn.
      const out2 = r.reconcile([p({ kind: "veto", fingerprint: "v", priority: 50 })]);
      expect(out2.veto?.fingerprint).toBe("v");
    });

    it("an advisory and a veto sharing a fingerprint still do not interfere in either direction", () => {
      const r = new Reconciler({ maxAdvisoriesPerTurn: 2, vetoBudget: 2 });
      const out = r.reconcile([
        p({ kind: "advisory", fingerprint: "shared", priority: 50, text: "advisory" }),
        p({ kind: "veto", fingerprint: "shared", priority: 60, text: "veto" }),
      ]);
      expect(out.veto?.kind).toBe("veto");
      expect(out.veto?.fingerprint).toBe("shared");
      expect(out.advisories).toHaveLength(1);
      expect(out.advisories[0]?.kind).toBe("advisory");
      expect(out.advisories[0]?.fingerprint).toBe("shared");
      expect(out.dropped).toHaveLength(0);
    });
  });
});
