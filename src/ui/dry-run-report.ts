import { Notice } from "obsidian";
import { summarizePlan } from "../domain/plan";
import type { ActionPlan } from "../domain/plan";
import { pluralize } from "./format";

/**
 * Reports an {@link ActionPlan} without acting on it.
 *
 * Backs both the dry run and the single-file explanation, because they are the
 * same question — "what does Auto Remove think about these files?" — asked about
 * a whole vault or about one file. Reading the plan rather than re-evaluating is
 * what guarantees the dry run and the real run cannot disagree.
 *
 * The console detail is unconditional here, unlike the debug trail in
 * `services/cleanup-service.ts`. A dry run is something a person just asked for,
 * so the output is the point; leaving it behind a setting would make the command
 * useless in exactly the situation it exists for.
 */
export function reportPlan(plan: ActionPlan, wasRequested = false): void {
  const summary = summarizePlan(plan);

  if (plan.removals.length === 0) {
    reportUntouched(plan);
    return;
  }

  const parts = [
    `${pluralize(summary.total, "file")} eligible`,
    `${summary.trash} to trash`,
    `${summary.move} to move`,
  ];
  if (summary.deferred > 0) parts.push(`${summary.deferred} open and deferred`);

  const heading = wasRequested ? `Dry run: ${parts.join(", ")}.` : `${parts.join(", ")}.`;
  new Notice(`Auto Remove: ${heading}`);
  console.info(`Auto Remove: dry run — ${parts.join(", ")}.`, {
    paths: plan.removals.map((r) => r.item.file.path),
  });

  for (const removal of plan.removals) {
    console.info(`  ${removal.item.file.path} — ${removal.reason}`);
  }
}

/**
 * Nothing is eligible.
 *
 * The interesting case: files that were looked at and kept still deserve an
 * answer, because "nothing is eligible" is indistinguishable from "nothing was
 * examined" without one.
 */
function reportUntouched(plan: ActionPlan): void {
  if (plan.decisions.length === 0) {
    new Notice("Nothing is currently expired.");
    return;
  }

  const fileCount = plan.decisions.length;
  new Notice(
    `Auto Remove: nothing to remove. ${pluralize(fileCount, "file")} examined and kept. See the console.`,
  );
  console.info(`Auto Remove: nothing to remove; ${fileCount} file(s) examined and kept.`);

  for (const decision of plan.decisions) {
    console.info(`  ${decision.file.path} — ${decision.reason}`);
  }
}
