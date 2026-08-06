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

/** The replayed value if it is usable as a dedupe key, else undefined. */
function validFingerprint(value: unknown): string | undefined {
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
  readonly #vetoSpend = new Map<string, number>();

  constructor(opts: ReconcilerOptions = {}) {
    this.#maxAdvisories = opts.maxAdvisoriesPerTurn ?? DEFAULTS.maxAdvisoriesPerTurn;
    this.#vetoBudget = opts.vetoBudget ?? DEFAULTS.vetoBudget;
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
  restore(fingerprints: string[], vetoSpend?: Iterable<[string, number]>): void {
    // Keep the MOST RECENT entries, not the first: session entries arrive in order,
    // and a recently accepted advisory is the one an observer is about to repeat.
    // Dropping the tail would silence dedupe exactly where it earns its keep.
    for (const fp of fingerprints.slice(-MAX_RESTORED_ENTRIES)) {
      const key = validFingerprint(fp);
      if (key !== undefined) this.#acceptedFingerprints.add(key);
    }

    if (!vetoSpend) return;
    for (const [fp, count] of vetoSpend) {
      if (this.#vetoSpend.size >= MAX_RESTORED_ENTRIES) break;
      const key = validFingerprint(fp);
      if (key === undefined) continue;
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
      this.#vetoSpend.set(key, Math.min(count, this.#vetoBudget));
    }
  }

  accepted(): string[] {
    return [...this.#acceptedFingerprints];
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
      const spent = this.#vetoSpend.get(candidate.fingerprint) ?? 0;
      if (spent >= this.#vetoBudget) {
        dropped.push({
          proposal: candidate,
          reason: `veto budget of ${this.#vetoBudget} exhausted`,
        });
        continue;
      }
      this.#vetoSpend.set(candidate.fingerprint, spent + 1);
      veto = candidate;
    }

    // Only advisories are added to the accepted set. Vetoes are governed by budget, not dedupe.
    // A proposal dropped for budget must stay eligible next turn, otherwise a busy turn
    // silently discards advice.
    for (const proposal of kept) this.#acceptedFingerprints.add(proposal.fingerprint);

    return { advisories: kept, veto, dropped };
  }
}
