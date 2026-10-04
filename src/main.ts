import { Plugin } from "obsidian";
import type { Runtime } from "./app/runtime";
import { createRuntime } from "./app/runtime";
import { registerCommands } from "./commands";
import { systemClock } from "./infrastructure/clock";
import { reportPlan } from "./ui/dry-run-report";
import { reportOutcome } from "./ui/notifications";
import { CleanupPreviewModal } from "./ui/preview-modal";
import { AutoRemoveSettingTab } from "./ui/settings-tab";

/**
 * Auto Remove — expires files by time to live, then trashes or moves them.
 *
 * This class is a shell: it hands Obsidian's `App` and its own lifecycle to
 * `app/runtime.ts` and gets back a wired object graph. Every rule lives in
 * `src/domain`, every workflow in `src/services`, and every Obsidian call in
 * `src/adapters` and `src/ui`. See `docs/ARCHITECTURE.md`.
 */
export default class AutoRemovePlugin extends Plugin {
	private runtime: Runtime | null = null;

	override async onload(): Promise<void> {
		this.runtime = await createRuntime({
			app: this.app,
			persistence: this,
			clock: systemClock,
			register: (cancel) => this.register(cancel),
			preview: (items, openPaths) => CleanupPreviewModal.confirm(this.app, items, openPaths),
		});

		const runtime = this.runtime;
		this.addSettingTab(
			new AutoRemoveSettingTab(this.app, this, runtime.store, () => {
				void runtime.run("dry-run", "dry-run").then((outcome) => {
					if (outcome.status === "dry-run") reportPlan(outcome.plan, true);
					else reportOutcome(outcome, true);
				});
			}),
		);
		registerCommands(this, runtime);
	}

	override onunload(): void {
		// Everything the runtime created was registered with Obsidian through
		// `this.register`, so it is already being torn down. This is belt and braces,
		// and the point at which the composition root's own state is released.
		this.runtime?.dispose();
		this.runtime = null;
	}
}
