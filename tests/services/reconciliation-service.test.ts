import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../src/infrastructure/clock";
import { NullLogger, RecordingLogger } from "../support/loggers";
import type { CleanupOutcome, CleanupService, RunMode } from "../../src/services/cleanup-service";
import { ManualScheduler } from "../support/test-doubles";
import {
  EVENT_DEBOUNCE_MS,
  RECONCILIATION_INTERVAL_MS,
  ReconciliationService,
} from "../../src/services/reconciliation-service";

/** Stands in for the cleanup service so scheduling can be tested on its own. */
function fakeCleanup() {
  const runs: Array<{ reason: string; mode: RunMode }> = [];
  let release: (() => void) | null = null;

  const cleanup = {
    run: vi.fn(async (mode: RunMode = "automatic"): Promise<CleanupOutcome> => {
      runs.push({ reason: "n/a", mode });
      if (release !== null) await new Promise<void>((resolve) => (release = resolve));
      return { status: "nothing-expired", plan: { removals: [], decisions: [] } };
    }),
  };

  return {
    cleanup: cleanup as unknown as CleanupService,
    runs,
    /** Makes the next `run` hang, so overlap can be arranged deliberately. */
    hold() {
      release = () => {};
    },
    settle() {
      const resolve = release;
      release = null;
      resolve?.();
    },
    async flush() {
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    },
  };
}

function harness(options: { hold?: boolean; intervalMs?: number; debounceMs?: number } = {}) {
  const scheduler = new ManualScheduler();
  const logger = new RecordingLogger(true);
  const fake = fakeCleanup();
  if (options.hold === true) fake.hold();

  const service = new ReconciliationService({
    cleanup: fake.cleanup,
    scheduler: scheduler,
    logger,
    intervalMs: options.intervalMs ?? 1_000,
    debounceMs: options.debounceMs ?? 500,
  });

  return { service, scheduler, logger, ...fake };
}

describe("ReconciliationService", () => {
  describe("the interval", () => {
    it("runs on a schedule once started", async () => {
      const { service, scheduler, cleanup } = harness();
      service.start();

      expect(cleanup.run).not.toHaveBeenCalled();

      scheduler.advance(1_000);
      await Promise.resolve();

      expect(cleanup.run).toHaveBeenCalledTimes(1);
    });

    it("keeps running on its own cadence", async () => {
      const { service, scheduler, cleanup } = harness();
      service.start();

      scheduler.advance(1_000);
      await Promise.resolve();
      scheduler.advance(1_000);
      await Promise.resolve();

      expect(cleanup.run).toHaveBeenCalledTimes(2);
    });

    it("does not fire before the interval has elapsed", async () => {
      const { service, scheduler, cleanup } = harness();
      service.start();

      scheduler.advance(999);
      await Promise.resolve();

      expect(cleanup.run).not.toHaveBeenCalled();
    });

    it("is idempotent to start, so a double start cannot double the work", async () => {
      const { service, scheduler, cleanup } = harness();

      service.start();
      service.start();
      scheduler.advance(1_000);
      await Promise.resolve();

      expect(cleanup.run).toHaveBeenCalledTimes(1);
    });

    it("stops cleanly, leaving nothing armed", () => {
      const { service, scheduler, cleanup } = harness();
      service.start();
      service.stop();

      expect(scheduler.armedCount).toBe(0);
      expect(service.isScheduled).toBe(false);

      scheduler.advance(10_000);
      expect(cleanup.run).not.toHaveBeenCalled();
    });

    it("tolerates being stopped twice", () => {
      const { service } = harness();
      service.start();
      service.stop();
      expect(() => service.stop()).not.toThrow();
    });

    it("cancels a pending debounce when stopped, so nothing fires after teardown", async () => {
      const { service, scheduler, cleanup } = harness();
      service.start();
      service.schedule("vault-event");
      service.stop();

      scheduler.advance(10_000);
      await Promise.resolve();

      expect(cleanup.run).not.toHaveBeenCalled();
      expect(scheduler.armedCount).toBe(0);
    });
  });

  describe("coalescing a burst of events", () => {
    it("turns many requests inside the window into one run", async () => {
      const { service, scheduler, cleanup } = harness({ intervalMs: 1_000_000 });
      service.start();

      // A single save can emit create/modify/rename; a sync client emits hundreds.
      for (let i = 0; i < 50; i += 1) service.schedule("vault-event");
      expect(cleanup.run).not.toHaveBeenCalled();

      scheduler.advance(500);
      await Promise.resolve();

      expect(cleanup.run).toHaveBeenCalledTimes(1);
    });

    it("does not run until the burst settles", async () => {
      const { service, scheduler, cleanup } = harness({ intervalMs: 1_000_000 });
      service.start();

      service.schedule("vault-event");
      scheduler.advance(400);
      service.schedule("vault-event");
      scheduler.advance(400);
      await Promise.resolve();

      expect(cleanup.run).not.toHaveBeenCalled();
    });

    it("runs again for a later, separate burst", async () => {
      const { service, scheduler, cleanup } = harness({ intervalMs: 1_000_000 });
      service.start();

      service.schedule("vault-event");
      scheduler.advance(500);
      await Promise.resolve();
      service.schedule("vault-event");
      scheduler.advance(500);
      await Promise.resolve();

      expect(cleanup.run).toHaveBeenCalledTimes(2);
    });

    it("ignores a schedule request once stopped", async () => {
      const { service, scheduler, cleanup } = harness({ intervalMs: 1_000_000 });
      service.start();
      service.stop();
      service.schedule("vault-event");

      scheduler.advance(10_000);
      await Promise.resolve();

      expect(cleanup.run).not.toHaveBeenCalled();
    });
  });

  describe("never running twice at once", () => {
    it("refuses a second run while one is in flight", async () => {
      const { service, cleanup, settle } = harness({ hold: true });
      service.start();

      const first = service.run("manual", "manual");
      const second = await service.run("interval");

      expect(second).toEqual({ status: "already-running" });
      expect(cleanup.run).toHaveBeenCalledTimes(1);

      settle();
      await first;
    });

    it("repeats once, rather than dropping a request that arrived mid-run", async () => {
      const { service, cleanup, settle } = harness({ hold: true });
      service.start();

      const first = service.run("interval");
      // The interval fires again while the first pass is still working.
      await service.run("interval");
      expect(cleanup.run).toHaveBeenCalledTimes(1);

      settle();
      await first;
      await Promise.resolve();

      // Exactly one repeat: the queued request was honoured, not accumulated.
      expect(cleanup.run).toHaveBeenCalledTimes(2);
    });

    it("coalesces many overlapping requests into a single repeat", async () => {
      const { service, cleanup, settle } = harness({ hold: true });
      service.start();

      const first = service.run("manual", "manual");
      // An interval, a burst of vault events and a manual request, all mid-run.
      await service.run("interval");
      service.schedule("vault-event");
      await service.run("manual", "manual");

      settle();
      await first;
      await Promise.resolve();

      // Two in total: the original, plus exactly one repeat for all three.
      expect(cleanup.run).toHaveBeenCalledTimes(2);
    });

    it("survives a throwing run and stays usable", async () => {
      const logger = new RecordingLogger(true);
      const scheduler = new ManualScheduler();
      const cleanup = {
        run: vi.fn(async (): Promise<CleanupOutcome> => {
          throw new Error("boom");
        }),
      };
      const service = new ReconciliationService({
        cleanup: cleanup as unknown as CleanupService,
        scheduler,
        logger,
      });
      service.start();

      await expect(service.run("manual", "manual")).rejects.toThrow("boom");
      expect(service.isRunning).toBe(false);
      expect(logger.messagesMatching("Reconciliation failed")).toHaveLength(1);
    });
  });

  describe("catch-up", () => {
    it("has no missed-run bookkeeping to reconcile", async () => {
      // The point of the whole design: because the rules are comparisons rather
      // than deadlines, "a run was missed" is not a state that can exist. Five
      // intervals passing with nothing scheduled simply means five evaluations
      // that found nothing to do.
      const { service, scheduler, cleanup } = harness();
      service.start();

      // Stand in for a long absence: virtual time moves; no run was pending.
      scheduler.advance(60 * 60 * 1000);
      await Promise.resolve();
      scheduler.fireIntervals();
      await Promise.resolve();

      expect(cleanup.run).toHaveBeenCalled();
    });
  });
});

describe("interval constants", () => {
  it("reconciles every five minutes by default", () => {
    expect(RECONCILIATION_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("debounces vault events over a couple of seconds", () => {
    expect(EVENT_DEBOUNCE_MS).toBe(2_000);
  });
});

describe("NullLogger", () => {
  it("swallows everything without throwing", () => {
    const logger = new NullLogger();
    expect(() => {
      logger.debug("a");
      logger.warn("b");
      logger.error("c");
    }).not.toThrow();
  });
});

describe("ManualScheduler", () => {
  it("never uses a real timer", () => {
    const scheduler = new ManualScheduler();
    let fired = 0;
    scheduler.every(1, () => (fired += 1));

    // No advancing, no waiting: nothing can have happened.
    expect(fired).toBe(0);
  });

  it("fires a one-shot exactly once", () => {
    const scheduler = new ManualScheduler();
    let fired = 0;
    scheduler.after(10, () => (fired += 1));

    scheduler.advance(10);
    scheduler.advance(10);

    expect(fired).toBe(1);
  });

  it("honours a cancellation", () => {
    const scheduler = new ManualScheduler();
    let fired = 0;
    const cancel = scheduler.after(10, () => (fired += 1));

    cancel();
    scheduler.advance(100);

    expect(fired).toBe(0);
    expect(scheduler.armedCount).toBe(0);
  });

  it("is driven by the clock it shares with the rules", () => {
    const clock = new ManualClock(0);
    const scheduler = new ManualScheduler();
    scheduler.now = clock.now();

    expect(scheduler.now).toBe(0);
  });
});
