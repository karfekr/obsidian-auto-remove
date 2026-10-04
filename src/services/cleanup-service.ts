import type { ActionPlan } from "../domain/plan";
import { buildPlan, planSignature } from "../domain/plan";
import type { PolicyResolver } from "../domain/policy/policy-resolver";
import type { ExpiredFile } from "../domain/types";
import type { ConfigurationProblem } from "../domain/validation";
import { describeProblems } from "../domain/validation";
import type { ActionExecutor } from "./action-executor";
import type { ExpirationScanner } from "./expiration-scanner";
import type { CleanupResult, Logger, OpenFileTracker, PromptPolicy } from "./ports";

/**
 * Decides which expired files the user confirmed.
 *
 * Returning `null` cancels the run. Today this is always the preview dialog;
 * keeping it as a function is what lets preview become optional later without
 * the cleanup path itself changing shape.
 */
export type PreviewGate = (
	items: readonly ExpiredFile[],
	openPaths: ReadonlySet<string>,
) => Promise<readonly ExpiredFile[] | null>;

/** How a run ended, so callers can report it appropriately. */
export type CleanupOutcome =
	| { readonly status: "nothing-expired"; readonly plan: ActionPlan }
	| { readonly status: "cancelled"; readonly plan: ActionPlan }
	| { readonly status: "already-running" }
	| { readonly status: "skipped"; readonly plan: ActionPlan; readonly reason: string }
	| { readonly status: "dry-run"; readonly plan: ActionPlan }
	| { readonly status: "completed"; readonly plan: ActionPlan; readonly result: CleanupResult };

/** How a run was asked for. Only affects reporting, never what is decided. */
export type RunMode = "automatic" | "manual" | "dry-run";

export interface CleanupServiceOptions {
	readonly scanner: ExpirationScanner;
	readonly executor: ActionExecutor;
	readonly openFiles: OpenFileTracker;
	readonly logger: Logger;
	/**
	 * Builds a resolver from the settings in force at the start of the run.
	 *
	 * Returns the resolver together with any configuration that could not be turned
	 * into one. Reporting the problems is what stops an unusable rule from looking
	 * exactly like a working plugin.
	 */
	readonly createResolver: () => {
		readonly resolver: PolicyResolver;
		readonly problems: readonly ConfigurationProblem[];
	};
	readonly preview: PreviewGate;
	readonly promptPolicy: PromptPolicy;
}

/**
 * One cleanup run, start to finish: evaluate, plan, ask, act.
 *
 * This is the only place a run is decided. Triggers, the interval and the
 * command palette all arrive here, so none of them can introduce a second,
 * subtly different cleanup path — and none of them contains business logic.
 */
export class CleanupService {
	private running = false;

	constructor(private readonly options: CleanupServiceOptions) {}

	/**
	 * Evaluate, plan and — unless asked not to — confirm and act.
	 *
	 * `dryRun` stops after planning, so the dry run and the real run cannot
	 * disagree: both call this method, and only the last step differs.
	 */
	async run(mode: RunMode = "automatic"): Promise<CleanupOutcome> {
		if (this.running) return { status: "already-running" };
		this.running = true;

		try {
			const { resolver, problems } = this.options.createResolver();
			this.reportProblems(problems);

			const decisions = this.options.scanner.evaluate(resolver);
			const plan = buildPlan(decisions, this.options.openFiles.getOpenPaths());
			this.logPlan(plan, mode);

			if (plan.removals.length === 0) return { status: "nothing-expired", plan };
			if (mode === "dry-run") return { status: "dry-run", plan };

			// Automatic runs are de-duplicated so a five-minute interval does not re-raise the
			// same dialog. A manual run is not: the user asked, so they are asked.
			if (mode !== "manual" && !this.options.promptPolicy.shouldPrompt(plan)) {
				const reason = "These files were already offered and nothing has changed since.";
				this.options.logger.debug("Skipping an unchanged prompt", { files: plan.removals.length });
				return { status: "skipped", plan, reason };
			}

			const confirmed = await this.options.preview(
				plan.removals.map((removal) => removal.item),
				this.options.openFiles.getOpenPaths(),
			);
			this.options.promptPolicy.settled(plan);

			if (confirmed === null || confirmed.length === 0) return { status: "cancelled", plan };

			const result = await this.options.executor.execute(confirmed);
			return { status: "completed", plan, result };
		} finally {
			this.running = false;
		}
	}

	/**
	 * Explains the decision for one path.
	 *
	 * The direct answer to "why was this file not removed?", including the case
	 * that motivates it: a note carrying `auto-remove: true` while the default
	 * action is an unusable move.
	 */
	explain(path: string): ActionPlan["decisions"][number] {
		const { resolver, problems } = this.options.createResolver();
		this.reportProblems(problems);
		return this.options.scanner.explain(path, resolver);
	}

	/** A fingerprint of what the current configuration would do. For tests. */
	planSignature(plan: ActionPlan): string {
		return planSignature(plan);
	}

	private reportProblems(problems: readonly ConfigurationProblem[]): void {
		if (problems.length === 0) return;
		this.options.logger.warn(
			`Configuration is incomplete, so ${problems.length} rule(s) are not running: ${describeProblems(problems)}`,
			{ targets: problems.map((problem) => problem.target) },
		);
	}

	private logPlan(plan: ActionPlan, mode: RunMode): void {
		this.options.logger.debug(
			`Evaluated ${plan.decisions.length + plan.removals.length} file(s) in ${mode} mode; ` +
				`${plan.removals.length} eligible`,
			{ mode },
		);

		for (const removal of plan.removals) {
			this.options.logger.debug(`Would remove ${removal.item.file.path} — ${removal.reason}`, {
				path: removal.item.file.path,
				rule: removal.ruleId,
				action: removal.action.kind,
				open: removal.open,
			});
		}

		for (const decision of plan.decisions) {
			this.options.logger.debug(`Kept ${decision.file.path} — ${decision.reason}`, {
				path: decision.file.path,
				outcome: decision.outcome,
			});
		}
	}
}

/**
 * Asks about every distinct set of files, once.
 *
 * Reconciliation runs on a timer as well as on events. Without this, an unchanged
 * set of expired files would raise the same dialog every interval, which is how a
 * background plugin becomes something users disable. A manual run bypasses it
 * entirely via `ForcePromptPolicy`.
 */
export class OncePerPlanPromptPolicy implements PromptPolicy {
	private lastSignature: string | null = null;

	shouldPrompt(plan: ActionPlan): boolean {
		return planSignature(plan) !== this.lastSignature;
	}

	settled(plan: ActionPlan): void {
		this.lastSignature = planSignature(plan);
	}
}

/** Always asks. Used by manual runs and by tests that do not care about nagging. */
export class ForcePromptPolicy implements PromptPolicy {
	shouldPrompt(): boolean {
		return true;
	}

	settled(): void {}
}
