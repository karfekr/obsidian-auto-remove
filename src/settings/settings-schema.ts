import type { AutoRemoveSettings, FolderRule } from "../domain/types";
import { MAX_TTL_DAYS } from "../domain/types";
import { validateFolderRule } from "../domain/validation";
import { normalizeFolder } from "../domain/vault-path";
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS, DEFAULT_TTL_DAYS } from "./defaults";

/**
 * Turns whatever is in `data.json` into settings the rest of the plugin can
 * trust.
 *
 * The file is plain JSON on disk: users edit it, sync clients merge it, and an
 * older version of the plugin may have written it. Validating once here means no
 * downstream code has to defend against a `ttlDays` of `"soon"`, and a corrupt
 * field costs the user one default rather than a broken plugin.
 *
 * Note what this deliberately does *not* do: repair. A malformed TTL becomes the
 * documented default, because a typo there would otherwise delete files early. A
 * `move` with no destination is preserved exactly as written and reported by
 * `domain/validation.ts` — it is never turned into a different action.
 */
export function parseSettings(raw: unknown): AutoRemoveSettings {
	const source = isRecord(raw) ? raw : {};

	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		defaultTtlDays: parseTtl(source.defaultTtlDays, DEFAULT_TTL_DAYS),
		defaultAction: parseActionKind(source.defaultAction),
		defaultMoveDestination: parseFolderPath(source.defaultMoveDestination),
		folderRules: parseFolderRules(source.folderRules),
		debugLogging: source.debugLogging === true,
	};
}

/**
 * Human-readable reason a rule cannot run, or `null` when it is usable.
 *
 * A thin wrapper over the domain validator so the settings page and the resolver
 * can never disagree about which rules are live.
 */
export function describeRuleProblem(rule: FolderRule): string | null {
	return validateFolderRule(rule)?.message ?? null;
}

function parseFolderRules(raw: unknown): FolderRule[] {
	if (!Array.isArray(raw)) return [...DEFAULT_SETTINGS.folderRules];
	return raw.filter(isRecord).map(parseFolderRule);
}

function parseFolderRule(raw: Record<string, unknown>, index: number): FolderRule {
	return {
		id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `rule-${index}`,
		enabled: raw.enabled !== false,
		folder: parseFolderPath(raw.folder),
		ttlDays: parseTtl(raw.ttlDays, DEFAULT_TTL_DAYS),
		action: parseActionKind(raw.action),
		moveDestination: parseFolderPath(raw.moveDestination),
		scope: parseScope(raw.scope),
		ignorePatterns: parsePatterns(raw.ignorePatterns),
	};
}

/**
 * Anything other than an explicit `"all"` means Markdown only.
 *
 * The asymmetry is deliberate. A rule written by an older version, or by hand,
 * has no `scope` field at all, and the safe reading of "this rule does not say
 * what it covers" is "Markdown only".
 */
function parseScope(raw: unknown): FolderRule["scope"] {
	return raw === "all" ? "all" : "md";
}

/** Accepts patterns as an array or as the newline-separated text the UI edits. */
function parsePatterns(raw: unknown): string[] {
	if (typeof raw === "string") return splitPatternLines(raw);
	if (!Array.isArray(raw)) return [];
	return raw.filter((entry): entry is string => typeof entry === "string");
}

export function splitPatternLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function parseTtl(raw: unknown, fallback: number): number {
	const value = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isInteger(value)) return fallback;
	if (value < 0 || value > MAX_TTL_DAYS) return fallback;
	return value;
}

function parseActionKind(raw: unknown): AutoRemoveSettings["defaultAction"] {
	return raw === "move" ? "move" : "trash";
}

function parseFolderPath(raw: unknown): string {
	return typeof raw === "string" ? normalizeFolder(raw) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
