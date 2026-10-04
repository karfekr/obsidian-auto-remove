import { beforeEach, describe, expect, it } from "vitest";
import { VaultFileActions } from "../../src/adapters/vault-file-actions";
import { RecordingLogger } from "../support/loggers";
import type { FakeApp } from "../support/obsidian-mock";
import { installObsidianMock } from "../support/obsidian-mock";

/**
 * The production delete and move path.
 *
 * Every assertion here is about the Obsidian API call that was actually made — the
 * method, the vault-relative path, the order — because that is what the audit
 * found entirely untested. A unit test of `executeAction` proves the right
 * function was chosen; only this proves the right API was called with it.
 */
describe("VaultFileActions", () => {
	let app: FakeApp;
	let actions: VaultFileActions;
	let logger: RecordingLogger;

	function setup(options: Parameters<typeof installObsidianMock>[0]): void {
		app = installObsidianMock(options);
		logger = new RecordingLogger(true);
		actions = new VaultFileActions(app as never, logger);
	}

	beforeEach(() => {
		setup({});
	});

	describe("trash", () => {
		it("calls FileManager.trashFile with the vault-relative path", async () => {
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });

			const result = await actions.trash("Inbox/note.md");

			expect(app.fileManager.calls).toContainEqual({
				method: "trashFile",
				args: ["Inbox/note.md"],
			});
			expect(result).toEqual({ path: "Inbox/note.md", moved: true, warnings: [] });
		});

		it("removes the file from the vault", async () => {
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });

			await actions.trash("Inbox/note.md");

			expect(app.vault.getFileByPath("Inbox/note.md")).toBeNull();
		});

		it("leaves the choice of trash destination to Obsidian", async () => {
			// Auto Remove has no opinion here: `trashFile` already honours the user's
			// "Deleted files" preference, so the plugin never implements deletion itself.
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });

			await actions.trash("Inbox/note.md");

			// Nothing but `trashFile` was involved: no vault.delete, no adapter write.
			expect(app.vault.calls.filter((call) => call.method === "delete")).toHaveLength(0);
		});

		it("throws rather than reporting success when the file is gone", async () => {
			setup({ files: [] });

			await expect(actions.trash("Inbox/note.md")).rejects.toThrow(/no file at/i);
		});

		it("propagates a failure from Obsidian", async () => {
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });
			app.fileManager.failNext("trashFile", new Error("disk is read-only"));

			await expect(actions.trash("Inbox/note.md")).rejects.toThrow("disk is read-only");
		});
	});

	describe("move", () => {
		it("calls renameFile with the computed destination", async () => {
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });

			const result = await actions.move("Inbox/note.md", "Archive");

			expect(app.fileManager.calls).toContainEqual({
				method: "renameFile",
				args: ["Inbox/note.md", "Archive/note.md"],
			});
			expect(result.path).toBe("Archive/note.md");
			expect(result.moved).toBe(true);
		});

		it("creates the destination folder when it does not exist", async () => {
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });

			await actions.move("Inbox/note.md", "Archive/2026");

			expect(app.vault.calls).toContainEqual({ method: "createFolder", args: ["Archive/2026"] });
			expect(app.vault.getFolderByPath("Archive/2026")).not.toBeNull();
		});

		it("does not try to create a destination that already exists", async () => {
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }], folders: ["Archive"] });

			await actions.move("Inbox/note.md", "Archive");

			expect(app.vault.calls.filter((call) => call.method === "createFolder")).toHaveLength(0);
		});

		it("treats a createFolder race as success, not as a failure", async () => {
			// `createFolder` throws when the folder exists. Two files filed into the same
			// place in one run produces exactly that, and it is not an error.
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });
			app.vault.failNext("createFolder", new Error("Folder already exists: Archive"));
			// The folder exists by the time the throw is re-checked.
			app.vault.addFile({ path: "Archive/placeholder.md", mtime: 0 });

			const result = await actions.move("Inbox/note.md", "Archive");

			expect(result.moved).toBe(true);
		});

		describe("name collisions", () => {
			it("never overwrites an existing file", async () => {
				setup({
					files: [
						{ path: "Inbox/note.md", mtime: 0 },
						{ path: "Archive/note.md", mtime: 0 },
					],
				});

				const result = await actions.move("Inbox/note.md", "Archive");

				expect(result.path).toBe("Archive/note 1.md");
			});

			it("keeps counting until it finds a free name", async () => {
				setup({
					files: [
						{ path: "Inbox/note.md", mtime: 0 },
						{ path: "Archive/note.md", mtime: 0 },
						{ path: "Archive/note 1.md", mtime: 0 },
						{ path: "Archive/note 2.md", mtime: 0 },
					],
				});

				const result = await actions.move("Inbox/note.md", "Archive");

				expect(result.path).toBe("Archive/note 3.md");
			});

			it("preserves the extension", async () => {
				setup({
					files: [
						{ path: "Inbox/scan.pdf", mtime: 0 },
						{ path: "Archive/scan.pdf", mtime: 0 },
					],
				});

				expect((await actions.move("Inbox/scan.pdf", "Archive")).path).toBe("Archive/scan 1.pdf");
			});

			it("handles a name with no extension", async () => {
				setup({
					files: [
						{ path: "Inbox/README", mtime: 0 },
						{ path: "Archive/README", mtime: 0 },
					],
				});

				expect((await actions.move("Inbox/README", "Archive")).path).toBe("Archive/README 1");
			});

			it("gives up rather than searching forever", async () => {
				// The search has no natural exit other than "this name is free", so it
				// needs a ceiling. A destination inside a hidden folder is what used to
				// make `getAbstractFileByPath` answer "free" indefinitely.
				setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });
				const real = app.vault.getAbstractFileByPath;
				app.vault.getAbstractFileByPath = (path: string) =>
					path === "Inbox/note.md" ? real(path) : ({} as never);

				await expect(actions.move("Inbox/note.md", "Archive")).rejects.toThrow(/no free name/i);
			});
		});

		describe("releasing the file from Auto Remove", () => {
			it("strips the managed properties from a Markdown file", async () => {
				setup({
					files: [
						{
							path: "Inbox/note.md",
							mtime: 0,
							frontmatter: { "auto-remove": true, ttl: 3, tags: ["keep"] },
						},
					],
				});

				await actions.move("Inbox/note.md", "Archive");

				const cache = app.metadataCache.getFileCache(
					app.vault.getFileByPath("Archive/note.md") as never,
				);
				expect(cache?.frontmatter).toEqual({ tags: ["keep"] });
			});

			it("does not touch a non-Markdown file", async () => {
				setup({
					files: [
						{
							path: "Inbox/scan.pdf",
							mtime: 0,
							frontmatter: { "auto-remove": true, ttl: 3 },
						},
					],
				});

				await actions.move("Inbox/scan.pdf", "Archive");

				expect(
					app.fileManager.calls.filter((call) => call.method === "processFrontMatter"),
				).toHaveLength(0);
			});

			it("leaves a note with no frontmatter of ours completely alone", async () => {
				// `processFrontMatter` *adds* a frontmatter block to a file that has none,
				// so calling it unconditionally would leave `---\n---` behind in an
				// ordinary note — an edit of content the user never asked us to touch.
				setup({ files: [{ path: "Inbox/plain.md", mtime: 0, frontmatter: null }] });

				await actions.move("Inbox/plain.md", "Archive");

				expect(
					app.fileManager.calls.filter((call) => call.method === "processFrontMatter"),
				).toHaveLength(0);
			});

			it("leaves a note whose frontmatter has none of our properties alone", async () => {
				setup({
					files: [{ path: "Inbox/note.md", mtime: 0, frontmatter: { tags: ["keep"] } }],
				});

				await actions.move("Inbox/note.md", "Archive");

				expect(
					app.fileManager.calls.filter((call) => call.method === "processFrontMatter"),
				).toHaveLength(0);
				const cache = app.metadataCache.getFileCache(
					app.vault.getFileByPath("Archive/note.md") as never,
				);
				expect(cache?.frontmatter).toEqual({ tags: ["keep"] });
			});
		});

		describe("when the properties cannot be rewritten", () => {
			// The audit's clearest bug. `renameFile` and `processFrontMatter` shared one
			// promise, so a note that moved correctly — because its YAML was malformed —
			// was reported to the user as a failed move.
			it("reports a warning rather than a failure", async () => {
				setup({
					files: [
						{
							path: "Inbox/note.md",
							mtime: 0,
							frontmatter: { "auto-remove": true, ttl: 3 },
							malformedFrontmatter: true,
						},
					],
				});

				const result = await actions.move("Inbox/note.md", "Archive");

				expect(result.moved).toBe(true);
				expect(result.path).toBe("Archive/note.md");
				expect(result.warnings).toHaveLength(1);
				expect(result.warnings[0]).toMatch(/properties could not be removed/i);
			});

			it("still moved the file", async () => {
				setup({
					files: [
						{
							path: "Inbox/note.md",
							mtime: 0,
							frontmatter: { "auto-remove": true, ttl: 3 },
							malformedFrontmatter: true,
						},
					],
				});

				await actions.move("Inbox/note.md", "Archive");

				expect(app.vault.getFileByPath("Archive/note.md")).not.toBeNull();
				expect(app.vault.getFileByPath("Inbox/note.md")).toBeNull();
			});

			it("names the underlying cause in the warning", async () => {
				setup({
					files: [
						{
							path: "Inbox/note.md",
							mtime: 0,
							frontmatter: { "auto-remove": true, ttl: 3 },
							malformedFrontmatter: true,
						},
					],
				});

				const result = await actions.move("Inbox/note.md", "Archive");

				expect(result.warnings[0]).toContain("Malformed YAML");
			});
		});

		it("throws, and moves nothing, when the source has gone", async () => {
			setup({ files: [] });

			await expect(actions.move("Inbox/note.md", "Archive")).rejects.toThrow(/no file at/i);
			expect(app.fileManager.calls).toHaveLength(0);
		});

		it("propagates a failure from renameFile", async () => {
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });
			app.fileManager.failNext("renameFile", new Error("cross-device link"));

			await expect(actions.move("Inbox/note.md", "Archive")).rejects.toThrow("cross-device link");
		});

		it("logs the folder it created", async () => {
			setup({ files: [{ path: "Inbox/note.md", mtime: 0 }] });

			await actions.move("Inbox/note.md", "Archive");

			expect(logger.messagesMatching("Created the destination folder")).toHaveLength(1);
		});
	});
});
