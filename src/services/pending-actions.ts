import type { PolicyResolver } from "../domain/policy/policy-resolver";
import type { ExpiredFile } from "../domain/types";
import type { ExpirationScanner } from "./expiration-scanner";
import type { FileActions, FileWatcher, Logger, MoveResult, OpenFileTracker } from "./ports";

export interface PendingActionsOptions {
	readonly scanner: ExpirationScanner;
	readonly actions: FileActions;
	readonly openFiles: OpenFileTracker;
	readonly watcher: FileWatcher;
	/** Builds a resolver from current settings, so re-checks use fresh config. */
	readonly createResolver: () => { readonly resolver: PolicyResolver };
	readonly logger: Logger;
}

/**
 * Holds actions that were confirmed but could not run because the file is open.
 *
 * A file open in an editor must never be moved or deleted out from under the
 * user, so the action waits for the tab to close. When it does, the file is
 * re-examined rather than acted on from memory: if the user edited it before
 * closing, its modification time moved and the TTL restarted, so the queued
 * action is quietly dropped. That single re-check is what implements both
 * halves of the rule — edit to cancel, close to confirm — without tracking
 * edits separately.
 *
 * The queue is deliberately in-memory. Nothing survives a restart, and the next
 * reconciliation rediscovers whatever is still expired, so a stale decision can
 * never outlive the session that made it.
 */
export class PendingActions {
	private readonly queued = new Set<string>();
	private readonly unsubscribers: Array<() => void> = [];

	constructor(private readonly options: PendingActionsOptions) {
		this.unsubscribers.push(
			options.openFiles.subscribe(() => void this.flush()),
			options.watcher.onRenamed((from, to) => this.handleRename(from, to)),
			options.watcher.onDeleted((path) => this.queued.delete(path)),
		);
	}

	/** Files waiting for their editor tab to close. */
	get pendingPaths(): readonly string[] {
		return [...this.queued];
	}

	/** Queues an action for a file that is currently open. */
	defer(item: ExpiredFile): void {
		this.queued.add(item.file.path);
	}

	/**
	 * Runs every queued action whose file is no longer open.
	 *
	 * Failures are reported rather than retried: a file that cannot be trashed now
	 * is unlikely to succeed on the next tab close, and a queue that retries
	 * forever would surface the same error repeatedly. A retry is not needed for
	 * correctness either — the next reconciliation rediscovers the file if it is
	 * still expired, which is the same mechanism that catches a missed run.
	 */
	async flush(): Promise<void> {
		const openPaths = this.options.openFiles.getOpenPaths();
		const ready = [...this.queued].filter((path) => !openPaths.has(path));
		if (ready.length === 0) return;

		const { resolver } = this.options.createResolver();

		for (const path of ready) {
			this.queued.delete(path);

			const item = this.options.scanner.rescan(path, resolver);
			// Still open, edited, or no longer covered by any rule: leave it alone.
			if (item === null) {
				this.options.logger.debug(`Dropped the queued action for "${path}": no longer expired`, {
					path,
				});
				continue;
			}

			try {
				const result = await executeAction(this.options.actions, item);
				if (!result.moved) {
					this.options.logger.error(`Could not remove "${path}"`, { path });
					continue;
				}
				this.options.logger.debug(`Removed "${path}"`, { path });
				for (const message of result.warnings) {
					this.options.logger.warn(`Moved "${path}" but ${message}`, { path });
				}
			} catch (error) {
				this.options.logger.error(`Could not remove "${path}"`, {
					path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** Releases the subscriptions taken out in the constructor. */
	dispose(): void {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers.length = 0;
		this.queued.clear();
	}

	private handleRename(fromPath: string, toPath: string): void {
		if (!this.queued.delete(fromPath)) return;
		// A rename is a modification in spirit, but not one that touches mtime, so
		// follow the file rather than dropping it; `flush` re-checks it either way.
		this.queued.add(toPath);
	}
}

/** Applies an expired file's action. Shared with the immediate execution path. */
export async function executeAction(actions: FileActions, item: ExpiredFile): Promise<MoveResult> {
	if (item.policy.action.kind === "trash") {
		return actions.trash(item.file.path);
	}
	return actions.move(item.file.path, item.policy.action.destination);
}
