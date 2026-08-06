import { describe, expect, it, vi } from "vitest";
import { ProposalBus } from "../src/bus.ts";
import { DEFAULTS, type Proposal } from "../src/types.ts";

const proposal = (fp: string): Proposal => ({
  observer: "o",
  kind: "advisory",
  text: "t",
  fingerprint: fp,
  priority: 50,
  deliver: "next_prompt",
});

describe("ProposalBus", () => {
  it("kick returns immediately without awaiting the run", () => {
    const bus = new ProposalBus();
    let settled = false;
    bus.kick("o", 1000, async () => {
      await new Promise((r) => setTimeout(r, 20));
      settled = true;
      return proposal("a");
    });
    expect(settled).toBe(false);
    expect(bus.drain()).toEqual([]);
  });

  it("queues a proposal that a later drain collects", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => proposal("a"));
    await bus.settle();
    expect(bus.drain().map((p) => p.fingerprint)).toEqual(["a"]);
  });

  it("drain empties the queue", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => proposal("a"));
    await bus.settle();
    bus.drain();
    expect(bus.drain()).toEqual([]);
  });

  it("drops a re-kick while a run is in flight", async () => {
    const bus = new ProposalBus();
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return proposal("a");
    });
    bus.kick("o", 1000, run);
    bus.kick("o", 1000, run);
    await bus.settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing run and counts a failure", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => {
      throw new Error("boom");
    });
    await expect(bus.settle()).resolves.toBeUndefined();
    expect(bus.status("o").failures).toBe(1);
    expect(bus.status("o").lastError).toContain("boom");
  });

  it("times out a hanging run and counts it as a failure", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 10, async (signal) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return null;
    });
    await bus.settle();
    expect(bus.status("o").failures).toBe(1);
  });

  it("times out a run that ignores its abort signal", async () => {
    const bus = new ProposalBus();
    // Deliberately uncooperative: never settles, never listens for abort.
    bus.kick("o", 10, () => new Promise<Proposal | null>(() => {}));
    await bus.settle();
    expect(bus.status("o").failures).toBe(1);
    expect(bus.status("o").lastError).toContain("timed out");
    // The slot must be released, or the observer is silently wedged forever.
    const run = vi.fn(async () => proposal("a"));
    bus.kick("o", 1000, run);
    await bus.settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores a late proposal from a run abandoned at timeout", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 10, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return proposal("late");
    });
    await bus.settle();
    await new Promise((r) => setTimeout(r, 80));
    expect(bus.drain()).toEqual([]);
    expect(bus.status("o").failures).toBe(1);
  });

  it("disables an observer after three consecutive failures", async () => {
    const bus = new ProposalBus();
    for (let i = 0; i < 3; i++) {
      bus.kick("o", 1000, async () => {
        throw new Error("boom");
      });
      await bus.settle();
    }
    expect(bus.isDisabled("o")).toBe(true);

    const run = vi.fn(async () => proposal("a"));
    bus.kick("o", 1000, run);
    await bus.settle();
    expect(run).not.toHaveBeenCalled();
  });

  it("resets the consecutive counter on success", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => {
      throw new Error("boom");
    });
    await bus.settle();
    bus.kick("o", 1000, async () => null);
    await bus.settle();
    expect(bus.status("o").consecutiveFailures).toBe(0);
    expect(bus.status("o").failures).toBe(1);
  });

  it("records a run that proposes nothing as a success", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => null);
    await bus.settle();
    expect(bus.status("o").runs).toBe(1);
    expect(bus.status("o").failures).toBe(0);
    expect(bus.drain()).toEqual([]);
  });

  // --- Exploratory tests beyond the brief ---

  it("drain() during an in-flight run returns nothing, repeatedly, until the run lands", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return proposal("a");
    });
    // Multiple drains while in flight must all come up empty, not just the first.
    expect(bus.drain()).toEqual([]);
    expect(bus.drain()).toEqual([]);
    await bus.settle();
    expect(bus.drain().map((p) => p.fingerprint)).toEqual(["a"]);
  });

  it("collects proposals from multiple independently-kicked observers into one drain", async () => {
    const bus = new ProposalBus();
    bus.kick("a", 1000, async () => proposal("a1"));
    bus.kick("b", 1000, async () => proposal("b1"));
    await bus.settle();
    const fps = bus
      .drain()
      .map((p) => p.fingerprint)
      .sort();
    expect(fps).toEqual(["a1", "b1"]);
  });

  it("a disabled observer's status is frozen: further kicks are no-ops that change nothing", async () => {
    const bus = new ProposalBus();
    for (let i = 0; i < DEFAULTS.maxConsecutiveFailures; i++) {
      bus.kick("o", 1000, async () => {
        throw new Error("boom");
      });
      await bus.settle();
    }
    const before = bus.status("o");
    expect(before.disabled).toBe(true);

    const run = vi.fn(async () => proposal("a"));
    bus.kick("o", 1000, run);
    await bus.settle(); // no inflight was ever created for this kick
    expect(run).not.toHaveBeenCalled();

    const after = bus.status("o");
    expect(after).toEqual(before);
    expect(bus.drain()).toEqual([]);
  });

  it("abortAll signals in-flight runs so a cooperative run resolves long before its own timeout", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 5000, async (signal) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled-early")));
      });
      return null;
    });
    bus.abortAll();
    await bus.settle();
    // If this resolved via the run's own 5000ms timeout instead of abortAll's
    // signal, lastError would read "observer run timed out" and this test
    // would hang the suite waiting on settle(). It must resolve fast, with the
    // run's own rejection reason.
    expect(bus.status("o").lastError).toContain("cancelled-early");
    expect(bus.status("o").failures).toBe(1);
  });

  it("abortAll on an uncooperative run does not wedge the bus: the run's own timeout still releases the slot", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 15, () => new Promise<Proposal | null>(() => {}));
    bus.abortAll(); // the run ignores this entirely; must not be relied on
    await bus.settle();
    expect(bus.status("o").failures).toBe(1);
    expect(bus.status("o").lastError).toContain("timed out");

    const run = vi.fn(async () => proposal("a"));
    bus.kick("o", 1000, run);
    await bus.settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("disables after consecutive failures regardless of whether they are timeouts or thrown errors", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 1000, async () => {
      throw new Error("boom-1");
    });
    await bus.settle();
    bus.kick("o", 10, () => new Promise<Proposal | null>(() => {})); // uncooperative -> timeout
    await bus.settle();
    bus.kick("o", 1000, async () => {
      throw new Error("boom-2");
    });
    await bus.settle();

    const status = bus.status("o");
    expect(status.failures).toBe(3);
    expect(status.consecutiveFailures).toBe(3);
    expect(bus.isDisabled("o")).toBe(true);

    const run = vi.fn(async () => proposal("a"));
    bus.kick("o", 1000, run);
    await bus.settle();
    expect(run).not.toHaveBeenCalled();
  });

  it("a success between two timeouts resets consecutiveFailures without wiping the failure total", async () => {
    const bus = new ProposalBus();
    bus.kick("o", 10, () => new Promise<Proposal | null>(() => {})); // timeout #1
    await bus.settle();
    bus.kick("o", 1000, async () => null); // success
    await bus.settle();
    bus.kick("o", 10, () => new Promise<Proposal | null>(() => {})); // timeout #2
    await bus.settle();

    const status = bus.status("o");
    expect(status.failures).toBe(2);
    expect(status.consecutiveFailures).toBe(1);
    expect(bus.isDisabled("o")).toBe(false);
  });
});
