import { toRemovalAction } from "../removal-action";
import type { AutoRemoveSettings } from "../types";
import { validateDefaultAction, validateFolderRule } from "../validation";
import type { ConfigurationProblem } from "../validation";
import { FolderRulePolicySource } from "./folder-rule-policy-source";
import type { FolderRuleBinding } from "./folder-rule-policy-source";
import { FrontmatterPolicySource } from "./frontmatter-policy-source";
import { PolicyResolver } from "./policy-resolver";
import type { PolicySource } from "./policy-source";

/** A resolver, plus the configuration that could not be turned into one. */
export interface BuiltPolicy {
  readonly resolver: PolicyResolver;
  /**
   * Configuration that is currently inert.
   *
   * Reported rather than swallowed: a rule that claims nothing because it is
   * invalid is indistinguishable from a working plugin from the outside, which
   * is exactly how "the plugin does nothing" reports happen.
   */
  readonly problems: readonly ConfigurationProblem[];
}

/**
 * Composes the policy chain for one cleanup run.
 *
 * A resolver is built fresh from a settings snapshot each time, which compiles
 * the ignore patterns once and makes cache invalidation a non-problem: a run
 * always sees one consistent configuration, and edits take effect on the next.
 *
 * The array order below *is* the documented priority: frontmatter, then folder
 * rules. Teaching Auto Remove a new way to claim files means adding one entry.
 *
 * Every rule is validated first (`domain/validation.ts`). An invalid rule
 * contributes no source, so it claims nothing — it is never coerced into a
 * different action, and in particular a `move` with no destination is never
 * quietly turned into a delete.
 */
export function buildPolicyResolver(settings: AutoRemoveSettings): BuiltPolicy {
  const problems: ConfigurationProblem[] = [];
  const sources: PolicySource[] = [];

  const defaultProblem = validateDefaultAction(settings);
  if (defaultProblem === null) {
    const action = toRemovalAction(settings.defaultAction, settings.defaultMoveDestination);
    if (action !== null) {
      sources.push(new FrontmatterPolicySource({ ttlDays: settings.defaultTtlDays, action }));
    }
  } else {
    problems.push({ ...defaultProblem, target: "default-action" });
  }

  const bindings: FolderRuleBinding[] = [];
  for (const rule of settings.folderRules) {
    const problem = validateFolderRule(rule);
    if (problem !== null) {
      problems.push({ ...problem, target: `rule:${rule.id}` });
      continue;
    }

    const action = toRemovalAction(rule.action, rule.moveDestination);
    // Unreachable while `validateFolderRule` covers every case `toRemovalAction`
    // rejects; kept so a future action kind degrades to "claims nothing" rather
    // than to a binding carrying an impossible action.
    if (action === null) continue;
    bindings.push({ rule, action });
  }

  sources.push(new FolderRulePolicySource(bindings));

  return { resolver: new PolicyResolver(sources), problems };
}

/**
 * The resolver alone, for callers that do not surface configuration problems.
 *
 * Kept because it is the natural single-value entry point and it is what most
 * tests want; reconciliation uses {@link buildPolicyResolver} so it can report
 * what is inert.
 */
export function createPolicyResolver(settings: AutoRemoveSettings): PolicyResolver {
  return buildPolicyResolver(settings).resolver;
}
