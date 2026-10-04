import ignore from "ignore";

/**
 * Gitignore-style path matching.
 *
 * This is the only module aware of the `ignore` package. Everything else
 * depends on the {@link IgnoreMatcher} interface, so the implementation can be
 * swapped without touching the rules that use it.
 *
 * Patterns follow the .gitignore specification, including `**` globs and `!`
 * negation, and are matched against paths relative to the folder that owns
 * them — mirroring how a `.gitignore` behaves in the directory it lives in.
 */
export interface IgnoreMatcher {
	/** Whether the given folder-relative path is excluded. */
	ignores(relativePath: string): boolean;
}

/** A matcher that excludes nothing, used when a rule has no patterns. */
const MATCH_NOTHING: IgnoreMatcher = { ignores: () => false };

export function createIgnoreMatcher(patterns: readonly string[]): IgnoreMatcher {
	const usable = patterns.map((pattern) => pattern.trim()).filter(isMeaningfulPattern);
	if (usable.length === 0) return MATCH_NOTHING;

	const instance = ignore().add(usable);
	return {
		ignores(relativePath) {
			// `ignore` rejects absolute paths and the empty string outright, and a
			// malformed user pattern should never take a cleanup run down with it.
			if (relativePath.length === 0 || relativePath.startsWith("/")) return false;
			return instance.ignores(relativePath);
		},
	};
}

/**
 * Whether a line contributes a rule. Blank lines and `#` comments are inert in
 * gitignore syntax, and users naturally write both in a multi-line text box.
 */
export function isMeaningfulPattern(pattern: string): boolean {
	const trimmed = pattern.trim();
	return trimmed.length > 0 && !trimmed.startsWith("#");
}

/**
 * Reports why a pattern cannot be used, or `null` when it is fine.
 * Used by the settings UI to give feedback before a rule is ever applied.
 *
 * A leading `/` is valid and anchors the pattern to the rule's folder, exactly
 * as it would in a `.gitignore`; only genuinely unparseable patterns fail.
 */
export function validateIgnorePattern(pattern: string): string | null {
	if (!isMeaningfulPattern(pattern)) return null;
	try {
		ignore().add(pattern.trim());
		return null;
	} catch {
		return "This is not a valid ignore pattern.";
	}
}
