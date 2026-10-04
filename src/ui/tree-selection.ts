import type { TreeNode } from "../domain/file-tree";
import { collectFilePaths } from "../domain/file-tree";

/** A folder is partially selected when only some of its descendants are. */
export type SelectionState = "checked" | "unchecked" | "partial";

/**
 * Tracks which files the user has left selected in the preview dialog.
 *
 * Folders are not stored: their state is derived from the files beneath them,
 * so a folder can never disagree with its own contents. That keeps the
 * tri-state checkbox honest without a second source of truth to synchronise.
 */
export class TreeSelection {
	private readonly selected: Set<string>;

	constructor(paths: Iterable<string>) {
		this.selected = new Set(paths);
	}

	/** Everything starts selected: the common case is "yes, all of it". */
	static selectAll(root: TreeNode): TreeSelection {
		return new TreeSelection(collectFilePaths(root));
	}

	get size(): number {
		return this.selected.size;
	}

	paths(): ReadonlySet<string> {
		return this.selected;
	}

	isSelected(path: string): boolean {
		return this.selected.has(path);
	}

	setFile(path: string, selected: boolean): void {
		if (selected) this.selected.add(path);
		else this.selected.delete(path);
	}

	/** Applies a folder's checkbox to every file beneath it. */
	setSubtree(node: TreeNode, selected: boolean): void {
		for (const path of collectFilePaths(node)) this.setFile(path, selected);
	}

	stateOf(node: TreeNode): SelectionState {
		if (node.kind === "file") return this.isSelected(node.path) ? "checked" : "unchecked";

		const paths = collectFilePaths(node);
		if (paths.length === 0) return "unchecked";

		const selectedCount = paths.filter((path) => this.selected.has(path)).length;
		if (selectedCount === 0) return "unchecked";
		return selectedCount === paths.length ? "checked" : "partial";
	}
}
