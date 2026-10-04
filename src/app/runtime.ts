import type { App } from "obsidian";
import { VaultFileActions } from "../adapters/vault-file-actions";
import { VaultFileRepository } from "../adapters/vault-file-repository";
import { WindowScheduler } from "../adapters/window-scheduler";
import { WorkspaceOpenFileTracker } from "../adapters/workspace-open-files";
import type { FileDecision } from "../domain/plan";
import { buildPolicyResolver } from "../domain/policy/resolver-factory";
import type { Clock } from "../infrastructure/clock";
import { ConsoleLogger } from "../infrastructure/logging";
import { ActionExecutor } from "../services/action-executor";
import type { CleanupOutcome, PreviewGate, RunMode } from "../services/cleanup-service";
import { CleanupService, OncePerPlanPromptPolicy } from "../services/cleanup-service";
import { ExpirationScanner } from "../services/expiration-scanner";
import { PendingActions } from "../services/pending-actions";
import type { Logger, PromptPolicy, Scheduler } from "../services/ports";
import type { ReconcileReason } from "../services/reconciliation-service";
import { ReconciliationService } from "../services/reconciliation-service";
import type { SettingsPersistence } from "../settings/settings-store";
import { SettingsStore } from "../settings/settings-store";
import { StartupTrigger } from "../triggers/startup-trigger";
import { VaultEventsTrigger } from "../triggers/vault-events-trigger";

/**
 * Everything the plugin needs from the host, expressed as ports.
 *
 * `App` is the real Obsidian application, but nothing here reaches past it: the
 * adapters are the only things that touch it, and each of those can be handed a
 * stand-in. That is what makes it possible to test the wiring below for real
 * rather than asserting that it was constructed.
 */
export interface RuntimeOptions {
	readonly app: App;
	readonly persistence: SettingsPersistence;
	readonly clock: Clock;
	/** Registers a teardown to run when the plugin unloads. */
	readonly register: (cancel: () => void) => void;
	/**
	 * How a confirmation is obtained. Supplied rather than constructed so the wiring
	 * can be exercised without a DOM.
	 */
	readonly preview: PreviewGate;
	/** Defaults to a window-timer scheduler. Tests supply their own. */
	readonly scheduler?: Scheduler;
	readonly logger?: Logger;
	readonly promptPolicy?: PromptPolicy;
	readonly intervalMs?: number;
	readonly debounceMs?: number;
}

export interface Runtime {
	readonly store: SettingsStore;
	readonly reconciliation: ReconciliationService;
	readonly cleanup: CleanupService;
	readonly explain: (path: string) => FileDecision;
	/** Runs a reconciliation now, bypassing the debounce. */
	readonly run: (reason: ReconcileReason, mode?: RunMode) => Promise<CleanupOutcome>;
	/** Releases every timer and subscription this runtime registered. */
	dispose(): void;
}

/**
 * Builds the plugin's object graph and wires it together.
 *
 * This is the composition root, lifted out of `Plugin.onload` and expressed as an
 * ordinary function. The reason is testability: the audit's most expensive gap was
 * that the wiring itself was never exercised, so a rule could be correct, every
 * unit test could pass, and the plugin still fail to consult it. Here the wiring is
 * a value that can be assembled in a test and driven end to end.
 *
 * It is deliberately hand-wired. No container, no event bus, no generic repository:
 * the graph is small enough to read top to bottom, and every dependency is visible
 * at the point it is used.
 *
 * Settings are loaded first, before anything else exists. That ordering is not
 * incidental — a reconciliation that began against default settings could remove
 * files according to rules the user has not written yet.
 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
	const { app, register } = options;

	// A settings write that fails must be visible, so the reporter is built before
	// the store that uses it. Nothing is lost either way: memory holds the change
	// and the failure is reported rather than swallowed.
	//
	// The debug flag lives in a holder because the logger has to exist first, while
	// the value it reads only exists once the settings have loaded. Toggling the
	// setting therefore takes effect immediately rather than at the next reload.
	const debug = { enabled: false };
	const log = options.logger ?? new ConsoleLogger(() => debug.enabled);
	const scheduler = options.scheduler ?? new WindowScheduler(register);

	const store = await SettingsStore.load(options.persistence, {
		onPersistenceError: (error) => log.error(`Could not save settings: ${describe(error)}`),
	});

	debug.enabled = store.settings.debugLogging;
	store.subscribe((settings) => {
		debug.enabled = settings.debugLogging;
	});

	const openFiles = new WorkspaceOpenFileTracker(app);
	const actions = new VaultFileActions(app, log);
	const scanner = new ExpirationScanner(new VaultFileRepository(app), options.clock);

	const pending = new PendingActions({
		scanner,
		actions,
		openFiles,
		watcher: openFiles,
		createResolver: () => ({ resolver: buildPolicyResolver(store.settings).resolver }),
		logger: log,
	});
	register(() => pending.dispose());
	register(() => openFiles.dispose());

	const cleanup = new CleanupService({
		scanner,
		executor: new ActionExecutor(actions, openFiles, pending, log),
		openFiles,
		logger: log,
		createResolver: () => buildPolicyResolver(store.settings),
		preview: options.preview,
		promptPolicy: options.promptPolicy ?? new OncePerPlanPromptPolicy(),
	});

	const reconciliation = new ReconciliationService({
		cleanup,
		scheduler,
		logger: log,
		...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
		...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
	});

	const startup = new StartupTrigger(app.workspace, () => {
		void reconciliation.run("startup").then(reportRun(log, "startup"));
	});
	register(startup.start());

	const vaultEvents = new VaultEventsTrigger(
		app.vault,
		() => reconciliation.schedule("vault-event"),
		log,
	);
	register(vaultEvents.start());

	register(() => reconciliation.stop());

	// Editing a rule is as good a moment to notice expiry as any other: the user has
	// just said what should happen to their files.
	register(store.subscribe(() => reconciliation.schedule("settings-change")));

	// Started last, and deliberately not awaited: the startup trigger owns the first
	// reconciliation, and it waits for the layout so that open files are known.
	reconciliation.start();

	return {
		store,
		reconciliation,
		cleanup,
		explain: (path) => cleanup.explain(path),
		run: (reason, mode) => reconciliation.run(reason, mode),
		dispose: () => {
			reconciliation.stop();
		},
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function reportRun(log: Logger, reason: ReconcileReason): (outcome: unknown) => void {
	return (outcome) => {
		log.debug(`Reconciliation (${reason}) finished`, { reason, outcome: describeOutcome(outcome) });
	};
}

function describeOutcome(outcome: unknown): string {
	if (typeof outcome !== "object" || outcome === null || !("status" in outcome)) return "unknown";
	return String(outcome.status);
}
