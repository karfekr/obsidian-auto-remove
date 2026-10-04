import type { ActionPlan } from "../domain/plan";
import type { ExpiredFile, FileSnapshot } from "../domain/types";
import type { Clock } from "../infrastructure/clock";

/**
 * The seams between the cleanup logic and the vault it acts on.
 *
 * Each of these is implemented once against the Obsidian API in `src/adapters`
 * and faked in tests. They exist because a test needs them, not for symmetry —
 * anything the services can do in pure code is done in pure code.
 */

/** Reads the vault as a flat list of snapshots. */
export interface FileRepository {
	listFiles(): FileSnapshot[];
	/** Re-reads one file, or returns `null` if it is gone. */
	getFile(path: string): FileSnapshot | null;
}

/**
 * Carries out the removal actions.
 *
 * A move reports what happened to the file *and* anything that went wrong
 * afterwards, because the two are not the same outcome: a file that moved but
 * kept its properties has moved, and reporting it as a failure would be a lie.
 */
export interface FileActions {
	trash(path: string): Promise<MoveResult>;
	/**
	 * Moves a file into `destination`, returning its new path. Implementations
	 * resolve name collisions rather than overwriting.
	 */
	move(path: string, destination: string): Promise<MoveResult>;
}

export interface MoveResult {
	readonly path: string;
	/** The file reached its destination. `false` means nothing happened. */
	readonly moved: boolean;
	/**
	 * The file moved, but something afterwards did not work.
	 *
	 * Never treated as a failure of the move itself: rolling a completed move back
	 * would be a second, riskier mutation.
	 */
	readonly warnings: readonly string[];
}

/** Reports which files are open in the workspace and when that changes. */
export interface OpenFileTracker {
	getOpenPaths(): ReadonlySet<string>;
	/** Subscribes to open-set changes; returns a function that unsubscribes. */
	subscribe(listener: () => void): () => void;
}

/** Notifies when files move or disappear underneath a queued action. */
export interface FileWatcher {
	onRenamed(listener: (fromPath: string, toPath: string) => void): () => void;
	onDeleted(listener: (path: string) => void): () => void;
}

export type { Clock };

/**
 * Timing, behind a seam.
 *
 * The rules are state-based and need no timer to be *correct* — a timer only
 * decides when the plugin notices. Keeping both behind one port means the
 * reconciliation loop, its debounce and its interval are all exercised in tests
 * without a real clock, and without fake timers installed globally.
 */
export interface Scheduler {
	/** Runs `fn` every `ms`. Returns a function that cancels it. */
	every(ms: number, fn: () => void): () => void;
	/** Runs `fn` once, after `ms` of quiet. Returns a function that cancels it. */
	after(ms: number, fn: () => void): () => void;
}

/**
 * Diagnostics.
 *
 * `debug` carries the per-file decision trail and is off unless the user turns
 * it on, because reconciliation also runs on vault events and unconditional
 * logging would drown the console. `warn` and `error` are always emitted.
 */
export interface Logger {
	debug(message: string, context?: LogContext): void;
	warn(message: string, context?: LogContext): void;
	error(message: string, context?: LogContext): void;
}

/**
 * Structured detail for one log line.
 *
 * Values are logged as written; no vault contents or file bodies are ever
 * included, only paths, rule identities and outcomes.
 */
export type LogContext = Readonly<Record<string, unknown>>;

/**
 * Decides whether the confirmation dialog should be shown for a plan.
 *
 * Separate from the preview itself so that "nothing is removed without
 * confirmation" stays unconditional while "ask about this exact set of files
 * again" can be decided once, in one place. Reconciliation runs on a timer as
 * well as on events, so an un-deduplicated prompt would reappear every interval.
 */
export interface PromptPolicy {
	/** Whether to show the confirmation dialog for this plan. */
	shouldPrompt(plan: ActionPlan): boolean;
	/** Called once the dialog has resolved, whatever the user chose. */
	settled(plan: ActionPlan): void;
}

/** The outcome of acting on one expired file. */
export interface ActionFailure {
	readonly item: ExpiredFile;
	readonly error: unknown;
}

export interface CleanupResult {
	/** Files acted on during this run. */
	readonly removed: readonly ExpiredFile[];
	/** Files left alone because they are open; queued to run once closed. */
	readonly deferred: readonly ExpiredFile[];
	/**
	 * Files that moved but were not finished with.
	 *
	 * Kept apart from {@link failed} because the move itself succeeded; rolling
	 * back would be a second mutation, and re-running would rename the file twice.
	 */
	readonly warnings: readonly ActionWarning[];
	readonly failed: readonly ActionFailure[];
}

export interface ActionWarning {
	readonly item: ExpiredFile;
	readonly message: string;
}
