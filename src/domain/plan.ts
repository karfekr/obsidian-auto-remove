import { MARKDOWN_EXTENSION, MILLISECONDS_PER_DAY } from "./types";
import type { ExpirationPolicy, ExpiredFile, FileSnapshot, RemovalAction } from "./types";

/**
 * The intermediate representation between "look at the vault" and "change the
 * vault".
 *
 * Reconciliation is deliberately staged:
 *
 * ```text
 * discover → evaluate → plan → execute
 * ```
 *
 * Evaluating produces a {@link FileDecision} for every file any rule had an
 * opinion about, including the ones that were left alone and *why*. Planning
 * turns the eligible subset into {@link PlannedRemoval}s. Executing is the only
 * step that touches the filesystem.
 *
 * The reason this matters is that three different needs want the same answer:
 * the preview dialog wants to know what will happen, a dry run wants to report
 * it without doing it, and a user asking "why wasn't my file removed?" wants the
 * decision for a file that is *not* being removed. All three read the plan, so
 * they cannot disagree, and none of them re-implement rule evaluation.
 */

/** How a file fared. `expire` is the only one that leads to a filesystem change. */
export type DecisionOutcome =
  /** A rule claimed it and its TTL has elapsed. */
  | "expire"
  /** Something explicitly protected it. */
  | "exempt"
  /** A rule claimed it, but its TTL has not elapsed yet. */
  | "not-expired"
  /**
   * No rule has an opinion.
   *
   * Recorded only for a single explicitly requested file — see
   * `ExpirationScanner.explain` — because on a full scan this is nearly every
   * file in the vault and carries no information.
   */
  | "unclaimed";

export interface FileDecision {
  readonly file: FileSnapshot;
  readonly outcome: DecisionOutcome;
  /** One sentence, plain English, safe to log. */
  readonly reason: string;
  /** `null` only when `outcome` is `unclaimed`. */
  readonly policy: ExpirationPolicy | null;
  /** When the TTL elapses. `null` when no policy applies. */
  readonly expiresAt: number | null;
  readonly ageMs: number;
}

/** One file that will be acted on, with everything needed to explain it. */
export interface PlannedRemoval {
  /** The existing shape the preview tree and the executor already speak. */
  readonly item: ExpiredFile;
  readonly action: RemovalAction;
  /** The claiming rule, or `null` for a note that opted in through frontmatter. */
  readonly ruleId: string | null;
  /** Where the claim came from, e.g. `Rule: Inbox` or `Note properties`. */
  readonly ruleLabel: string;
  readonly reason: string;
  /** Open in an editor right now, so it will be deferred rather than acted on. */
  readonly open: boolean;
}

export interface ActionPlan {
  readonly removals: readonly PlannedRemoval[];
  /**
   * Decisions that led to no action, for diagnostics.
   *
   * Deliberately excludes unclaimed files: see {@link DecisionOutcome}.
   */
  readonly decisions: readonly FileDecision[];
}

export interface PlanSummary {
  readonly total: number;
  readonly trash: number;
  readonly move: number;
  readonly deferred: number;
}

/**
 * Splits evaluated decisions into what will happen and what will not.
 *
 * Pure, and the only place a removal is assembled — so the preview, the dry run
 * and the executor cannot each build one slightly differently.
 */
export function buildPlan(
  decisions: readonly FileDecision[],
  openPaths: ReadonlySet<string>,
): ActionPlan {
  const removals: PlannedRemoval[] = [];
  const untouched: FileDecision[] = [];

  for (const decision of decisions) {
    if (decision.outcome !== "expire" || decision.policy === null) {
      untouched.push(decision);
      continue;
    }

    removals.push({
      item: toExpiredFile(decision),
      action: decision.policy.action,
      ruleId:
        decision.policy.origin.source === "folder-rule" ? decision.policy.origin.ruleId : null,
      ruleLabel: labelFor(decision.policy.origin),
      reason: decision.reason,
      open: openPaths.has(decision.file.path),
    });
  }

  return { removals, decisions: untouched };
}

/** Counts for a notice or a log line. */
export function summarizePlan(plan: ActionPlan): PlanSummary {
  return {
    total: plan.removals.length,
    trash: plan.removals.filter((removal) => removal.action.kind === "trash").length,
    move: plan.removals.filter((removal) => removal.action.kind === "move").length,
    deferred: plan.removals.filter((removal) => removal.open).length,
  };
}

/**
 * A stable fingerprint of what a plan would do.
 *
 * Used to avoid asking the user about the same unchanged set of files on every
 * reconciliation. It is a fingerprint, not a cache: if the set changes in any
 * way the signature changes and the user is asked again.
 */
export function planSignature(plan: ActionPlan): string {
  return plan.removals
    .map((removal) => removal.item.file.path)
    .slice()
    .sort()
    .join("\n");
}

/** Rebuilds the shape the preview tree and the executor already consume. */
export function toExpiredFile(decision: FileDecision): ExpiredFile {
  const policy = decision.policy;
  if (policy === null || decision.expiresAt === null) {
    throw new Error(`Auto Remove: "${decision.file.path}" is not an expired decision.`);
  }
  return {
    file: decision.file,
    policy,
    expiredAt: decision.expiresAt,
    ageMs: decision.ageMs,
  };
}

function labelFor(origin: ExpirationPolicy["origin"]): string {
  if (origin.source === "frontmatter") return "Note properties";
  return origin.folder.length === 0 ? "Whole-vault rule" : `Rule: ${origin.folder}`;
}

/** Whole days elapsed, which is the unit the rules are written in. */
export function wholeDays(ms: number): number {
  return Math.floor(ms / MILLISECONDS_PER_DAY);
}

export function describeExpiry(
  _file: FileSnapshot,
  policy: ExpirationPolicy,
  ageMs: number,
): string {
  const age = wholeDays(ageMs);
  const ageText = age < 1 ? "less than a day" : `${age} day${age === 1 ? "" : "s"}`;
  const ttlText = `${policy.ttlDays} day${policy.ttlDays === 1 ? "" : "s"}`;
  const where = labelFor(policy.origin);

  const how =
    policy.action.kind === "trash"
      ? "will be sent to the trash"
      : `will be moved to ${policy.action.destination}`;

  return `Last modified ${ageText} ago, past its ${ttlText} time to live under ${where}; ${how}.`;
}

export function describePending(
  _file: FileSnapshot,
  policy: ExpirationPolicy,
  expiresInMs: number,
): string {
  const remaining = wholeDays(expiresInMs);
  const when = remaining < 1 ? "less than a day" : `${remaining} day${remaining === 1 ? "" : "s"}`;
  return `Under ${labelFor(policy.origin)} with a ${policy.ttlDays} day time to live; expires in ${when}.`;
}

export function describeExempt(_file: FileSnapshot): string {
  return "Explicitly protected by `auto-remove: false`, or excluded by an ignore pattern.";
}

export function describeUnclaimed(file: FileSnapshot): string {
  return file.extension === MARKDOWN_EXTENSION
    ? "No `auto-remove` property, and no enabled folder rule covers it."
    : "No enabled folder rule covers it, and attachments are not included by default.";
}
