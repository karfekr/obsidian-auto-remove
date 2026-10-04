import type { PolicyOrigin } from "../domain/types";
import { MILLISECONDS_PER_DAY } from "../domain/types";

/**
 * Wording shared by the preview dialog and the notices.
 *
 * Kept free of the Obsidian API so the phrasing can be checked directly, and
 * gathered in one place so "3 days" never reads as "3 day" in one view and
 * "3 days ago" in another.
 */

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** How long ago a file was last touched, e.g. "12 days ago" or "today". */
export function formatAge(ageMs: number): string {
	const days = Math.floor(ageMs / MILLISECONDS_PER_DAY);
	if (days < 1) return "today";
	return relativeTime.format(-days, "day");
}

/** A TTL as a phrase, e.g. "1 day" or "immediately". */
export function formatTtl(days: number): string {
	if (days === 0) return "immediately";
	return days === 1 ? "1 day" : `${days} days`;
}

/** Where a file's policy came from, for the provenance column. */
export function describeOrigin(origin: PolicyOrigin): string {
	if (origin.source === "frontmatter") return "Frontmatter";
	return origin.folder.length === 0 ? "Vault rule" : `Rule: ${origin.folder}`;
}

/** Pluralises a count, e.g. `2, 'file'` → "2 files". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}
