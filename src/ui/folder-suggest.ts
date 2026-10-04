import type { App } from "obsidian";
import { AbstractInputSuggest, TFolder } from "obsidian";

/** More than this and the list stops being a shortcut. */
const MAX_SUGGESTIONS = 20;

/**
 * Type-ahead for the folder fields in settings.
 *
 * Folder paths are the one setting where a typo silently does nothing — a rule
 * on a misspelled folder simply never matches — so it is worth letting people
 * pick from what actually exists rather than typing from memory.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private readonly input: HTMLInputElement,
		private readonly handleSelect: (path: string) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): TFolder[] {
		const needle = query.toLowerCase();
		const matches: TFolder[] = [];

		for (const file of this.app.vault.getAllLoadedFiles()) {
			if (!(file instanceof TFolder)) continue;
			if (!file.path.toLowerCase().includes(needle)) continue;

			matches.push(file);
			if (matches.length >= MAX_SUGGESTIONS) break;
		}

		return matches;
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		// The root folder's path is "/", which reads better spelled out.
		el.setText(folder.isRoot() ? "Vault root" : folder.path);
	}

	/**
	 * Writes the choice back to the field explicitly rather than relying on the
	 * base class, so the settings store and the visible text can never disagree.
	 */
	override selectSuggestion(folder: TFolder): void {
		const path = folder.isRoot() ? "" : folder.path;
		this.input.value = path;
		this.handleSelect(path);
		this.close();
	}
}
