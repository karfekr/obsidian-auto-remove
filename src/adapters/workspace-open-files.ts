import { debounce } from "obsidian";
import type { App, EventRef, WorkspaceLeaf } from "obsidian";
import type { FileWatcher, OpenFileTracker } from "../services/ports";

/** Workspace churn is bursty; coalesce it before re-reading every leaf. */
const CHANGE_DEBOUNCE_MS = 200;

/**
 * Reports which files the user currently has open.
 *
 * The file is read from each leaf's *view state* rather than from `leaf.view`.
 * Since Obsidian 1.7.2 a background tab holds a `DeferredView` instead of the
 * real view, so `leaf.view.file` is absent for exactly the tabs that matter
 * most here — the ones sitting quietly in the background holding a file open.
 * View state is present either way, and reading it avoids calling
 * `loadIfDeferred()`, which would undo the optimisation Obsidian just made.
 *
 * `iterateAllLeaves` covers the main area, both sidebars and pop-out windows,
 * so a note open in a detached window is still protected.
 */
export class WorkspaceOpenFileTracker implements OpenFileTracker, FileWatcher {
  private readonly listeners = new Set<() => void>();
  private readonly eventRefs: EventRef[] = [];

  private readonly notify = debounce(
    () => {
      for (const listener of this.listeners) listener();
    },
    CHANGE_DEBOUNCE_MS,
    true,
  );

  constructor(private readonly app: App) {
    const { workspace } = app;
    this.eventRefs.push(
      workspace.on("layout-change", this.notify),
      workspace.on("active-leaf-change", this.notify),
    );
  }

  getOpenPaths(): ReadonlySet<string> {
    const paths = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const path = filePathOf(leaf);
      if (path !== null) paths.add(path);
    });
    return paths;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRenamed(listener: (fromPath: string, toPath: string) => void): () => void {
    return this.onVaultEvent(
      this.app.vault.on("rename", (file, oldPath) => listener(oldPath, file.path)),
    );
  }

  onDeleted(listener: (path: string) => void): () => void {
    return this.onVaultEvent(this.app.vault.on("delete", (file) => listener(file.path)));
  }

  /**
   * Releases every subscription this tracker took out, whoever asked for it.
   *
   * The tracker owns its subscriptions rather than relying on every caller to
   * release its own: a vault listener handed out and then leaked would keep the
   * whole service graph reachable after the plugin had unloaded. `onRenamed` and
   * `onDeleted` still return their own unsubscribe for a caller that wants to
   * detach early, and `dispose` releases whatever is left.
   */
  dispose(): void {
    this.notify.cancel();
    for (const ref of this.eventRefs) {
      this.app.workspace.offref(ref);
      this.app.vault.offref(ref);
    }
    this.eventRefs.length = 0;
    this.listeners.clear();
  }

  private onVaultEvent(ref: EventRef): () => void {
    this.eventRefs.push(ref);
    return () => {
      const index = this.eventRefs.indexOf(ref);
      if (index !== -1) this.eventRefs.splice(index, 1);
      this.app.vault.offref(ref);
    };
  }
}

/**
 * The vault path a leaf is showing, or `null` for leaves with no file — the
 * file explorer, search, graph view and so on.
 */
function filePathOf(leaf: WorkspaceLeaf): string | null {
  const file = leaf.getViewState().state?.["file"];
  return typeof file === "string" && file.length > 0 ? file : null;
}
