import { Notice } from "obsidian";
import type { CleanupOutcome } from "../services/cleanup-service";
import { pluralize } from "./format";

/**
 * Tells the user what a cleanup run did.
 *
 * Automatic runs stay quiet when there was nothing to do — a notice on every
 * vault event would be unusable — and equally quiet when the same set of files has
 * already been offered and dismissed. A run the user asked for always answers,
 * because silence there reads as a broken command.
 */
export function reportOutcome(outcome: CleanupOutcome, wasRequested: boolean): void {
	const message = describeOutcome(outcome, wasRequested);
	if (message !== null) new Notice(message);
}

function describeOutcome(outcome: CleanupOutcome, wasRequested: boolean): string | null {
	switch (outcome.status) {
		case "nothing-expired":
			return wasRequested ? "Auto Remove: nothing has expired." : null;

		case "cancelled":
			return wasRequested ? "Auto Remove: cancelled." : null;

		case "already-running":
			return wasRequested ? "Auto Remove: a cleanup is already in progress." : null;

		// The reconciler repeats the run itself when this happens, so an automatic run
		// needs no explanation; a manual one does, or the command looks broken.
		case "skipped":
			return wasRequested ? `Auto Remove: ${outcome.reason}` : null;

		case "dry-run":
			return null;

		case "completed":
			return describeResult(outcome);
	}
}

function describeResult(outcome: Extract<CleanupOutcome, { status: "completed" }>): string {
	const { removed, deferred, warnings, failed } = outcome.result;
	const parts = [`Auto Remove: ${pluralize(removed.length, "file")} removed`];

	if (deferred.length > 0) {
		parts.push(`${deferred.length} waiting to be closed`);
	}
	if (warnings.length > 0) {
		// Distinct from failures on purpose: these files *were* removed. Saying
		// "failure" here was one of the ways a completed move got reported as a loss.
		parts.push(`${warnings.length} needing attention`);
	}
	if (failed.length > 0) {
		parts.push(`${pluralize(failed.length, "failure")} — see the console`);
	}

	return parts.join(", ");
}
