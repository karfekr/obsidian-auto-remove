/**
 * Helpers for vault-relative paths.
 *
 * Obsidian paths always use forward slashes, never start with a slash, and use
 * the empty string for the vault root. These helpers encode those conventions
 * in one place so callers never hand-roll string slicing.
 */

/**
 * Strips leading, trailing and duplicated slashes, and trims each segment.
 * `'/a// b /'` becomes `'a/b'`, and a blank path becomes the root.
 *
 * Trimming matters because these paths come from settings text boxes, where a
 * stray space would otherwise produce a folder that can never be found.
 */
export function normalizeFolder(path: string): string {
	return path
		.split("/")
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0)
		.join("/");
}

/** The vault root, expressed the way Obsidian expresses it. */
export const VAULT_ROOT = "";

/** Splits a path into its segments. The root yields an empty array. */
export function segments(path: string): string[] {
	return normalizeFolder(path)
		.split("/")
		.filter((segment) => segment.length > 0);
}

/** Number of path segments; used to rank folder rules by specificity. */
export function depth(folder: string): number {
	return segments(folder).length;
}

/** The final segment of a path, e.g. `'Inbox/note.md'` → `'note.md'`. */
export function basename(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

/** The containing folder of a path, or {@link VAULT_ROOT} for a top-level file. */
export function parentFolder(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? VAULT_ROOT : path.slice(0, index);
}

/** Joins path parts, skipping empty ones so the root joins cleanly. */
export function joinPath(...parts: string[]): string {
	return parts
		.map(normalizeFolder)
		.filter((part) => part.length > 0)
		.join("/");
}

/**
 * Whether `path` sits inside `folder`, at any depth.
 *
 * The vault root contains everything. A folder never contains itself, which
 * matters because rules apply to a folder's contents rather than to the folder.
 */
export function isInsideFolder(path: string, folder: string): boolean {
	const normalized = normalizeFolder(folder);
	if (normalized === VAULT_ROOT) return true;
	return path.startsWith(`${normalized}/`);
}

/**
 * Re-expresses `path` relative to `folder`, for matching against that folder's
 * ignore patterns. Returns `null` when the path is not inside the folder.
 */
export function relativeToFolder(path: string, folder: string): string | null {
	const normalized = normalizeFolder(folder);
	if (normalized === VAULT_ROOT) return path;
	if (!path.startsWith(`${normalized}/`)) return null;
	return path.slice(normalized.length + 1);
}

/** The extension of a file path in lower case, without the dot. */
export function extensionOf(path: string): string {
	const name = basename(path);
	const index = name.lastIndexOf(".");
	if (index <= 0) return "";
	return name.slice(index + 1).toLowerCase();
}

/** Splits a file name into its stem and its extension suffix (including the dot). */
export function splitExtension(name: string): { stem: string; suffix: string } {
	const index = name.lastIndexOf(".");
	if (index <= 0) return { stem: name, suffix: "" };
	return { stem: name.slice(0, index), suffix: name.slice(index) };
}
