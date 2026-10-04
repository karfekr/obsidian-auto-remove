import type { ExpiredFile } from "../domain/types";
import { executeAction } from "./pending-actions";
import type { PendingActions } from "./pending-actions";
import type {
  ActionFailure,
  ActionWarning,
  CleanupResult,
  FileActions,
  Logger,
  OpenFileTracker,
} from "./ports";

/**
 * Carries out a confirmed set of removals and reports what happened.
 *
 * Actions run one at a time. Vault mutations are cheap but not free, and a serial
 * loop keeps the failure story simple: one file failing never leaves the rest in
 * an indeterminate state, and the summary the user sees is accurate.
 *
 * Three outcomes are reported separately, because collapsing them is what made
 * the audit's worst bug invisible:
 *
 * - **removed** — the action completed;
 * - **warning** — the file reached its destination but something afterwards did
 *   not work (a malformed frontmatter, typically). Not retried: retrying would
 *   rename the file a second time;
 * - **failed** — the file did not move or was not trashed.
 */
export class ActionExecutor {
  constructor(
    private readonly actions: FileActions,
    private readonly openFiles: OpenFileTracker,
    private readonly pending: PendingActions,
    private readonly logger: Logger,
  ) {}

  async execute(items: readonly ExpiredFile[]): Promise<CleanupResult> {
    const removed: ExpiredFile[] = [];
    const deferred: ExpiredFile[] = [];
    const warnings: ActionWarning[] = [];
    const failed: ActionFailure[] = [];

    // Read the open set once: opening a tab midway through a run should not
    // change how the remaining files in that run are treated.
    const openPaths = this.openFiles.getOpenPaths();

    for (const item of items) {
      if (openPaths.has(item.file.path)) {
        this.pending.defer(item);
        deferred.push(item);
        this.logger.debug(`Deferred ${item.file.path}: open in an editor`, {
          path: item.file.path,
        });
        continue;
      }

      try {
        const result = await executeAction(this.actions, item);

        if (!result.moved) {
          failed.push({
            item,
            error: new Error(result.warnings[0] ?? "The action did not complete."),
          });
          this.logger.error(`Could not remove "${item.file.path}"`, { path: item.file.path });
          continue;
        }

        removed.push(item);

        // A move that succeeded with a caveat is still a move. Rolling it back
        // would be a second, riskier mutation, and re-running would move the file
        // again — so it is surfaced, not retried.
        for (const message of result.warnings) {
          warnings.push({ item, message });
          this.logger.warn(`Moved "${item.file.path}" but ${message}`, { path: item.file.path });
        }
      } catch (error) {
        // One bad file must not abandon the rest.
        failed.push({ item, error });
        this.logger.error(`Could not remove "${item.file.path}"`, {
          path: item.file.path,
          error: describeError(error),
        });
      }
    }

    return { removed, deferred, warnings, failed };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
