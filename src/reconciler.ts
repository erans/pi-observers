import { DEFAULTS, type Proposal } from "./types.ts";

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

  /** Rebuild dedupe state after a reload or resume. */
  restore(fingerprints: string[]): void {
    for (const fp of fingerprints) this.#acceptedFingerprints.add(fp);
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

    const advisories = fresh.filter((x) => x.kind === "advisory").sort(byPriority);
    const kept = advisories.slice(0, this.#maxAdvisories);
    for (const proposal of advisories.slice(this.#maxAdvisories)) {
      dropped.push({ proposal, reason: "over the per-turn advisory budget" });
    }

    let veto: Proposal | null = null;
    for (const candidate of fresh.filter((x) => x.kind === "veto").sort(byPriority)) {
      if (veto) {
        dropped.push({ proposal: candidate, reason: "another veto was already accepted this turn" });
        continue;
      }
      const spent = this.#vetoSpend.get(candidate.fingerprint) ?? 0;
      if (spent >= this.#vetoBudget) {
        dropped.push({ proposal: candidate, reason: `veto budget of ${this.#vetoBudget} exhausted` });
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
