import type { EventRef, Vault } from "obsidian";
import type { Logger } from "../services/ports";

/**
 * The events that can change whether a file is expired.
 *
 * Typed against the specific overloads rather than as a union, because Obsidian
 * declares `Vault.on` once per event name and a union defeats the resolution.
 */
type RelevantVaultEvent = "create" | "modify" | "rename";

/**
 * Asks for a reconciliation when the vault changes.
 *
 * Only events that can alter a decision are subscribed. A `delete` cannot make a
 * new file eligible — removing a file only ever reduces the work — and a `resize`
 * or metadata change cannot either, so neither is registered.
 *
 * Every callback goes through the reconciler's debounce rather than running a run,
 * because a single save emits several events in quick succession and a sync client
 * emits them by the hundred. `vault.on('create')` also fires for every file as the
 * vault loads, which is precisely why the run must not be immediate.
 */
export class VaultEventsTrigger {
	readonly id = "vault-events";

	constructor(
		private readonly vault: Vault,
		private readonly requestReconciliation: () => void,
		private readonly logger?: Logger,
	) {}

	start(): () => void {
		const refs: EventRef[] = [
			this.vault.on("create", () => this.notify("create")),
			this.vault.on("modify", () => this.notify("modify")),
			this.vault.on("rename", () => this.notify("rename")),
		];

		return () => {
			for (const ref of refs) this.vault.offref(ref);
			refs.length = 0;
		};
	}

	private notify(event: RelevantVaultEvent): void {
		this.logger?.debug(`Vault event: ${event}`, { event });
		this.requestReconciliation();
	}
}
