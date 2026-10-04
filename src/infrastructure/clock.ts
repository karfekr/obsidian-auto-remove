/**
 * The one place "what time is it" is answered.
 *
 * Every rule in this plugin is state-based: `file mtime + TTL <= now`. That is a
 * comparison, not a schedule, which is why nothing here needs a timer to be
 * correct. It only needs one honest answer to "now", and that answer has to be
 * injectable — otherwise the difference between "23 hours old" and "25 hours
 * old" can only be observed by waiting two hours.
 *
 * Production uses {@link systemClock}. Tests use {@link ManualClock}, which makes
 * every boundary case in the suite instantaneous and deterministic.
 */

/**
 * Milliseconds since the Unix epoch.
 *
 * Deliberately the same function shape as the `Clock` type in
 * `services/ports.ts`, so a plain function is a valid clock and nothing has to
 * be wrapped to be tested.
 */
export type Clock = () => number;

/** The real clock. The only place in the plugin that reads the system time. */
export const systemClock: Clock = () => Date.now();

/** A clock a test drives by hand. */
export class ManualClock {
	private current: number;

	constructor(initial: number | string | Date = 0) {
		this.current = toMillis(initial);
	}

	/**
	 * A clock function reading this clock.
	 *
	 * A bound property rather than a method so it satisfies {@link Clock} directly:
	 * `new ExpirationScanner(vault, clock.now)` reads well and needs no lambda.
	 */
	readonly now: Clock = () => this.current;

	/** Jumps to an absolute instant. */
	set(value: number | string | Date): void {
		this.current = toMillis(value);
	}

	/** Moves forward by a duration in milliseconds. Negative values move backwards. */
	advanceMs(ms: number): void {
		this.current += ms;
	}

	/** Moves forward by a number of days — the unit the rules are written in. */
	advanceDays(days: number): void {
		this.advanceMs(days * 86_400_000);
	}
}

function toMillis(value: number | string | Date): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}
