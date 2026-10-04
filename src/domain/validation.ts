import { MAX_TTL_DAYS } from "./types";
import { normalizeFolder, segments } from "./vault-path";
import type { AutoRemoveSettings, FolderRule } from "./types";

/**
 * Why a rule cannot be carried out.
 *
 * This module is the single authority on "is this configuration usable?". It is
 * consulted in two places that must agree:
 *
 * 1. `policy/resolver-factory.ts`, which refuses to build a binding for an
 *    invalid rule so that it claims nothing rather than claiming files it would
 *    then fail on — or, worse, reinterpret.
 * 2. `ui/folder-rule-editor.ts`, which renders the message so the user can see
 *    why the rule is inert.
 *
 * Keeping one implementation is the point. When the check lived only in the
 * settings UI, a rule that the UI described as dangerous was still fully live.
 */

/** A stable identifier for a kind of misconfiguration, for logs and tests. */
export type ProblemCode =
  | "move-without-destination"
  | "destination-inside-rule-folder"
  | "destination-unsafe"
  | "ttl-out-of-range";

export interface RuleProblem {
  readonly code: ProblemCode;
  /** User-facing. Sentence case, no trailing period conventions to memorise. */
  readonly message: string;
}

/** A problem, plus which piece of configuration it belongs to. */
export interface ConfigurationProblem extends RuleProblem {
  /** `default-action`, or `rule:<id>` for a specific folder rule. */
  readonly target: string;
}

/**
 * The outcome of checking one folder rule, or `null` when it is usable.
 *
 * `enabled` is deliberately not consulted. A paused rule with no move
 * destination is still misconfigured, and its settings card is still on screen —
 * reporting it means the user sees the problem before re-enabling it, rather
 * than after.
 */
export function validateFolderRule(rule: FolderRule): RuleProblem | null {
  if (rule.action !== "move") {
    return ttlProblem(rule) ?? null;
  }

  const destination = normalizeFolder(rule.moveDestination);

  if (destination.length === 0) {
    return {
      code: "move-without-destination",
      message: "Choose a destination folder, or switch this rule to Trash.",
    };
  }

  if (!isSafeDestination(destination)) {
    return {
      code: "destination-unsafe",
      message:
        "The destination folder is not usable. Choose a normal folder in the vault; hidden and relative folders cannot be destinations.",
    };
  }

  if (wouldMoveIntoItself(rule)) {
    return {
      code: "destination-inside-rule-folder",
      message: "The destination folder is inside the rule folder, so files would expire again.",
    };
  }

  return ttlProblem(rule) ?? null;
}

/**
 * The outcome of checking the settings-level default action, or `null` when it
 * is usable.
 *
 * This is the case the audit called out as indefensible: `defaultAction: "move"`
 * with no destination used to resolve to *no policy at all*, so notes carrying
 * `auto-remove: true` were quietly ignored with no indication of why. It is now
 * an explicit configuration error, surfaced in settings and in diagnostics.
 */
export function validateDefaultAction(settings: AutoRemoveSettings): RuleProblem | null {
  if (settings.defaultAction !== "move") return null;

  const destination = normalizeFolder(settings.defaultMoveDestination);
  if (destination.length === 0) {
    return {
      code: "move-without-destination",
      message: "Set a destination folder, or switch the default action back to Trash.",
    };
  }

  if (!isSafeDestination(destination)) {
    return {
      code: "destination-unsafe",
      message: "The default destination folder is not usable.",
    };
  }

  return null;
}

/** Every configuration problem in force, in the order the settings page shows them. */
export function validateSettings(settings: AutoRemoveSettings): readonly ConfigurationProblem[] {
  const problems: ConfigurationProblem[] = [];

  const defaultProblem = validateDefaultAction(settings);
  if (defaultProblem !== null) problems.push({ ...defaultProblem, target: "default-action" });

  for (const rule of settings.folderRules) {
    const problem = validateFolderRule(rule);
    if (problem !== null) problems.push({ ...problem, target: `rule:${rule.id}` });
  }

  return problems;
}

/** A single line naming every unusable configuration, for logs and notices. */
export function describeProblems(problems: readonly ConfigurationProblem[]): string {
  return problems.map((problem) => `${problem.target}: ${problem.message}`).join("; ");
}

/**
 * A destination must be an ordinary folder inside the vault.
 *
 * Two things are rejected, both for the same reason: Obsidian's Vault API does
 * not resolve paths inside hidden (dot-prefixed) folders, so a destination of
 * `.trash` would both defeat the collision check and move user files somewhere
 * the plugin cannot then see them. `..` is rejected for the ordinary reason.
 */
function isSafeDestination(destination: string): boolean {
  return segments(destination).every((segment) => {
    if (segment === "." || segment === "..") return false;
    return !segment.startsWith(".");
  });
}

/**
 * A destination nested inside the rule's own folder would re-expire everything
 * it receives.
 *
 * Markdown files escape, because their `auto-remove`/`ttl` properties are
 * stripped after the move. Attachments claimed by a `scope: "all"` rule do not,
 * so they would be renamed again on every subsequent run — `photo 1.png` to
 * `photo 2.png` and onwards, indefinitely.
 */
function wouldMoveIntoItself(rule: FolderRule): boolean {
  const folder = normalizeFolder(rule.folder);
  const destination = normalizeFolder(rule.moveDestination);
  if (destination.length === 0) return false;
  // Any destination under a whole-vault rule is inside it.
  if (folder.length === 0) return true;
  return destination === folder || destination.startsWith(`${folder}/`);
}

function ttlProblem(rule: FolderRule): RuleProblem | null {
  if (isUsableTtl(rule.ttlDays)) return null;
  return {
    code: "ttl-out-of-range",
    message: `The time to live must be a whole number of days between 0 and ${MAX_TTL_DAYS}.`,
  };
}

function isUsableTtl(ttlDays: number): boolean {
  return Number.isInteger(ttlDays) && ttlDays >= 0 && ttlDays <= MAX_TTL_DAYS;
}
