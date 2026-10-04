import type { AutoRemoveSettings, FolderRule } from "../domain/types";

/**
 * The TTL applied to a note that opts in without naming one.
 * Specified as seven days; kept here so the number appears exactly once.
 */
export const DEFAULT_TTL_DAYS = 7;

/**
 * Bumped whenever the persisted shape changes.
 *
 * There is no migration to run: `parseSettings` reads the fields it understands
 * and ignores everything else, so an older `data.json` loads fine and a newer one
 * loses only the fields it cannot interpret. Version 2 replaced the removed
 * `triggers` setting with `debugLogging` and added a per-rule `scope`.
 */
export const CURRENT_SCHEMA_VERSION = 2;

export const DEFAULT_SETTINGS: AutoRemoveSettings = {
	schemaVersion: CURRENT_SCHEMA_VERSION,
	defaultTtlDays: DEFAULT_TTL_DAYS,
	defaultAction: "trash",
	defaultMoveDestination: "",
	folderRules: [],
	debugLogging: false,
};

/** A blank folder rule for the settings UI to hand to the user. */
export function createFolderRule(): FolderRule {
	return {
		id: createRuleId(),
		enabled: true,
		folder: "",
		ttlDays: DEFAULT_TTL_DAYS,
		action: "trash",
		moveDestination: "",
		// Markdown only. Opting attachments in is a deliberate choice, and the
		// default must not make it on the user's behalf.
		scope: "md",
		ignorePatterns: [],
	};
}

/**
 * A rule identity that survives reordering and editing.
 *
 * `crypto.randomUUID` is unavailable on insecure origins in some Obsidian
 * builds, so fall back to a timestamped random string rather than risk a throw
 * while the user is adding a rule.
 */
function createRuleId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
