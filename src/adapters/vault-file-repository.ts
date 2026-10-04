import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { FileSnapshot } from "../domain/types";
import type { FileRepository } from "../services/ports";

/** Only Markdown files can carry the frontmatter Auto Remove reads. */
const MARKDOWN_EXTENSION = "md";

/**
 * Reads the vault through Obsidian's caches.
 *
 * `Vault.getFiles()` is an in-memory list and `MetadataCache` already holds
 * parsed frontmatter, so a full scan touches the disk zero times. That is what
 * keeps a startup scan of a large vault imperceptible, and it is the reason
 * nothing here reads file contents directly.
 */
export class VaultFileRepository implements FileRepository {
	constructor(private readonly app: App) {}

	listFiles(): FileSnapshot[] {
		return this.app.vault.getFiles().map((file) => this.toSnapshot(file));
	}

	getFile(path: string): FileSnapshot | null {
		const file = this.app.vault.getFileByPath(path);
		return file === null ? null : this.toSnapshot(file);
	}

	private toSnapshot(file: TFile): FileSnapshot {
		return {
			path: file.path,
			extension: file.extension.toLowerCase(),
			mtime: file.stat.mtime,
			frontmatter: this.readFrontmatter(file),
		};
	}

	/**
	 * `null` distinguishes "cannot have frontmatter" from "has none", which is
	 * what lets the frontmatter policy skip attachments without inspecting
	 * extensions itself.
	 */
	private readFrontmatter(file: TFile): Readonly<Record<string, unknown>> | null {
		if (file.extension.toLowerCase() !== MARKDOWN_EXTENSION) return null;
		return this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
	}
}

/** Narrows an abstract file to a `TFile`, or explains why it cannot be acted on. */
export function requireFile(app: App, path: string): TFile {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		throw new Error(`Auto Remove: no file at "${path}".`);
	}
	return file;
}
