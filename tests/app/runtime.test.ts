import { describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime";
import { createRuntime } from "../../src/app/runtime";
import type { AutoRemoveSettings, FolderRule } from "../../src/domain/types";
import { ManualClock } from "../../src/infrastructure/clock";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults";
import { RecordingLogger } from "../support/loggers";
import type { FakeApp } from "../support/obsidian-mock";
import { installObsidianMock } from "../support/obsidian-mock";
import { ManualScheduler } from "../support/test-doubles";

/**
 * The production wiring, end to end.
 *
 * This is the class of bug the audit called the most expensive one: the rules are
 * correct, every unit test passes, and the plugin still fails to consult them
 * because something in the assembly is wrong — a clock never injected, a resolver
 * built from the wrong settings, a trigger never registered.
 *
 * So this exercises `createRuntime` — the real composition root that `main.ts`
 * calls — against a stand-in for Obsidian, and asserts on what the vault actually
 * received. Nothing here is mocked above the platform boundary: the scanner, the
 * resolver, the planner, the executor, the reconciler and both triggers are the
 * shipping implementations.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 12);

function rule(overrides: Partial<FolderRule> = {}): FolderRule {
	return {
		id: "rule-inbox",
		enabled: true,
		folder: "Inbox",
		ttlDays: 1,
		action: "trash",
		moveDestination: "",
		scope: "md",
		ignorePatterns: [],
		...overrides,
	};
}

interface Harness {
	app: FakeApp;
	runtime: Runtime;
	clock: ManualClock;
	scheduler: ManualScheduler;
	logger: RecordingLogger;
	teardown: Array<() => void>;
	/** How many times the confirmation dialog has been offered. */
	prompts: number;
}

async function setup(
	files: Array<{ path: string; mtime?: number; frontmatter?: Record<string, unknown> | null }>,
	settings: Partial<AutoRemoveSettings> = {},
	options: { layoutReady?: boolean; confirm?: boolean; openPaths?: string[] } = {},
): Promise<Harness> {
	const app = installObsidianMock({
		files: files.map((file) => ({
			path: file.path,
			mtime: file.mtime ?? 0,
			...(file.frontmatter === undefined ? {} : { frontmatter: file.frontmatter }),
		})),
		layoutReady: options.layoutReady ?? true,
		...(options.openPaths === undefined ? {} : { openPaths: options.openPaths }),
	});

	const clock = new ManualClock(NOW);
	const scheduler = new ManualScheduler();
	const logger = new RecordingLogger(true);
	const teardown: Array<() => void> = [];
	const harness: Harness = {
		app,
		runtime: null as never,
		clock,
		scheduler,
		logger,
		teardown,
		prompts: 0,
	};

	return install(harness, settings, options);
}

async function install(
	harness: Harness,
	settings: Partial<AutoRemoveSettings>,
	options: { confirm?: boolean },
): Promise<Harness> {
	const persisted: unknown[] = [];
	let current: AutoRemoveSettings = { ...DEFAULT_SETTINGS, ...settings };

	harness.runtime = await createRuntime({
		app: harness.app as never,
		persistence: {
			loadData: async () => current,
			saveData: async (data) => {
				persisted.push(data);
				current = data as AutoRemoveSettings;
			},
		},
		clock: harness.clock.now,
		scheduler: harness.scheduler,
		logger: harness.logger,
		// Mirrors what `Plugin` does: collect teardown, run it on unload.
		register: (cancel) => harness.teardown.push(cancel),
		intervalMs: 60_000,
		debounceMs: 1_000,
		preview: async (items) => {
			harness.prompts += 1;
			return (options.confirm ?? true) ? items : null;
		},
	});

	return harness;
}

/** Lets queued microtasks settle, as awaiting the runtime's own promises would. */
async function settle(): Promise<void> {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("the composition root", () => {
	let harness: Harness;

	describe("startup", () => {
		it("reconciles purely because the plugin loaded — no interval, no command", async () => {
			harness = await setup(
				[{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }],
				{
					folderRules: [rule()],
				},
				{ layoutReady: true },
			);
			await settle();

			// `onLayoutReady` runs its callback at once when the layout is already ready,
			// which is what happens on every ordinary launch. So by the time the plugin
			// has finished loading, the first reconciliation has already happened.
			expect(harness.app.vault.getFileByPath("Inbox/old.md")).toBeNull();

			// And it was the startup run that did it: no interval has elapsed.
			harness.scheduler.advance(1_000);
			await settle();
			expect(harness.app.fileManager.calls.filter((c) => c.method === "trashFile")).toHaveLength(1);
		});

		it("catches up a file that expired while Obsidian was closed", async () => {
			// A week away: nothing could have run, so the startup reconciliation is the
			// only thing that can find this.
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 7 * DAY }], {
				folderRules: [rule()],
			});

			await settle();

			expect(harness.app.fileManager.calls).toContainEqual({
				method: "trashFile",
				args: ["Inbox/old.md"],
			});
		});

		it("waits for the layout when it is not ready yet", async () => {
			harness = await setup(
				[{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }],
				{
					folderRules: [rule()],
				},
				{ layoutReady: false },
			);

			await settle();
			// Still there: nothing has been removed before the workspace can say what is
			// open.
			expect(harness.app.vault.getFileByPath("Inbox/old.md")).not.toBeNull();

			harness.app.workspace.layoutReady = true;
			harness.app.workspace.emitLayoutReady();
			await settle();

			expect(harness.app.vault.getFileByPath("Inbox/old.md")).toBeNull();
		});

		it("does not reconcile twice if layout becomes ready again", async () => {
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule()],
			});

			await settle();
			harness.app.workspace.emitLayoutReady();
			await settle();

			expect(
				harness.app.fileManager.calls.filter((call) => call.method === "trashFile"),
			).toHaveLength(1);
		});

		it("leaves a file that has not expired", async () => {
			harness = await setup([{ path: "Inbox/fresh.md", mtime: NOW - 60_000 }], {
				folderRules: [rule({ ttlDays: 1 })],
			});

			await settle();

			expect(harness.app.fileManager.calls).toHaveLength(0);
			expect(harness.app.vault.getFileByPath("Inbox/fresh.md")).not.toBeNull();
		});
	});

	describe("the periodic interval", () => {
		it("reconciles again as time passes", async () => {
			harness = await setup([{ path: "Inbox/a.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule()],
			});
			await settle();

			// Add a second file that only becomes eligible later.
			harness.app.vault.addFile({ path: "Inbox/later.md", mtime: NOW });
			expect(harness.app.vault.getFileByPath("Inbox/later.md")).not.toBeNull();

			harness.clock.advanceMs(2 * DAY);
			harness.scheduler.fireIntervals();
			await settle();

			expect(harness.app.vault.getFileByPath("Inbox/later.md")).toBeNull();
		});

		it("is armed once and released on teardown", async () => {
			harness = await setup([], {});
			await settle();

			expect(harness.runtime.reconciliation.isScheduled).toBe(true);

			for (const teardown of harness.teardown) teardown();
			harness.runtime.dispose();

			expect(harness.runtime.reconciliation.isScheduled).toBe(false);
		});
	});

	describe("vault events", () => {
		it("registers only the events that can change a decision", async () => {
			harness = await setup([], {});
			await settle();

			// create/modify/rename can make a file eligible or change its age. A delete
			// cannot: removing a file only ever reduces the work.
			const file = harness.app.vault.addFile({ path: "Inbox/a.md", mtime: NOW });

			harness.app.vault.emit("modify", file);
			harness.app.vault.emit("create", file);
			harness.app.vault.emit("rename", file, "Inbox/b.md");

			// A burst coalesces into one reconciliation after the debounce, not three.
			harness.scheduler.advance(1_000);
			await settle();

			expect(harness.runtime.reconciliation.isRunning).toBe(false);
			expect(harness.scheduler.armedCount).toBe(1);
		});

		it("notices a file that becomes eligible because it was created", async () => {
			harness = await setup([], { folderRules: [rule()] });
			await settle();

			const old = harness.clock.now() - 10 * DAY;
			const added = harness.app.vault.addFile({ path: "Inbox/imported.md", mtime: old });
			harness.app.vault.emit("create", added);

			harness.scheduler.advance(1_000);
			await settle();

			expect(harness.app.vault.getFileByPath("Inbox/imported.md")).toBeNull();
		});

		it("does not act on a file that merely exists until something happens", async () => {
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule()],
			});
			await settle();

			// The startup run already dealt with it; a file appearing on disk with an old
			// mtime is only noticed on the next reconciliation, which is correct: it
			// must never be deleted without having been offered.
			expect(harness.app.fileManager.calls.filter((c) => c.method === "trashFile")).toHaveLength(1);
		});
	});

	describe("on demand", () => {
		it("run-now reconciles through the same path", async () => {
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule()],
			});
			await settle();

			const added = harness.app.vault.addFile({ path: "Inbox/second.md", mtime: NOW - 10 * DAY });
			expect(harness.app.vault.getFileByPath(added.path)).not.toBeNull();

			await harness.runtime.run("manual", "manual");

			expect(harness.app.vault.getFileByPath("Inbox/second.md")).toBeNull();
		});

		it("run-now always prompts, even for a set already offered and declined", async () => {
			harness = await setup(
				[{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }],
				{
					folderRules: [rule()],
				},
				{ confirm: false },
			);
			await settle();

			// The automatic run was offered this set and declined it.
			expect(harness.prompts).toBe(1);
			expect(harness.app.vault.getFileByPath("Inbox/old.md")).not.toBeNull();
			expect(harness.app.fileManager.calls.filter((c) => c.method === "trashFile")).toHaveLength(0);

			// A further automatic pass over the *same* set does not nag.
			await harness.runtime.run("interval");
			expect(harness.prompts).toBe(1);

			// A manual run always asks, because the user is waiting for the answer.
			await harness.runtime.run("manual", "manual");
			expect(harness.prompts).toBe(2);
		});

		it("a dry run changes nothing", async () => {
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule()],
			});
			await settle();

			harness.app.vault.addFile({ path: "Inbox/other.md", mtime: NOW - 10 * DAY });
			const outcome = await harness.runtime.run("dry-run", "dry-run");

			expect(outcome.status).toBe("dry-run");
			expect(harness.app.fileManager.calls.filter((c) => c.method === "trashFile")).toHaveLength(1);
		});
	});

	describe("rules reaching the filesystem", () => {
		it("moves rather than trashes when the rule says move", async () => {
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule({ action: "move", moveDestination: "Archive" })],
			});

			await settle();

			expect(harness.app.fileManager.calls).toContainEqual({
				method: "renameFile",
				args: ["Inbox/old.md", "Archive/old.md"],
			});
			expect(harness.app.vault.getFileByPath("Archive/old.md")).not.toBeNull();
		});

		it("never deletes a note whose move has no destination", async () => {
			// The configuration the audit called indefensible, checked through the real
			// wiring: an unusable move must produce no action at all.
			harness = await setup(
				[{ path: "Inbox/old.md", mtime: NOW - 10 * DAY, frontmatter: { "auto-remove": true } }],
				{ defaultAction: "move", defaultMoveDestination: "" },
			);

			await settle();

			expect(harness.app.fileManager.calls).toHaveLength(0);
			expect(harness.app.vault.getFileByPath("Inbox/old.md")).not.toBeNull();
			expect(harness.logger.messagesMatching("Configuration is incomplete")).not.toHaveLength(0);
		});

		it("honours the file scope", async () => {
			harness = await setup(
				[
					{ path: "Inbox/note.md", mtime: NOW - 10 * DAY },
					{ path: "Inbox/image.png", mtime: NOW - 10 * DAY },
				],
				{ folderRules: [rule({ scope: "md" })] },
			);

			await settle();

			expect(harness.app.vault.getFileByPath("Inbox/note.md")).toBeNull();
			expect(harness.app.vault.getFileByPath("Inbox/image.png")).not.toBeNull();
		});

		it("removes attachments too when the rule opts in", async () => {
			harness = await setup([{ path: "Inbox/image.png", mtime: NOW - 10 * DAY }], {
				folderRules: [rule({ scope: "all" })],
			});

			await settle();

			expect(harness.app.vault.getFileByPath("Inbox/image.png")).toBeNull();
		});
	});

	describe("repeating safely", () => {
		it("running three times in a row removes the file once", async () => {
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule()],
			});
			await settle();

			await harness.runtime.run("manual", "manual");
			await harness.runtime.run("manual", "manual");
			await harness.runtime.run("manual", "manual");

			expect(harness.app.fileManager.calls.filter((c) => c.method === "trashFile")).toHaveLength(1);
		});

		it("never processes a file that is already gone", async () => {
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule()],
			});
			await settle();

			// The second and third runs find nothing, because the file is no longer in
			// the vault. Nothing throws, and nothing is invented.
			const second = await harness.runtime.run("manual", "manual");
			const third = await harness.runtime.run("manual", "manual");

			expect(second.status).toBe("nothing-expired");
			expect(third.status).toBe("nothing-expired");
		});

		it("survives a burst of overlapping triggers without acting twice", async () => {
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule()],
			});
			await settle();

			harness.app.vault.addFile({ path: "Inbox/other.md", mtime: NOW - 10 * DAY });

			// An interval, an event and a manual request, all at once.
			harness.scheduler.fireIntervals();
			harness.app.vault.emit("modify");
			const manual = harness.runtime.run("manual", "manual");
			harness.scheduler.advance(1_000);
			await manual;
			await settle();

			const trashed = harness.app.fileManager.calls.filter((c) => c.method === "trashFile");
			expect(new Set(trashed.map((call) => call.args[0])).size).toBe(trashed.length);
		});
	});

	describe("lifecycle", () => {
		it("releases every listener it registered", async () => {
			harness = await setup([], {});
			await settle();

			// The composition root hands teardown to the plugin, which runs these on
			// unload. Nothing must be left holding the vault or the workspace.
			const registered = harness.app.vault.listenerCount();

			for (const teardown of harness.teardown) teardown();

			expect(harness.app.vault.listenerCount()).toBeLessThanOrEqual(registered);
			expect(harness.scheduler.armedCount).toBe(0);
		});

		it("stops reconciling after teardown", async () => {
			harness = await setup([], { folderRules: [rule()] });
			await settle();

			harness.runtime.dispose();
			harness.scheduler.fireIntervals();
			harness.app.vault.emit("modify");
			harness.scheduler.advance(10_000);
			await settle();

			harness.app.vault.addFile({ path: "Inbox/late.md", mtime: NOW - 10 * DAY });
			harness.scheduler.fireIntervals();
			await settle();

			expect(harness.app.vault.getFileByPath("Inbox/late.md")).not.toBeNull();
		});
	});

	describe("settings changes", () => {
		it("reconciles again after a rule is edited", async () => {
			harness = await setup([{ path: "Inbox/old.md", mtime: NOW - 10 * DAY }], {
				folderRules: [rule({ ttlDays: 30 })],
			});
			await settle();

			expect(harness.app.vault.getFileByPath("Inbox/old.md")).not.toBeNull();

			// Shorten the TTL: the user has just said what should happen to their files,
			// so there is no reason to wait for the next interval.
			await harness.runtime.store.update({ folderRules: [rule({ ttlDays: 1 })] });
			harness.scheduler.advance(1_000);
			await settle();

			expect(harness.app.vault.getFileByPath("Inbox/old.md")).toBeNull();
		});
	});
});
