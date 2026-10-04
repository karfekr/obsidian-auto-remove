import type { ExpiredFile } from "./types";
import { joinPath, segments } from "./vault-path";

/**
 * Builds the folder hierarchy shown in the preview dialog.
 *
 * A tree communicates *where* files live in a way a flat list cannot, which
 * matters when the dialog is asking permission to delete things. The structure
 * is built here, free of any DOM, so the shape can be tested directly and the
 * renderer stays a plain translation of it.
 */

export interface FileNode {
	readonly kind: "file";
	readonly name: string;
	readonly path: string;
	readonly item: ExpiredFile;
}

export interface FolderNode {
	readonly kind: "folder";
	readonly name: string;
	readonly path: string;
	readonly children: TreeNode[];
}

export type TreeNode = FolderNode | FileNode;

/**
 * Groups expired files into a tree rooted at the vault.
 *
 * Folders sort before files and both sort alphabetically, so the same set of
 * files always renders identically — a dialog that reshuffles between runs is
 * one users stop reading.
 */
export function buildTree(items: readonly ExpiredFile[]): FolderNode {
	const root = createFolder("", "");

	for (const item of items) {
		const parts = segments(item.file.path);
		const fileName = parts.pop();
		if (fileName === undefined) continue;

		let current = root;
		for (const part of parts) {
			current = findOrCreateFolder(current, part);
		}
		current.children.push({
			kind: "file",
			name: fileName,
			path: item.file.path,
			item,
		});
	}

	sortRecursively(root);
	return root;
}

/**
 * Collapses runs of single-child folders into one row, the way `tree -F` and
 * file explorers do, so `a/b/c/note.md` reads as `a/b/c` rather than three
 * nested rows that carry no information.
 *
 * The root is never collapsed: it stands for the vault itself and is not a row
 * anyone sees, so folding it into its only child would drop a level.
 */
export function collapseSingleChildFolders(root: FolderNode): FolderNode {
	return {
		kind: "folder",
		name: root.name,
		path: root.path,
		children: root.children.map(collapseNode),
	};
}

function collapseNode(node: TreeNode): TreeNode {
	if (node.kind === "file") return node;

	const children = node.children.map(collapseNode);
	const onlyChild = children.length === 1 ? children[0] : undefined;

	if (onlyChild !== undefined && onlyChild.kind === "folder") {
		return {
			kind: "folder",
			name: joinPath(node.name, onlyChild.name),
			path: onlyChild.path,
			children: onlyChild.children,
		};
	}

	return { kind: "folder", name: node.name, path: node.path, children };
}

/** Every file path beneath a node, used to cascade checkbox selection. */
export function collectFilePaths(node: TreeNode, into: string[] = []): string[] {
	if (node.kind === "file") {
		into.push(node.path);
		return into;
	}
	for (const child of node.children) collectFilePaths(child, into);
	return into;
}

function createFolder(name: string, path: string): FolderNode {
	return { kind: "folder", name, path, children: [] };
}

function findOrCreateFolder(parent: FolderNode, name: string): FolderNode {
	const existing = parent.children.find(
		(child): child is FolderNode => child.kind === "folder" && child.name === name,
	);
	if (existing !== undefined) return existing;

	const created = createFolder(name, joinPath(parent.path, name));
	parent.children.push(created);
	return created;
}

function sortRecursively(node: FolderNode): void {
	node.children.sort(compareNodes);
	for (const child of node.children) {
		if (child.kind === "folder") sortRecursively(child);
	}
}

function compareNodes(a: TreeNode, b: TreeNode): number {
	if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}
