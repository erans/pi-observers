import { DEFAULTS, type Proposal } from "./types.ts";

export type ObserverRun = (signal: AbortSignal) => Promise<Proposal | null>;

export interface BusStatus {
  runs: number;
  failures: number;
  consecutiveFailures: number;
  disabled: boolean;
  lastError?: string;
}

interface Entry extends BusStatus {
  inflight?: Promise<void>;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Schedules observer runs without ever blocking the main agent loop.
 *
 * kick() starts a run and returns synchronously. Whatever has landed by the
 * next delivery point gets drained; anything still in flight waits for the one
 * after. Failures are absorbed here and never reach a lifecycle handler.
 */
export class ProposalBus {
  readonly #queue: Proposal[] = [];
  readonly #entries = new Map<string, Entry>();
  readonly #maxConsecutive: number;
  readonly #onProposal?: () => void;

  constructor(opts: { maxConsecutiveFailures?: number; onProposal?: () => void } = {}) {
    this.#maxConsecutive = opts.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures;
    this.#onProposal = opts.onProposal;
  }

  #entry(name: string): Entry {
    let entry = this.#entries.get(name);
    if (!entry) {
      entry = { runs: 0, failures: 0, consecutiveFailures: 0, disabled: false };
      this.#entries.set(name, entry);
    }
    return entry;
  }

  kick(name: string, timeoutMs: number, run: ObserverRun): void {
    const entry = this.#entry(name);
    if (entry.disabled) return;
    if (entry.inflight) return; // one run per observer at a time; a re-kick is dropped, not queued

    const controller = new AbortController();
    entry.controller = controller;

    // The timeout must settle the bus's OWN bookkeeping, not merely signal the run.
    // A run that ignores its AbortSignal (or awaits something that never rejects on
    // abort) would otherwise leave entry.inflight pending forever: the observer is
    // then permanently silent, because every later kick hits the in-flight guard —
    // yet status() reports runs: 0, failures: 0, disabled: false. Racing guarantees
    // the failure is counted and the slot is released no matter how the run behaves.
    const timeout = new Promise<never>((_resolve, reject) => {
      entry.timer = setTimeout(() => {
        controller.abort(new Error("observer run timed out"));
        reject(new Error("observer run timed out"));
      }, timeoutMs);
    });

    const runPromise = run(controller.signal);
    // No-op sink, not a safety net: Promise.race already attaches its own
    // rejection handler to every input promise, so a late rejection from this
    // abandoned run is never reported as unhandled even without this line.
    // Kept so the intent is documented and stays true if the race is ever
    // refactored away.
    runPromise.catch(() => {});

    entry.inflight = Promise.race([runPromise, timeout])
      .then((proposal) => {
        entry.runs += 1;
        entry.consecutiveFailures = 0;
        if (proposal) {
          this.#queue.push(proposal);
          // After the push, so a flush inside the callback drains this proposal. A
          // throwing callback must not be charged to the observer as a failed run --
          // the run itself succeeded -- so it is contained here, not left to the
          // .catch below, which would also count a failure and burn a strike.
          try {
            this.#onProposal?.();
          } catch {
            /* the proposal stays queued; the next drain collects it */
          }
        }
      })
      .catch((error: unknown) => {
        entry.runs += 1;
        entry.failures += 1;
        entry.consecutiveFailures += 1;
        entry.lastError = error instanceof Error ? error.message : String(error);
        if (entry.consecutiveFailures >= this.#maxConsecutive) entry.disabled = true;
      })
      .finally(() => {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.inflight = undefined;
        entry.controller = undefined;
      });
  }

  /** Non-blocking: returns and clears whatever has landed so far. */
  drain(): Proposal[] {
    return this.#queue.splice(0, this.#queue.length);
  }

  status(name: string): BusStatus {
    const entry = this.#entries.get(name);
    if (!entry) return { runs: 0, failures: 0, consecutiveFailures: 0, disabled: false };
    const { runs, failures, consecutiveFailures, disabled, lastError } = entry;
    return { runs, failures, consecutiveFailures, disabled, lastError };
  }

  isDisabled(name: string): boolean {
    return this.#entries.get(name)?.disabled ?? false;
  }

  abortAll(): void {
    for (const entry of this.#entries.values()) entry.controller?.abort();
  }

  /** Test helper. Production code must never await observer runs. */
  async settle(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((e) => e.inflight).filter(Boolean));
  }
}
