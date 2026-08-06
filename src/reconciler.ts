import { DEFAULTS, type Proposal } from "./types.ts";

/**
 * Bound on how many replayed entries `restore` will accept, per map. Live state is
 * already bounded -- at most `maxAdvisoriesPerTurn` fingerprints are added per turn --
 * but replayed state is not, because every reload re-reads the whole session file.
 */
const MAX_RESTORED_ENTRIES = 1000;

/**
 * Bound on one replayed fingerprint. Nothing upstream limits fingerprint length: a
 * model can emit a megabyte of it and src/outputs.ts will accept it.
 *
 * Over-long fingerprints are REJECTED, never truncated. Truncating would map two
 * distinct advisories that share a long prefix onto one key, so accepting the first
 * would silently suppress the second -- advice lost with no trace. Rejecting means an
 * advisory with an absurd fingerprint may be delivered again after a reload, which is
 * visible, bounded by the per-turn advisory budget, and strictly the better failure.
 */
const MAX_FINGERPRINT_LENGTH = 512;

/** The replayed value if it is usable as part of a dedupe or spend key, else undefined. */
function validKeyPart(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_FINGERPRINT_LENGTH) return undefined;
  return trimmed;
}

export interface ReconcileResult {
  advisories: Proposal[];
  veto: Proposal | null;
  dropped: Array<{ proposal: Proposal; reason: string }>;
}

export interface ReconcilerOptions {
  maxAdvisoriesPerTurn?: number;
  vetoBudget?: number;
}

/** One replayed veto, as recorded in the session. */
export interface VetoSpendEntry {
  observer: string;
  fingerprint: string;
  count: number;
}

/**
 * Multiplier turning `vetoBudget` into a per-OBSERVER ceiling on accepted vetoes per
 * session, independent of fingerprint.
 *
 * The fingerprint budget alone does not bound anything. `fingerprint` is a string the
 * observer's model chooses and `src/outputs.ts` only checks that it is non-blank, so a
 * model that varies it -- through malice, through a repo-resident `can: [veto]`
 * definition, or simply by not following the instruction in its prompt -- gets a fresh
 * budget every time. Measured against this class: a stable fingerprint over 25 drains
 * yields 3 accepted vetoes; a varying one yields 25. Since every accepted veto reopens
 * the turn and so produces another trigger, that is an unbounded loop.
 *
 * This ceiling is the part that actually terminates it, because it keys on the observer
 * name, which comes from the definition file and not from the model. Two full budgets
 * is deliberately loose: it must never interfere with legitimate re-vetoing of distinct
 * goals within one session, only stop the runaway.
 */
const VETO_CEILING_MULTIPLIER = 2;

/**
 * Multiplier turning `vetoBudget` into a SESSION-WIDE ceiling on accepted vetoes,
 * across every observer.
 *
 * The per-observer ceiling above bounds one observer. It does not bound the number of
 * observers, and nothing else does either: `src/discovery.ts` loads every
 * `.pi/observers/*.md` in the project. Measured: 1, 5, and 50 veto-capable observers
 * yield 6, 30, and 300 accepted vetoes -- 300 turn reopenings, each a full agent
 * round-trip. Per-observer fairness is the wrong axis for a runaway; what the user
 * experiences is the total.
 *
 * Derived from `vetoBudget` rather than exposed as its own setting so that
 * `src/settings.ts`'s cap of 10 on `vetoBudget` hard-caps this at 40 as well. A
 * free-standing setting would lose that property, and the only reason anyone raises a
 * backstop is to get past it.
 *
 * Strictly greater than VETO_CEILING_MULTIPLIER, so a single observer always hits its
 * own ceiling first and the session ceiling never masks the more specific diagnosis.
 */
const VETO_SESSION_CEILING_MULTIPLIER = 4;

/**
 * Decides which proposals reach the main agent.
 *
 * An observer proposes; this decides. Without a strict budget here the
 * "observers never answer for you" property degrades into several agents
 * talking over each other.
 */
export class Reconciler {
  readonly #maxAdvisories: number;
  readonly #vetoBudget: number;
  readonly #acceptedFingerprints = new Set<string>();
  /** Keyed by observer AND fingerprint: one observer must not be able to spend, or
   *  refill, another's budget by proposing a colliding fingerprint. */
  readonly #vetoSpend = new Map<string, number>();
  /** Accepted vetoes per observer, whatever fingerprints were used. */
  readonly #vetoAccepted = new Map<string, number>();
  readonly #vetoCeiling: number;
  /** Accepted vetoes this session across ALL observers. */
  #vetoAcceptedTotal = 0;
  readonly #vetoSessionCeiling: number;

  constructor(opts: ReconcilerOptions = {}) {
    this.#maxAdvisories = opts.maxAdvisoriesPerTurn ?? DEFAULTS.maxAdvisoriesPerTurn;
    this.#vetoBudget = opts.vetoBudget ?? DEFAULTS.vetoBudget;
    this.#vetoCeiling = this.#vetoBudget * VETO_CEILING_MULTIPLIER;
    this.#vetoSessionCeiling = this.#vetoBudget * VETO_SESSION_CEILING_MULTIPLIER;
  }

  /**
   * Composite spend key, length-prefixed rather than delimiter-joined.
   *
   * A delimiter is only safe if it cannot appear in either part, and NEITHER part is
   * under this module's control: `observer` is frontmatter from a repo-resident
   * `.pi/observers/*.md`, and `fingerprint` comes straight off a model's tool call.
   * With `:` the encoding was not injective -- observer "a" + fingerprint "b:c"
   * produced the same key as observer "a:b" + fingerprint "c" -- and restore()'s
   * `set()` overwrite turned that collision into a REFUND of an exhausted budget.
   *
   * Prefixing the observer's length makes the encoding injective for any content at
   * all, including the separator itself, so there is no character either side has to
   * avoid. `\u0000` (written as an escape, never as a literal) only has to be absent
   * from a run of decimal digits, which it is by construction.
   *
   * src/index.ts builds the same composite for its replay map and calls THIS method
   * rather than repeating the format; the two drifting apart is how a refund gets
   * reintroduced without anything looking wrong at either site.
   */
  static vetoKey(observer: string, fingerprint: string): string {
    return `${observer.length}\u0000${observer}${fingerprint}`;
  }

  /**
   * Rebuild dedupe and veto-spend state after a reload or resume.
   *
   * TREAT BOTH ARGUMENTS AS UNTRUSTED. They are replayed from session entries this
   * extension wrote, but what it wrote came from a Proposal, and `fingerprint` reaches
   * a Proposal straight off a model's tool call with no length limit anywhere:
   * src/outputs.ts validates that a fingerprint is non-blank and trims it, and applies
   * `maxAdvisoryChars` to the TEXT only. The observer choosing that fingerprint runs a
   * prompt assembled from a repo-resident `.pi/observers/*.md` definition. Every
   * accepted advisory then appends one more entry, and every reload replays the whole
   * file -- so unlike live state, which the per-turn advisory budget bounds, replayed
   * state accumulates across sessions. Without the bounds below, a project-scoped
   * observer definition can grow this reconciler's memory footprint session over
   * session, permanently.
   */
  restore(fingerprints: string[], vetoSpend?: Iterable<VetoSpendEntry>): void {
    // Keep the MOST RECENT entries, not the first: session entries arrive in order,
    // and a recently accepted advisory is the one an observer is about to repeat.
    // Dropping the tail would silence dedupe exactly where it earns its keep.
    for (const fp of fingerprints.slice(-MAX_RESTORED_ENTRIES)) {
      const key = validKeyPart(fp);
      if (key !== undefined) this.#acceptedFingerprints.add(key);
    }

    if (!vetoSpend) return;
    for (const entry of vetoSpend) {
      if (
        this.#vetoSpend.size >= MAX_RESTORED_ENTRIES ||
        this.#vetoAccepted.size >= MAX_RESTORED_ENTRIES
      ) {
        break;
      }
      // BOTH parts are validated, not just the fingerprint. The key is what bounds this
      // map, so an unvalidated observer name reopens exactly the growth vector the
      // fingerprint check closes -- and `observer` is frontmatter from a repo-resident
      // definition, which is if anything the more attacker-controlled of the two.
      //
      // But they gate DIFFERENT things, and this is the whole point of the ordering
      // below. An entry whose fingerprint is unusable used to be skipped entirely,
      // which refunded the per-observer ceiling as well as the fingerprint budget --
      // and since `fingerprint` is model-chosen with no length limit upstream, an
      // observer could decide whether its own ceiling survived a reload just by
      // emitting a 5000-character fingerprint. Measured before the fix: six replayed
      // vetoes with over-long fingerprints bought six more accepted vetoes; with
      // blank fingerprints, six more; with usable ones, zero.
      //
      // The ceiling exists precisely to be the part the model cannot influence, so it
      // is credited on a valid `observer` ALONE. Fingerprint validity gates only the
      // fingerprint-keyed budget.
      const observer = validKeyPart(entry?.observer);
      if (observer === undefined) continue;
      const count = entry.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) continue;
      // An implausible count is clamped, not rejected: at or above the budget means
      // "exhausted", which is the safe direction. The failure mode of a forged high
      // count is one goal that can no longer veto, which the user can see and clear;
      // the failure mode of ignoring it is an unsatisfiable goal holding every turn
      // open forever.
      //
      // The clamp is storage hygiene and nothing more, stated plainly so no one later
      // mistakes it for a control: `spent >= this.#vetoBudget` below compares the same
      // way whether the stored value is the budget or MAX_SAFE_INTEGER, so clamping is
      // behaviourally equivalent to storing the value verbatim. No test pins it, and
      // none can.
      const spent = Math.min(count, this.#vetoBudget);
      // The ceilings are replayed first and unconditionally, or a reload refills them
      // and the runaway they exist to stop resumes with a clean slate.
      this.#vetoAccepted.set(
        observer,
        Math.min((this.#vetoAccepted.get(observer) ?? 0) + spent, this.#vetoCeiling),
      );
      this.#vetoAcceptedTotal = Math.min(this.#vetoAcceptedTotal + spent, this.#vetoSessionCeiling);

      const fingerprint = validKeyPart(entry?.fingerprint);
      if (fingerprint === undefined) continue;
      this.#vetoSpend.set(Reconciler.vetoKey(observer, fingerprint), spent);
    }
  }

  accepted(): string[] {
    return [...this.#acceptedFingerprints];
  }

  /**
   * Sizes of the three replay-bounded collections.
   *
   * Exposed because the caps in restore() are MEMORY bounds and reconcile() cannot
   * observe them: once the veto ceilings are exhausted, a 1,000-entry replay and a
   * 5,000-entry replay produce identical decisions forever after. Without this the cap
   * is a guard no test can fail, which on this branch is treated as a defect rather
   * than as coverage.
   */
  stateSize(): { fingerprints: number; vetoSpend: number; vetoObservers: number } {
    return {
      fingerprints: this.#acceptedFingerprints.size,
      vetoSpend: this.#vetoSpend.size,
      vetoObservers: this.#vetoAccepted.size,
    };
  }

  reconcile(proposals: Proposal[]): ReconcileResult {
    const dropped: ReconcileResult["dropped"] = [];

    // Vetoes bypass the accepted-set filter since re-vetoing the same unmet goal
    // is the entire point. Budget governs vetoes, not dedupe.
    const fresh = proposals.filter((proposal) => {
      if (proposal.kind === "veto") return true;
      if (this.#acceptedFingerprints.has(proposal.fingerprint)) {
        dropped.push({ proposal, reason: "already delivered earlier in this session" });
        return false;
      }
      return true;
    });

    const byPriority = (a: Proposal, b: Proposal) => b.priority - a.priority;

    // Collapse same-fingerprint advisories within this single batch, keeping only the
    // highest-priority one (earlier wins on a tie, for determinism). This runs after the
    // accepted-fingerprint filter above and before the priority cap below, so a duplicate
    // never occupies a slot that a distinct advisory could have used.
    const freshAdvisories = fresh.filter((x) => x.kind === "advisory");
    const bestByFingerprint = new Map<string, Proposal>();
    for (const proposal of freshAdvisories) {
      const current = bestByFingerprint.get(proposal.fingerprint);
      if (!current || proposal.priority > current.priority) {
        bestByFingerprint.set(proposal.fingerprint, proposal);
      }
    }
    const survivors = new Set(bestByFingerprint.values());
    for (const proposal of freshAdvisories) {
      if (!survivors.has(proposal)) {
        dropped.push({
          proposal,
          reason:
            "duplicate fingerprint within this batch; a higher-priority advisory with the same fingerprint was kept",
        });
      }
    }

    const advisories = [...survivors].sort(byPriority);
    const kept = advisories.slice(0, this.#maxAdvisories);
    for (const proposal of advisories.slice(this.#maxAdvisories)) {
      dropped.push({ proposal, reason: "over the per-turn advisory budget" });
    }

    let veto: Proposal | null = null;
    for (const candidate of fresh.filter((x) => x.kind === "veto").sort(byPriority)) {
      if (veto) {
        dropped.push({
          proposal: candidate,
          reason: "another veto was already accepted this turn",
        });
        continue;
      }
      const key = Reconciler.vetoKey(candidate.observer, candidate.fingerprint);
      const spent = this.#vetoSpend.get(key) ?? 0;
      if (spent >= this.#vetoBudget) {
        dropped.push({
          proposal: candidate,
          reason: `veto budget of ${this.#vetoBudget} exhausted`,
        });
        continue;
      }
      // The fingerprint budget bounds nothing on its own: the fingerprint is chosen by
      // the observer's model, so varying it yields a fresh budget every drain, and every
      // accepted veto reopens the turn and produces another trigger. This ceiling keys
      // on the observer name, which comes from the definition file rather than the
      // model, and is what actually terminates that loop.
      const acceptedByObserver = this.#vetoAccepted.get(candidate.observer) ?? 0;
      if (acceptedByObserver >= this.#vetoCeiling) {
        dropped.push({
          proposal: candidate,
          reason: `observer "${candidate.observer}" reached its ceiling of ${this.#vetoCeiling} vetoes this session`,
        });
        continue;
      }
      // Per-observer fairness is the wrong axis for a runaway. Nothing bounds the NUMBER
      // of veto-capable observers a project can define, so a per-observer ceiling scales
      // linearly with a count the project controls: 1, 5, and 50 observers measured at
      // 6, 30, and 300 accepted vetoes. What the user experiences is the total.
      if (this.#vetoAcceptedTotal >= this.#vetoSessionCeiling) {
        dropped.push({
          proposal: candidate,
          reason: `session-wide ceiling of ${this.#vetoSessionCeiling} vetoes reached across all observers`,
        });
        continue;
      }
      this.#vetoSpend.set(key, spent + 1);
      this.#vetoAccepted.set(candidate.observer, acceptedByObserver + 1);
      this.#vetoAcceptedTotal += 1;
      veto = candidate;
    }

    // Only advisories are added to the accepted set. Vetoes are governed by budget, not dedupe.
    // A proposal dropped for budget must stay eligible next turn, otherwise a busy turn
    // silently discards advice.
    for (const proposal of kept) this.#acceptedFingerprints.add(proposal.fingerprint);

    return { advisories: kept, veto, dropped };
  }
}
