import type { Plugin } from "obsidian";
import type { Runtime } from "./app/runtime";
import { reportPlan } from "./ui/dry-run-report";
import { reportOutcome } from "./ui/notifications";

/**
 * Registers the commands Auto Remove contributes.
 *
 * All of them are on-demand ways into the *same* reconciliation path the startup
 * run, the interval and the vault events use. None contains rule logic, and none
 * can drift from the automatic behaviour — which is the point, because the audit's
 * most expensive defect was a rule that was correct and yet never consulted, with
 * no way to find out short of restarting Obsidian and waiting.
 */
export function registerCommands(plugin: Plugin, runtime: Runtime): void {
	// Reconcile now and confirm what is found. `manual` forces the prompt rather
	// than deferring to "already offered", because the user is watching.
	plugin.addCommand({
		id: "run-now",
		name: "Run now",
		callback: async () => {
			reportOutcome(await runtime.run("manual", "manual"), true);
		},
	});

	// Evaluate everything and report it without touching the vault. Same evaluation,
	// same plan; only the last step is omitted.
	plugin.addCommand({
		id: "dry-run",
		name: "Dry run — report what would be removed",
		callback: async () => {
			const outcome = await runtime.run("dry-run", "dry-run");
			if (outcome.status === "dry-run") reportPlan(outcome.plan, true);
			else reportOutcome(outcome, true);
		},
	});

	// "Why was this file not removed?" for one specific file — including the case
	// where nothing claimed it, which no amount of looking at the log would reveal.
	plugin.addCommand({
		id: "explain-file",
		name: "Explain the active file",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (file === null) return false;
			if (checking) return true;

			reportPlan({ removals: [], decisions: [runtime.explain(file.path)] }, true);
			return true;
		},
	});
}
