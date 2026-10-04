import type { Workspace } from "obsidian";
import type { CleanupTrigger } from "./trigger";

/**
 * Requests one reconciliation once the workspace has finished loading.
 *
 * `onLayoutReady` matters for more than politeness: until layout is ready the
 * workspace cannot say which files are open, and a run before then would happily
 * offer to remove the note the user is looking at. It also *catches up* — a file
 * that expired while Obsidian was closed is found here, not at the next interval,
 * so a week-long absence is noticed on the first launch rather than five minutes
 * later.
 *
 * `onLayoutReady` returns nothing, so the callback cannot be detached and this
 * trigger does not pretend otherwise. Two things make that safe:
 *
 * - it is **one-shot**. `onLayoutReady` invokes its callback immediately when the
 *   layout is already ready, which is the case whenever the plugin is enabled from
 *   settings. Firing more than once would launch an unprompted cleanup as a side
 *   effect of reloading the plugin, so `fired` latches and `stop()` disarms it.
 * - the captured closure holds only `fired`, `cancelled` and `run`. Whatever
 *   `run` closes over is released when the plugin unloads; the workspace keeps a
 *   few bytes, not the service graph.
 */
export class StartupTrigger implements CleanupTrigger {
  readonly id = "startup";

  private fired = false;
  private cancelled = false;

  constructor(
    private readonly workspace: Workspace,
    private readonly run: () => void,
  ) {}

  start(): () => void {
    this.workspace.onLayoutReady(() => {
      if (this.fired || this.cancelled) return;
      this.fired = true;
      this.run();
    });

    return () => {
      this.cancelled = true;
    };
  }
}
