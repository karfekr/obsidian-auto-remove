import { describe, expect, it } from "vitest";
import { buildPolicyResolver } from "../../src/domain/policy/resolver-factory";
import type { AutoRemoveSettings, FolderRule } from "../../src/domain/types";
import { ManualClock } from "../../src/infrastructure/clock";
import { ActionExecutor } from "../../src/services/action-executor";
import type { PreviewGate } from "../../src/services/cleanup-service";
import {
	CleanupService,
	ForcePromptPolicy,
	OncePerPlanPromptPolicy,
} from "../../src/services/cleanup-service";
import { ExpirationScanner } from "../../src/services/expiration-scanner";
import { PendingActions } from "../../src/services/pending-actions";
import type { PromptPolicy } from "../../src/services/ports";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults";
import { RecordingLogger } from "../support/loggers";
import { FakeOpenFiles, FakeVault, FakeWatcher } from "../support/test-doubles";

const HOUR = 3_600_000;

/**
 * The scenarios the brief asks to be provable without waiting a day.
 *
 * The whole point of the injected clock: each of these is a single assertion that
 * takes microseconds, where the same check through any other route would mean
 * sleeping.
 */
describe("day-based rules without waiting for a day", () => {
	function harness(ttlDays: number, action: "trash" | "move" = "trash") {
		const mtime = Date.UTC(2026, 9, 1, 12);
		const clock = new ManualClock(mtime);
		const vault = new FakeVault([{ path: "Inbox/note.md", mtime }]);
		const logger = new RecordingLogger(true);
		const openFiles = new FakeOpenFiles();

		const rule: FolderRule = {
			id: "rule-Inbox",
			enabled: true,
			folder: "Inbox",
			ttlDays,
			action,
			moveDestination: action === "move" ? "Archive" : "",
			scope: "md",
			ignorePatterns: [],
		};
		const settings: AutoRemoveSettings = { ...DEFAULT_SETTINGS, folderRules: [rule] };

		const scanner = new ExpirationScanner(vault, clock.now);
		const pending = new PendingActions({
			scanner,
			actions: vault,
			openFiles,
			watcher: new FakeWatcher(),
			createResolver: () => ({ resolver: buildPolicyResolver(settings).resolver }),
			logger,
		});
		const service = new CleanupService({
			scanner,
			executor: new ActionExecutor(vault, openFiles, pending, logger),
			openFiles,
			logger,
			createResolver: () => buildPolicyResolver(settings),
			preview: async (items) => items,
			promptPolicy: new ForcePromptPolicy(),
		});

		return { service, vault, clock, mtime };
	}

	it("keeps a file that is 23 hours old", async () => {
		const { service, vault, clock } = harness(1);

		clock.set(Date.UTC(2026, 9, 1, 12) + 23 * HOUR);
		await service.run("manual");

		expect(vault.trashed).toEqual([]);
		expect(vault.has("Inbox/note.md")).toBe(true);
	});

	it("removes a file that is exactly 24 hours old", async () => {
		const { service, vault, clock } = harness(1);

		clock.set(Date.UTC(2026, 9, 1, 12) + 24 * HOUR);
		await service.run("manual");

		expect(vault.trashed).toEqual(["Inbox/note.md"]);
	});

	it("removes a file that is 25 hours old", async () => {
		const { service, vault, clock } = harness(1);

		clock.set(Date.UTC(2026, 9, 1, 12) + 25 * HOUR);
		await service.run("manual");

		expect(vault.trashed).toEqual(["Inbox/note.md"]);
	});

	it("moves rather than trashes, and strips the properties it owns", async () => {
		const mtime = Date.UTC(2026, 9, 1, 12);
		const clock = new ManualClock(mtime + 5 * 24 * HOUR);
		// No `auto-remove` key: an explicit opt-in would outrank the folder rule and
		// use the default action instead, which is a different test. A stray `ttl`
		// is inert but still present, so the strip has something to remove.
		const vault = new FakeVault([
			{ path: "Inbox/note.md", mtime, frontmatter: { ttl: 99, tags: ["keep"] } },
		]);
		const logger = new RecordingLogger(true);
		const openFiles = new FakeOpenFiles();
		const settings: AutoRemoveSettings = {
			...DEFAULT_SETTINGS,
			folderRules: [
				{
					id: "r",
					enabled: true,
					folder: "Inbox",
					ttlDays: 5,
					action: "move",
					moveDestination: "Archive",
					scope: "md",
					ignorePatterns: [],
				},
			],
		};
		const scanner = new ExpirationScanner(vault, clock.now);
		const pending = new PendingActions({
			scanner,
			actions: vault,
			openFiles,
			watcher: new FakeWatcher(),
			createResolver: () => ({ resolver: buildPolicyResolver(settings).resolver }),
			logger,
		});
		const service = new CleanupService({
			scanner,
			executor: new ActionExecutor(vault, openFiles, pending, logger),
			openFiles,
			logger,
			createResolver: () => buildPolicyResolver(settings),
			preview: async (items) => items,
			promptPolicy: new ForcePromptPolicy(),
		});

		await service.run("manual");

		expect(vault.moved).toEqual([{ from: "Inbox/note.md", to: "Archive/note.md" }]);
		expect(vault.trashed).toEqual([]);
		// The properties Auto Remove owns are gone; everything else is untouched.
		expect(vault.frontmatterOf("Archive/note.md")).toEqual({ tags: ["keep"] });
	});

	it("a TTL of zero expires on sight", async () => {
		const { service, vault } = harness(0);
		await service.run("manual");
		expect(vault.trashed).toEqual(["Inbox/note.md"]);
	});

	it("a file modified in the future is never expired", async () => {
		const { service, vault, clock } = harness(1);
		clock.set(Date.UTC(2026, 8, 30));
		await service.run("manual");
		expect(vault.trashed).toEqual([]);
	});
});

describe("dry run", () => {
	function setup(now: number, files: Array<{ path: string; mtime: number }>) {
		const clock = new ManualClock(now);
		const vault = new FakeVault(files);
		const logger = new RecordingLogger(true);
		const openFiles = new FakeOpenFiles();
		const settings: AutoRemoveSettings = {
			...DEFAULT_SETTINGS,
			folderRules: [
				{
					id: "r",
					enabled: true,
					folder: "Inbox",
					ttlDays: 1,
					action: "trash",
					moveDestination: "",
					scope: "md",
					ignorePatterns: [],
				},
			],
		};
		const preview: PreviewGate = async () => {
			throw new Error("A dry run must never open the confirmation dialog.");
		};
		const scanner = new ExpirationScanner(vault, clock.now);
		const pending = new PendingActions({
			scanner,
			actions: vault,
			openFiles,
			watcher: new FakeWatcher(),
			createResolver: () => ({ resolver: buildPolicyResolver(settings).resolver }),
			logger,
		});
		const service = new CleanupService({
			scanner,
			executor: new ActionExecutor(vault, openFiles, pending, logger),
			openFiles,
			logger,
			createResolver: () => buildPolicyResolver(settings),
			preview,
			promptPolicy: new ForcePromptPolicy(),
		});

		return { service, vault };
	}

	it("reports what would happen without changing the vault", async () => {
		const now = Date.UTC(2026, 9, 2, 12);
		const { service, vault } = setup(now, [
			{ path: "Inbox/expired.md", mtime: now - 5 * 24 * 3_600_000 },
			{ path: "Inbox/fresh.md", mtime: now - 3_600_000 },
			{ path: "Elsewhere/note.md", mtime: now - 99 * 24 * 3_600_000 },
		]);

		const outcome = await service.run("dry-run");

		expect(outcome.status).toBe("dry-run");
		if (outcome.status !== "dry-run") return;

		// The answer to "which files would be removed, and why?"
		expect(outcome.plan.removals.map((removal) => removal.item.file.path)).toEqual([
			"Inbox/expired.md",
		]);
		expect(outcome.plan.removals[0]?.reason).toContain("past its 1 day time to live");
		expect(outcome.plan.removals[0]?.ruleId).toBe("r");

		// And nothing was touched.
		expect(vault.trashed).toEqual([]);
		expect(vault.moved).toEqual([]);
		expect(vault.has("Inbox/expired.md")).toBe(true);
	});

	it("explains the file it kept as well as the one it would remove", async () => {
		const now = Date.UTC(2026, 9, 2, 12);
		const { service } = setup(now, [
			{ path: "Inbox/expired.md", mtime: now - 5 * 24 * 3_600_000 },
			{ path: "Inbox/fresh.md", mtime: now - 3_600_000 },
		]);

		const outcome = await service.run("dry-run");
		if (outcome.status !== "dry-run") throw new Error("expected a dry run");

		expect(outcome.plan.decisions.map((decision) => decision.file.path)).toEqual([
			"Inbox/fresh.md",
		]);
		expect(outcome.plan.decisions[0]?.outcome).toBe("not-expired");
		expect(outcome.plan.decisions[0]?.reason).toContain("expires in");
	});
});

describe("explain", () => {
	function service(vault: FakeVault, settings: AutoRemoveSettings, now: number) {
		const clock = new ManualClock(now);
		const logger = new RecordingLogger(true);
		const openFiles = new FakeOpenFiles();
		const scanner = new ExpirationScanner(vault, clock.now);
		const pending = new PendingActions({
			scanner,
			actions: vault,
			openFiles,
			watcher: new FakeWatcher(),
			createResolver: () => ({ resolver: buildPolicyResolver(settings).resolver }),
			logger,
		});
		return new CleanupService({
			scanner,
			executor: new ActionExecutor(vault, openFiles, pending, logger),
			openFiles,
			logger,
			createResolver: () => buildPolicyResolver(settings),
			preview: async (items) => items,
			promptPolicy: new ForcePromptPolicy(),
		});
	}

	const now = Date.UTC(2026, 9, 2, 12);

	it("answers why a file that opts in is being ignored when the default move is unusable", async () => {
		// The exact confusion the audit found: `auto-remove: true` plus a `move` with
		// no destination used to be silently inert.
		const vault = new FakeVault([
			{
				path: "Inbox/note.md",
				mtime: now - 9 * 24 * 3_600_000,
				frontmatter: { "auto-remove": true },
			},
		]);
		const cleanup = service(
			vault,
			{ ...DEFAULT_SETTINGS, defaultAction: "move", defaultMoveDestination: "" },
			now,
		);

		const decision = cleanup.explain("Inbox/note.md");

		expect(decision.outcome).toBe("unclaimed");
		expect(decision.reason).toContain("No `auto-remove` property");
	});

	it("reports an expired opted-in note as eligible", () => {
		const vault = new FakeVault([
			{
				path: "Inbox/note.md",
				mtime: now - 9 * 24 * 3_600_000,
				frontmatter: { "auto-remove": true },
			},
		]);
		const decision = service(vault, DEFAULT_SETTINGS, now).explain("Inbox/note.md");

		expect(decision.outcome).toBe("expire");
		expect(decision.reason).toContain("Note properties");
	});

	it("reports a protected note as exempt rather than unclaimed", () => {
		const vault = new FakeVault([
			{
				path: "Inbox/note.md",
				mtime: now - 9 * 24 * 3_600_000,
				frontmatter: { "auto-remove": false },
			},
		]);
		const decision = service(vault, DEFAULT_SETTINGS, now).explain("Inbox/note.md");

		// The distinction `PolicyResolver.resolve` deliberately collapses.
		expect(decision.outcome).toBe("exempt");
	});

	it("reports a file that does not exist", () => {
		const decision = service(new FakeVault(), DEFAULT_SETTINGS, now).explain("gone.md");
		expect(decision.reason).toBe("No such file in the vault.");
	});
});

describe("OncePerPlanPromptPolicy", () => {
	it("always allows the first prompt", () => {
		const policy: PromptPolicy = new OncePerPlanPromptPolicy();
		const plan = {
			removals: [
				{
					item: {
						file: { path: "a.md", extension: "md", mtime: 0, frontmatter: null },
						policy: {
							ttlDays: 1,
							action: { kind: "trash" as const },
							origin: { source: "frontmatter" as const },
						},
						expiredAt: 1,
						ageMs: 1,
					},
					action: { kind: "trash" as const },
					ruleId: null,
					ruleLabel: "Note properties",
					reason: "",
					open: false,
				},
			],
			decisions: [],
		};

		expect(policy.shouldPrompt(plan)).toBe(true);
		policy.settled(plan);
		expect(policy.shouldPrompt(plan)).toBe(false);
	});
});
