import type { CleanupOutcome, CleanupService, RunMode } from "./cleanup-service";
import type { Logger, Scheduler } from "./ports";

/**
 * How often reconciliation runs even when nothing has happened.
 *
 * An implementation detail, deliberately not a setting: the rules are state-based,
 * so this interval only decides how long the plugin takes to *notice* a file that
 * has already expired. Too short and a large vault is scanned pointlessly; too
 * long and a file sits past its TTL longer than the user expects. Five minutes is
 * comfortably inside the shortest TTL anyone would configure, and cheap enough
 * that a full in-memory scan every time is not noticeable.
 *
 * Changing it is a one-line edit here.
 */
export const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long a burst of vault events is allowed to settle before reconciling.
 *
 * A single save can produce create/modify/rename in quick succession, and a sync
 * client can produce hundreds. Coalescing them means one reconciliation instead of
 * one per event.
 */
export const EVENT_DEBOUNCE_MS = 2_000;

/** Why a reconciliation was started. Logged; never changes the outcome. */
export type ReconcileReason =
	| "startup"
	| "interval"
	| "vault-event"
	| "manual"
	| "dry-run"
	| "settings-change";

export interface ReconciliationServiceOptions {
	readonly cleanup: CleanupService;
	readonly scheduler: Scheduler;
	readonly logger: Logger;
	readonly intervalMs?: number;
	readonly debounceMs?: number;
}

export interface Reconciliation {
	/** Starts the interval. Reconciliation does not wait for it to happen first. */
	start(): void;
	/** Cancels the interval and any pending debounce. Idempotent. */
	stop(): void;
	/**
	 * Reconciles now, bypassing the debounce.
	 *
	 * Used by the interval itself and by the on-demand commands, which must feel
	 * immediate rather than "in a couple of seconds".
	 */
	run(reason: ReconcileReason, mode?: RunMode): Promise<CleanupOutcome>;
	/**
	 * Requests a reconciliation, coalesced with any other request inside the
	 * debounce window.
	 *
	 * This is what vault events call.
	 */
	schedule(reason: ReconcileReason): void;
}

/**
 * The one authoritative path from "something changed" to "files acted on".
 *
 * Startup, the interval, vault events and the commands all arrive here, which is
 * what stops any of them growing its own business logic — the exact defect the
 * audit found, where a rule could be correct and still never be consulted.
 *
 * ## Why a timer rather than a deadline
 *
 * The rules are comparisons — `mtime + TTL <= now` — so they are correct whenever
 * they are evaluated. A timer cannot make a rule correct; it can only decide how
 * long the plugin takes to notice. That has a useful consequence: every failure
 * the audit worried about resolves to "the next reconciliation will catch it".
 *
 * | Situation                     | Behaviour                                   |
 * * | ----------------------------- | ------------------------------------------- |
 * * | Obsidian closed when a file expired | The startup reconciliation finds it |
 * * | Laptop asleep past the TTL     | The interval fires on wake; state is unchanged |
 * * | Obsidian crashed mid-run        | Partial work; the next run reconciles the rest |
 * * | Plugin reloaded                | `stop()` cancels every timer it registered   |
 * * | A run was missed                | Nothing to catch up — there is no schedule to miss |
 *
 * No catch-up bookkeeping is needed, and none exists, because there is no
 * persisted "last ran at" to reconcile against.
 *
 * ## Overlap
 *
 * Runs never overlap. A request arriving mid-run sets a flag and the run repeats
 * once, so no two passes can ever be processing the vault at the same time. The
 * alternative — letting them interleave — would mean two passes racing to act on
 * the same file.
 */
export class ReconciliationService implements Reconciliation {
	private running = false;
	private rerun: ReconcileReason | null = null;
	private cancelInterval: (() => void) | null = null;
	private cancelDebounce: (() => void) | null = null;
	private stopped = true;

	constructor(private readonly options: ReconciliationServiceOptions) {}

	get isRunning(): boolean {
		return this.running;
	}

	/** Whether the periodic interval is currently armed. For tests and diagnostics. */
	get isScheduled(): boolean {
		return this.cancelInterval !== null;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.cancelInterval = this.options.scheduler.every(
			this.options.intervalMs ?? RECONCILIATION_INTERVAL_MS,
			() => void this.run("interval"),
		);
		this.options.logger.debug("Reconciliation interval started", {
			intervalMs: this.options.intervalMs ?? RECONCILIATION_INTERVAL_MS,
		});
	}

	stop(): void {
		this.stopped = true;
		this.cancelInterval?.();
		this.cancelInterval = null;
		this.cancelDebounce?.();
		this.cancelDebounce = null;
	}

	async run(reason: ReconcileReason, mode: RunMode = "automatic"): Promise<CleanupOutcome> {
		if (this.running) {
			// Repeat once the current run finishes rather than queueing an unbounded
			// backlog of identical requests.
			this.rerun = reason;
			return { status: "already-running" };
		}

		this.running = true;
		try {
			const outcome = await this.options.cleanup.run(mode);
			this.options.logger.debug(`Reconciliation finished (${reason})`, {
				reason,
				status: outcome.status,
			});
			return outcome;
		} catch (error) {
			// A failure here is a bug in this plugin, not a problem with a user's file,
			// so it must not escape as an unhandled rejection from a timer callback.
			this.options.logger.error("Reconciliation failed", {
				reason,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			this.running = false;
			const again = this.rerun;
			this.rerun = null;
			if (again !== null && !this.stopped) void this.run(again);
		}
	}

	schedule(reason: ReconcileReason): void {
		if (this.stopped) return;

		this.cancelDebounce?.();
		this.cancelDebounce = this.options.scheduler.after(
			this.options.debounceMs ?? EVENT_DEBOUNCE_MS,
			() => {
				this.cancelDebounce = null;
				void this.run(reason);
			},
		);
	}
}
