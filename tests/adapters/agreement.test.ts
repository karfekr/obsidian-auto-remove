import { describe, expect, it } from "vitest";
import { VaultFileActions } from "../../src/adapters/vault-file-actions";
import { RecordingLogger } from "../support/loggers";
import { installObsidianMock } from "../support/obsidian-mock";
import { FakeVault } from "../support/test-doubles";

/**
 * The test double must behave like the thing it stands in for.
 *
 * The audit's sharpest testing finding: `FakeVault.move` did not strip frontmatter
 * while `VaultFileActions.move` did, so `cleanup.test.ts` asserted on behaviour the
 * plugin did not have. Every service test using the fake was therefore capable of
 * passing while the production path was broken.
 *
 * Rather than trusting the fake to stay honest, this runs the *same* scenarios
 * through both implementations and requires them to agree. A change to one that is
 * not mirrored in the other now fails here instead of hiding.
 */

interface Outcome {
	readonly kind: "trash" | "move";
	readonly from: string;
	readonly to: string | null;
	readonly failed: boolean;
	readonly frontmatterAfter: Record<string, unknown> | null;
	readonly warnings: number;
}

interface Scenario {
	readonly name: string;
	readonly files: Array<{
		path: string;
		frontmatter?: Record<string, unknown> | null;
		malformed?: boolean;
	}>;
	readonly kind: "trash" | "move";
	readonly destination?: string;
	readonly target?: string;
	readonly failOn?: (path: string) => boolean;
}

/** The scenarios both implementations must agree on. */
const SCENARIOS: readonly Scenario[] = [
	{
		name: "trashes a plain note",
		files: [{ path: "Inbox/note.md" }],
		kind: "trash",
		target: "Inbox/note.md",
	},
	{
		name: "trashes a note carrying the managed properties",
		files: [{ path: "Inbox/note.md", frontmatter: { "auto-remove": true, ttl: 3 } }],
		kind: "trash",
		target: "Inbox/note.md",
	},
	{
		name: "moves a plain note",
		files: [{ path: "Inbox/note.md" }],
		kind: "move",
		destination: "Archive",
		target: "Inbox/note.md",
	},
	{
		name: "moves a note and strips the managed properties",
		files: [{ path: "Inbox/note.md", frontmatter: { "auto-remove": true, ttl: 3, tags: ["x"] } }],
		kind: "move",
		destination: "Archive",
		target: "Inbox/note.md",
	},
	{
		name: "moves a note and leaves unrelated properties alone",
		files: [{ path: "Inbox/note.md", frontmatter: { tags: ["x"], status: "draft" } }],
		kind: "move",
		destination: "Archive",
		target: "Inbox/note.md",
	},
	{
		name: "moves an attachment without touching its properties",
		files: [{ path: "Inbox/scan.pdf", frontmatter: { "auto-remove": true } }],
		kind: "move",
		destination: "Archive",
		target: "Inbox/scan.pdf",
	},
	{
		name: "avoids overwriting on a name collision",
		files: [{ path: "Inbox/note.md", frontmatter: { ttl: 3 } }, { path: "Archive/note.md" }],
		kind: "move",
		destination: "Archive",
		target: "Inbox/note.md",
	},
	{
		name: "creates the destination folder",
		files: [{ path: "Inbox/note.md", frontmatter: { ttl: 3 } }],
		kind: "move",
		destination: "Archive/2026",
		target: "Inbox/note.md",
	},
	{
		name: "fails when the source has gone",
		files: [],
		kind: "move",
		destination: "Archive",
		target: "Inbox/note.md",
	},
	{
		name: "fails when the destination is not writable",
		files: [{ path: "Inbox/note.md" }],
		kind: "trash",
		target: "Inbox/note.md",
		failOn: () => true,
	},
];

async function throughRealAdapter(scenario: Scenario): Promise<Outcome> {
	const app = installObsidianMock({
		files: scenario.files.map((file) => ({
			path: file.path,
			mtime: 0,
			...(file.frontmatter === undefined ? {} : { frontmatter: file.frontmatter }),
			...(file.malformed === true ? { malformedFrontmatter: true } : {}),
		})),
	});
	const actions = new VaultFileActions(app as never, new RecordingLogger(false));
	const target = scenario.target as string;

	if (scenario.failOn !== undefined)
		app.fileManager.failNext(scenario.kind === "trash" ? "trashFile" : "renameFile");

	try {
		const result =
			scenario.kind === "trash"
				? await actions.trash(target)
				: await actions.move(target, scenario.destination as string);

		const moved = result.moved;
		const at = moved ? result.path : target;
		const file = app.vault.getFileByPath(at);
		const cache = file === null ? null : app.metadataCache.getFileCache(file);

		return {
			kind: scenario.kind,
			from: target,
			to: moved ? result.path : null,
			failed: !moved,
			frontmatterAfter: cache?.frontmatter ?? null,
			warnings: result.warnings.length,
		};
	} catch {
		return {
			kind: scenario.kind,
			from: target,
			to: null,
			failed: true,
			frontmatterAfter: null,
			warnings: 0,
		};
	}
}

async function throughFake(scenario: Scenario): Promise<Outcome> {
	const vault = new FakeVault(
		scenario.files.map((file) => ({
			path: file.path,
			mtime: 0,
			...(file.frontmatter === undefined ? {} : { frontmatter: file.frontmatter }),
		})),
	);
	if (scenario.failOn !== undefined) vault.failOn = scenario.failOn;
	const target = scenario.target as string;

	try {
		const result =
			scenario.kind === "trash"
				? await vault.trash(target)
				: await vault.move(target, scenario.destination as string);

		return {
			kind: scenario.kind,
			from: target,
			to: result.moved ? result.path : null,
			failed: !result.moved,
			frontmatterAfter: vault.frontmatterOf(result.moved ? result.path : target),
			warnings: result.warnings.length,
		};
	} catch {
		return {
			kind: scenario.kind,
			from: target,
			to: null,
			failed: true,
			frontmatterAfter: null,
			warnings: 0,
		};
	}
}

describe("FakeVault agrees with VaultFileActions", () => {
	it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
		"%s",
		async (_name, scenario) => {
			const real = await throughRealAdapter(scenario);
			const fake = await throughFake(scenario);

			expect(fake).toEqual(real);
		},
	);

	describe("the specific divergences the audit found", () => {
		it("both strip the managed properties on a move", async () => {
			const scenario = SCENARIOS[3] as Scenario;
			// `{ tags: ["x"] }` is right: only the two properties Auto Remove owns go.
			expect((await throughFake(scenario)).frontmatterAfter).toEqual({ tags: ["x"] });
			expect((await throughRealAdapter(scenario)).frontmatterAfter).toEqual({ tags: ["x"] });
		});

		it("both agree that a moved note with nothing of ours is untouched", async () => {
			const scenario: Scenario = {
				name: "moves a note with unrelated frontmatter only",
				files: [{ path: "Inbox/note.md", frontmatter: { tags: ["x"] } }],
				kind: "move",
				destination: "Archive",
				target: "Inbox/note.md",
			};

			expect((await throughFake(scenario)).frontmatterAfter).toEqual({ tags: ["x"] });
			expect((await throughRealAdapter(scenario)).frontmatterAfter).toEqual({ tags: ["x"] });
		});
	});
});
