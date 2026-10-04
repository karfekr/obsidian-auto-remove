import { describe, expect, it } from "vitest";
import { requireFile, VaultFileRepository } from "../../src/adapters/vault-file-repository";
import { installObsidianMock } from "../support/obsidian-mock";

/**
 * Reading the vault.
 *
 * This is where a file's modification time and frontmatter come from, so a mistake
 * here changes every decision the plugin makes. It also does the one thing that
 * makes a full scan affordable: it reads `getFiles()` and `MetadataCache` and never
 * touches the disk.
 */
describe("VaultFileRepository", () => {
	describe("listFiles", () => {
		it("reads every file with its path, extension and modification time", () => {
			const app = installObsidianMock({
				files: [
					{ path: "Inbox/note.md", mtime: 1234 },
					{ path: "Inbox/scan.PDF", mtime: 5678 },
				],
			});
			const repository = new VaultFileRepository(app as never);

			// `getFiles()` returns whatever order the vault holds, so compare as a set.
			expect([...repository.listFiles()].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
				{ path: "Inbox/note.md", extension: "md", mtime: 1234, frontmatter: null },
				{ path: "Inbox/scan.PDF", extension: "pdf", mtime: 5678, frontmatter: null },
			]);
		});

		it("lower-cases the extension so `MD` and `md` cannot disagree", () => {
			const app = installObsidianMock({ files: [{ path: "Note.MD", mtime: 0 }] });
			expect(new VaultFileRepository(app as never).listFiles()[0]?.extension).toBe("md");
		});

		it("reports an extensionless file with an empty extension", () => {
			const app = installObsidianMock({ files: [{ path: "README", mtime: 0 }] });
			expect(new VaultFileRepository(app as never).listFiles()[0]?.extension).toBe("");
		});

		it("reads frontmatter for Markdown files", () => {
			const app = installObsidianMock({
				files: [{ path: "note.md", mtime: 0, frontmatter: { "auto-remove": true, ttl: 3 } }],
			});

			expect(new VaultFileRepository(app as never).listFiles()[0]?.frontmatter).toEqual({
				"auto-remove": true,
				ttl: 3,
			});
		});

		it("reports null for a file with no frontmatter", () => {
			const app = installObsidianMock({
				files: [{ path: "note.md", mtime: 0, frontmatter: null }],
			});
			expect(new VaultFileRepository(app as never).listFiles()[0]?.frontmatter).toBeNull();
		});

		it("does not ask the metadata cache about a non-Markdown file", () => {
			const app = installObsidianMock({ files: [{ path: "scan.pdf", mtime: 0 }] });

			const files = new VaultFileRepository(app as never).listFiles();

			// An attachment cannot carry frontmatter, so looking would be a wasted lookup
			// and a chance to believe something untrue.
			expect(files[0]?.frontmatter).toBeNull();
			expect(app.metadataCache.calls).toHaveLength(0);
		});

		it("does no disk reads at all", () => {
			const app = installObsidianMock({
				files: [
					{ path: "a.md", mtime: 0 },
					{ path: "b.md", mtime: 0 },
				],
			});

			new VaultFileRepository(app as never).listFiles();

			const reads = app.vault.calls.filter(
				(call) => call.method === "read" || call.method === "cachedRead",
			);
			expect(reads).toHaveLength(0);
		});

		it("propagates a failure from the vault rather than returning a short list", () => {
			// A silently truncated scan would look exactly like "nothing has expired".
			const app = installObsidianMock({ files: [{ path: "a.md", mtime: 0 }] });
			app.vault.failNext("getFiles", new Error("vault is loading"));

			expect(() => new VaultFileRepository(app as never).listFiles()).toThrow("vault is loading");
		});
	});

	describe("getFile", () => {
		it("re-reads one file", () => {
			const app = installObsidianMock({ files: [{ path: "Inbox/note.md", mtime: 99 }] });
			expect(new VaultFileRepository(app as never).getFile("Inbox/note.md")?.mtime).toBe(99);
		});

		it("returns null for a file that is not there", () => {
			const app = installObsidianMock({ files: [] });
			expect(new VaultFileRepository(app as never).getFile("gone.md")).toBeNull();
		});

		it("returns null for a file inside a hidden folder", () => {
			// Obsidian does not expose these through the Vault API, so the plugin must
			// not pretend otherwise.
			const app = installObsidianMock({
				files: [{ path: ".obsidian/plugins/x/data.json", mtime: 0 }],
			});
			expect(
				new VaultFileRepository(app as never).getFile(".obsidian/plugins/x/data.json"),
			).toBeNull();
		});
	});
});

describe("requireFile", () => {
	it("returns the file when it is there", () => {
		const app = installObsidianMock({ files: [{ path: "note.md", mtime: 0 }] });
		expect(requireFile(app as never, "note.md").path).toBe("note.md");
	});

	it("names the path it could not find", () => {
		const app = installObsidianMock({ files: [] });
		expect(() => requireFile(app as never, "Inbox/missing.md")).toThrow(/Inbox\/missing\.md/);
	});

	it("refuses a folder, which cannot be trashed or renamed as a file", () => {
		const app = installObsidianMock({ files: [{ path: "Inbox/note.md", mtime: 0 }] });
		expect(() => requireFile(app as never, "Inbox")).toThrow(/no file at/i);
	});
});
