import { describe, expect, it } from "vitest";
import { MILLISECONDS_PER_DAY } from "../../src/domain/types";
import { ManualClock, systemClock } from "../../src/infrastructure/clock";

describe("ManualClock", () => {
  it("reports the instant it was constructed with", () => {
    const clock = new ManualClock(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it("accepts an ISO string", () => {
    const clock = new ManualClock("2026-10-01T12:00:00.000Z");
    expect(clock.now()).toBe(Date.UTC(2026, 9, 1, 12));
  });

  it("accepts a Date", () => {
    const clock = new ManualClock(new Date(Date.UTC(2026, 9, 1, 12)));
    expect(clock.now()).toBe(Date.UTC(2026, 9, 1, 12));
  });

  it("falls back to the epoch for an unparseable string rather than producing NaN", () => {
    // A NaN clock would make every comparison false, which looks exactly like
    // "nothing is expired" — a failure mode worth refusing outright.
    expect(new ManualClock("not a date").now()).toBe(0);
  });

  it("does not move on its own", () => {
    const clock = new ManualClock(500);
    clock.now();
    clock.now();
    expect(clock.now()).toBe(500);
  });

  describe("advancing", () => {
    it("moves forward by a duration", () => {
      const clock = new ManualClock(0);
      clock.advanceMs(90);
      expect(clock.now()).toBe(90);
    });

    it("moves backward when given a negative duration", () => {
      const clock = new ManualClock(1_000);
      clock.advanceMs(-400);
      expect(clock.now()).toBe(600);
    });

    it("advances by whole days, the unit the rules use", () => {
      const clock = new ManualClock(0);
      clock.advanceDays(3);
      expect(clock.now()).toBe(3 * MILLISECONDS_PER_DAY);
    });

    it("jumps to an absolute instant", () => {
      const clock = new ManualClock(0);
      clock.set("2026-10-02T12:00:00.000Z");
      expect(clock.now()).toBe(Date.UTC(2026, 9, 2, 12));
    });
  });

  it("satisfies the Clock shape, so it can be injected directly", () => {
    const clock = new ManualClock(0);
    const injected: () => number = clock.now;
    clock.advanceMs(7);
    expect(injected()).toBe(7);
  });

  it("makes the 23h / 24h / 25h boundaries three assertions rather than three days", () => {
    const mtime = Date.UTC(2026, 9, 1, 12);
    const clock = new ManualClock(mtime);

    const hoursOld = () => Math.floor((clock.now() - mtime) / 3_600_000);

    clock.advanceMs(23 * 3_600_000);
    expect(hoursOld()).toBe(23);

    clock.advanceMs(3_600_000);
    expect(hoursOld()).toBe(24);

    clock.advanceMs(3_600_000);
    expect(hoursOld()).toBe(25);
  });
});

describe("systemClock", () => {
  it("is a function returning a plausible current time", () => {
    const before = Date.now();
    const value = systemClock();
    expect(typeof value).toBe("number");
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });
});
