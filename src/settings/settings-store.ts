import type { AutoRemoveSettings } from "../domain/types";
import { parseSettings } from "./settings-schema";

/**
 * The persistence surface this store needs. Obsidian's `Plugin` satisfies it
 * structurally, so nothing here has to import the Obsidian API.
 */
export interface SettingsPersistence {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

export type SettingsListener = (settings: AutoRemoveSettings) => void;

/** Reported when a write fails, so the UI can say so rather than losing the edit. */
export type PersistenceFailure = (error: unknown) => void;

export interface SettingsStoreOptions {
	readonly onPersistenceError?: PersistenceFailure;
}

/**
 * Owns the current settings and notifies interested parties when they change.
 *
 * Settings are held as an immutable value: every update replaces the whole
 * object, so a reconciliation that captured a snapshot keeps working against
 * consistent configuration even if the user edits a rule mid-run.
 *
 * ## Why writes are serialised
 *
 * The settings page calls `update` from `onChange`, which fires on every
 * keystroke of a text field. That produced three problems the audit found, all of
 * them here:
 *
 * - concurrent `saveData` calls could land out of order, so `data.json` ended up
 *   holding a snapshot older than the one on screen — the user's last edit
 *   silently lost on the next launch;
 * - a rejected `saveData` inside a discarded promise became an unhandled
 *   rejection, and memory and disk diverged with no message;
 * - listeners were notified only *after* the write resolved, so a trigger change
 *   took effect a disk round-trip late.
 *
 * So writes go through a single-slot queue: one in flight at a time, later updates
 * coalescing into it, and listeners notified from memory immediately. Losing the
 * disk is reported; losing memory never happens.
 */
export class SettingsStore {
	private readonly listeners = new Set<SettingsListener>();
	private readonly onPersistenceError: PersistenceFailure;

	private current: AutoRemoveSettings;
	private draining: Promise<void> | null = null;
	private queued: AutoRemoveSettings | null = null;

	private constructor(
		private readonly persistence: SettingsPersistence,
		settings: AutoRemoveSettings,
		options: SettingsStoreOptions,
	) {
		this.current = settings;
		this.onPersistenceError = options.onPersistenceError ?? (() => {});
	}

	static async load(
		persistence: SettingsPersistence,
		options: SettingsStoreOptions = {},
	): Promise<SettingsStore> {
		const settings = parseSettings(await persistence.loadData());
		return new SettingsStore(persistence, settings, options);
	}

	/** The current configuration. Treat the result as frozen. */
	get settings(): AutoRemoveSettings {
		return this.current;
	}

	/**
	 * Replaces the settings, persists them, and notifies listeners.
	 *
	 * Resolves once this update's own write has been attempted, or immediately if it
	 * was folded into a write already in flight. Never rejects: a persistence failure
	 * is reported through `onPersistenceError`, because a settings field that refuses
	 * to save is not a reason to tear down the plugin.
	 */
	async update(changes: Partial<AutoRemoveSettings>): Promise<void> {
		this.current = { ...this.current, ...changes };

		// Memory is the source of truth for everything that reads settings, so
		// listeners hear about the change now rather than after a disk round-trip.
		for (const listener of this.listeners) listener(this.current);

		this.queued = this.current;

		// A drain already in flight will pick up the new snapshot when it next checks,
		// because checking the queue and clearing `draining` are adjacent statements
		// with no await between them.
		if (this.draining !== null) return;

		await this.drain();
	}

	/** Resolves when every queued write has been attempted. For tests and shutdown. */
	async flush(): Promise<void> {
		await this.draining;
	}

	/** Subscribes to changes. Returns a function that unsubscribes. */
	subscribe(listener: SettingsListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Writes queued snapshots one at a time, newest last.
	 *
	 * Coalescing is deliberate: a burst of keystrokes produces one write of the final
	 * value rather than one write per character. Never rejects — a persistence failure
	 * is reported and the next snapshot still gets its attempt.
	 */
	private async drain(): Promise<void> {
		this.draining = this.drainOnce();
		await this.draining;
	}

	private async drainOnce(): Promise<void> {
		try {
			while (this.queued !== null) {
				const snapshot = this.queued;
				this.queued = null;
				try {
					await this.persistence.saveData(snapshot);
				} catch (error) {
					this.onPersistenceError(error);
				}
			}
		} finally {
			// Adjacent to the loop's last check on purpose; see `update`.
			this.draining = null;
		}
	}
}
