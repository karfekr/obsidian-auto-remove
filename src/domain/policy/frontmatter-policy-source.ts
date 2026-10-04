import { parseTtlDays } from "../expiration";
import type { FileSnapshot, RemovalAction } from "../types";
import { MARKDOWN_EXTENSION } from "../types";
import type { PolicySource, PolicyVerdict } from "./policy-source";
import { ABSTAIN, EXEMPT, expire } from "./policy-source";

/** The frontmatter key a note uses to opt in or out. */
export const OPT_IN_PROPERTY = "auto-remove";
/** The frontmatter key holding a per-note TTL, in days. */
export const TTL_PROPERTY = "ttl";

/** Frontmatter properties Auto Remove owns, stripped from a file after a move. */
export const MANAGED_PROPERTIES: readonly string[] = [OPT_IN_PROPERTY, TTL_PROPERTY];

export interface FrontmatterPolicyDefaults {
	/** TTL for notes that opt in without naming one. */
	readonly ttlDays: number;
	/** Action for every frontmatter-opted note; folder rules never apply to them. */
	readonly action: RemovalAction;
}

/**
 * Reads a note's own instructions.
 *
 * ```yaml
 * ---
 * auto-remove: true
 * ttl: 3
 * ---
 * ```
 *
 * An opt-in is a deliberate instruction from the note's author, so it takes
 * precedence over every folder rule — including that folder's ignore patterns,
 * which are only ever consulted while matching a folder rule.
 *
 * `auto-remove: false` is the mirror image: an explicit refusal that no folder
 * rule may override. It is the only way to exempt one note from a rule covering
 * its folder, so treating it as merely "no opinion" would leave users with no
 * way to say what they plainly meant.
 *
 * A `ttl` on its own is inert. The note has not opted in, so the value is
 * ignored — but the note is also not opted *out*, and a folder rule may still
 * claim it on its own terms, with the folder's TTL rather than the note's.
 */
export class FrontmatterPolicySource implements PolicySource {
	readonly id = "frontmatter";

	constructor(private readonly defaults: FrontmatterPolicyDefaults) {}

	resolve(file: FileSnapshot): PolicyVerdict {
		// Only Markdown files carry frontmatter, and the adapter that reads it says
		// so too. Repeating the check here keeps the domain honest on its own terms:
		// a snapshot claiming frontmatter on a `.png` is not trusted to act on it.
		if (file.extension !== MARKDOWN_EXTENSION) return ABSTAIN;

		const frontmatter = file.frontmatter;
		if (frontmatter === null) return ABSTAIN;

		const optIn = readOptIn(frontmatter[OPT_IN_PROPERTY]);
		if (optIn === null) return ABSTAIN;
		if (optIn === false) return EXEMPT;

		return expire({
			ttlDays: parseTtlDays(frontmatter[TTL_PROPERTY]) ?? this.defaults.ttlDays,
			action: this.defaults.action,
			origin: { source: "frontmatter" },
		});
	}
}

const TRUTHY = new Set(["true", "yes", "on"]);
const FALSY = new Set(["false", "no", "off"]);

/**
 * Reads the opt-in property as a deliberate yes, a deliberate no, or nothing.
 *
 * Obsidian's property editor stores a real boolean, but hand-written YAML and
 * imported notes routinely carry `"true"` or `yes`. Accepting those costs
 * nothing and avoids notes that look opted in but silently are not. A value
 * that means neither — a typo, a stray string — is treated as no statement at
 * all rather than guessed at in either direction.
 */
export function readOptIn(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return null;

	const normalized = value.trim().toLowerCase();
	if (TRUTHY.has(normalized)) return true;
	if (FALSY.has(normalized)) return false;
	return null;
}
