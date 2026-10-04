import type { IgnoreMatcher } from "../ignore-matcher";
import { createIgnoreMatcher } from "../ignore-matcher";
import type { FileSnapshot, FolderRule, RemovalAction } from "../types";
import { MARKDOWN_EXTENSION } from "../types";
import { depth, isInsideFolder, relativeToFolder } from "../vault-path";
import type { PolicySource, PolicyVerdict } from "./policy-source";
import { ABSTAIN, EXEMPT, expire } from "./policy-source";

/**
 * A rule paired with the action it resolved to.
 *
 * Resolution happens before construction so that a rule whose action cannot be
 * carried out — a move with no destination — is simply never handed over,
 * rather than being represented here as an impossible state.
 */
export interface FolderRuleBinding {
	readonly rule: FolderRule;
	readonly action: RemovalAction;
}

/** A binding with its ignore patterns compiled once, ready to match. */
interface CompiledRule extends FolderRuleBinding {
	readonly matcher: IgnoreMatcher;
}

/**
 * Claims files that sit under a configured folder rule.
 *
 * When rules nest, the deepest one wins: a rule on `Inbox/drafts` overrides one
 * on `Inbox`, which is what "most specific configuration wins" means everywhere
 * else a user meets nested settings.
 *
 * Ignore patterns belong to the rule that owns them and are matched against the
 * path relative to that rule's folder, exactly as a `.gitignore` behaves in the
 * directory it lives in. Being ignored by the winning rule exempts the file
 * rather than falling through to a shallower rule — otherwise an outer rule
 * would quietly reclaim everything an inner rule had just excluded.
 *
 * A rule's `scope` narrows it in the same way `enabled` does: a file the rule is
 * not configured to cover is simply not its business, so evaluation continues
 * and a shallower rule may still claim it. `md` — the default — covers only
 * Markdown files. `all` opts attachments in, which is safe only because
 * `domain/validation.ts` refuses a destination that the rule itself covers.
 */
export class FolderRulePolicySource implements PolicySource {
	readonly id = "folder-rule";

	private readonly rules: readonly CompiledRule[];

	constructor(bindings: readonly FolderRuleBinding[]) {
		// Sorting once, at construction, makes `resolve` a simple first-match scan.
		this.rules = bindings
			.filter((binding) => binding.rule.enabled)
			.map((binding) => ({ ...binding, matcher: createIgnoreMatcher(binding.rule.ignorePatterns) }))
			.sort((a, b) => depth(b.rule.folder) - depth(a.rule.folder));
	}

	resolve(file: FileSnapshot): PolicyVerdict {
		for (const compiled of this.rules) {
			if (!isInsideFolder(file.path, compiled.rule.folder)) continue;
			if (!covers(compiled.rule, file)) continue;

			const relativePath = relativeToFolder(file.path, compiled.rule.folder);
			if (relativePath === null || compiled.matcher.ignores(relativePath)) return EXEMPT;

			return expire({
				ttlDays: compiled.rule.ttlDays,
				action: compiled.action,
				origin: {
					source: "folder-rule",
					ruleId: compiled.rule.id,
					folder: compiled.rule.folder,
				},
			});
		}
		return ABSTAIN;
	}
}

/** Whether a rule's configured scope includes this kind of file. */
function covers(rule: { scope: FolderRule["scope"] }, file: FileSnapshot): boolean {
	return rule.scope === "all" || file.extension === MARKDOWN_EXTENSION;
}
