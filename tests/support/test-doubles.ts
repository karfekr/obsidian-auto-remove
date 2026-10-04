import { MANAGED_PROPERTIES } from "../../src/domain/policy/frontmatter-policy-source";
import { MARKDOWN_EXTENSION } from "../../src/domain/types";
import type { FileSnapshot } from "../../src/domain/types";
import { basename, parentFolder, splitExtension } from "../../src/domain/vault-path";
import type {
  FileActions,
  FileRepository,
  FileWatcher,
  MoveResult,
  OpenFileTracker,
  Scheduler,
} from "../../src/services/ports";

/**
 * In-memory stand-ins for the vault, used by the service tests.
 *
 * They are behavioural rather than mocks: the vault double really moves files and
 * really renames on collision, so a test failure means the logic is wrong rather
 * than an expectation being out of date.
 *
 * The important property is that they agree with production. `move` in particular
 * reproduces the semantics of `adapters/vault-file-actions.ts` — create the
 * destination folder, avoid overwriting, and strip the managed properties from a
 * Markdown file — because the previous version of this file did none of that and
 * produced tests that passed while the real adapter was broken. The two are now
 * held together by `adapters/agreement.test.ts`, which runs the same scenarios
 * through both.
 */

export interface FakeFile {
  path: string;
  mtime: number;
  frontmatter?: Record<string, unknown> | null;
}

export class FakeVault implements FileRepository, FileActions {
  readonly trashed: string[] = [];
  readonly moved: Array<{ from: string; to: string }> = [];
  failOn: ((path: string) => boolean) | null = null;
  /** When set, `move` behaves as if the frontmatter rewrite threw. */
  failFrontmatterOn: ((path: string) => boolean) | null = null;

  private files = new Map<string, FileSnapshot>();
  private folders = new Set<string>([""]);

  constructor(files: FakeFile[] = []) {
    for (const file of files) this.add(file);
  }

  add(file: FakeFile): void {
    const { suffix } = splitExtension(file.path);
    const extension = suffix.replace(/^\./, "");
    this.files.set(file.path, {
      path: file.path,
      extension,
      mtime: file.mtime,
      // Only Markdown files can carry frontmatter. `VaultFileRepository` reports
      // `null` for everything else, and the fake has to agree: an attachment that
      // appeared to have opted in would be claimed by a rule that cannot see it.
      frontmatter: extension === MARKDOWN_EXTENSION ? (file.frontmatter ?? null) : null,
    });
    this.folders.add(parentFolder(file.path));
  }

  touch(path: string, mtime: number): void {
    const existing = this.files.get(path);
    if (existing === undefined) throw new Error(`No such file: ${path}`);
    this.files.set(path, { ...existing, mtime });
  }

  /** Replaces a file's frontmatter, as an edit would. */
  setFrontmatter(path: string, frontmatter: Record<string, unknown> | null): void {
    const existing = this.files.get(path);
    if (existing === undefined) throw new Error(`No such file: ${path}`);
    this.files.set(path, { ...existing, frontmatter });
  }

  frontmatterOf(path: string): Record<string, unknown> | null {
    return this.files.get(path)?.frontmatter ?? null;
  }

  listFiles(): FileSnapshot[] {
    return [...this.files.values()];
  }

  getFile(path: string): FileSnapshot | null {
    return this.files.get(path) ?? null;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  async trash(path: string): Promise<MoveResult> {
    this.assertUsable(path);
    this.files.delete(path);
    this.trashed.push(path);
    return { path, moved: true, warnings: [] };
  }

  /**
   * Mirrors `VaultFileActions.move`.
   *
   * The properties are stripped here too. When the fake did not do this, a test
   * asserting on the fake was asserting on behaviour the plugin does not have.
   */
  async move(path: string, destination: string): Promise<MoveResult> {
    const existing = this.assertUsable(path);
    this.folders.add(destination);
    const target = this.availablePath(destination, basename(path));

    this.files.delete(path);
    this.files.set(target, {
      ...existing,
      path: target,
      frontmatter: this.stripManagedProperties(target, existing.frontmatter),
    });
    this.moved.push({ from: path, to: target });

    return { path: target, moved: true, warnings: [] };
  }

  /** Whether a folder exists, as `Vault.getFolderByPath` would report. */
  hasFolder(path: string): boolean {
    return this.folders.has(path);
  }

  private stripManagedProperties(
    path: string,
    frontmatter: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const { suffix } = splitExtension(path);
    if (suffix.replace(/^\./, "") !== MARKDOWN_EXTENSION) return frontmatter;
    if (frontmatter === null) return null;
    if (this.failFrontmatterOn?.(path) === true) {
      // Production treats this as a warning on a successful move, not a failure.
      return frontmatter;
    }
    const next = { ...frontmatter };
    for (const property of MANAGED_PROPERTIES) delete next[property];
    return next;
  }

  private availablePath(destination: string, name: string): string {
    const { stem, suffix } = splitExtension(name);
    let candidate = `${destination}/${name}`.replace(/^\//, "");

    for (let index = 1; this.files.has(candidate); index += 1) {
      candidate = `${destination}/${stem} ${index}${suffix}`.replace(/^\//, "");
    }
    return candidate;
  }

  private assertUsable(path: string): FileSnapshot {
    if (this.failOn?.(path) === true) throw new Error(`Simulated failure for ${path}`);
    const existing = this.files.get(path);
    if (existing === undefined) throw new Error(`No such file: ${path}`);
    return existing;
  }
}

export class FakeOpenFiles implements OpenFileTracker {
  private open = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(initiallyOpen: string[] = []) {
    this.open = new Set(initiallyOpen);
  }

  getOpenPaths(): ReadonlySet<string> {
    return new Set(this.open);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Simulates the user closing a tab, notifying subscribers as Obsidian would. */
  async close(path: string): Promise<void> {
    this.open.delete(path);
    await this.notify();
  }

  async open_(path: string): Promise<void> {
    this.open.add(path);
    await this.notify();
  }

  private async notify(): Promise<void> {
    for (const listener of this.listeners) listener();
    // Listeners kick off async work; yield so it settles before assertions.
    await Promise.resolve();
    await Promise.resolve();
  }
}

export class FakeWatcher implements FileWatcher {
  private readonly renameListeners = new Set<(from: string, to: string) => void>();
  private readonly deleteListeners = new Set<(path: string) => void>();

  onRenamed(listener: (from: string, to: string) => void): () => void {
    this.renameListeners.add(listener);
    return () => this.renameListeners.delete(listener);
  }

  onDeleted(listener: (path: string) => void): () => void {
    this.deleteListeners.add(listener);
    return () => this.deleteListeners.delete(listener);
  }

  emitRename(from: string, to: string): void {
    for (const listener of this.renameListeners) listener(from, to);
  }

  emitDelete(path: string): void {
    for (const listener of this.deleteListeners) listener(path);
  }
}

/**
 * A {@link Scheduler} a test drives by hand.
 *
 * Timeouts are recorded, never real: nothing here waits, so the debounce window
 * and the interval can be exercised exactly, at no cost, without fake timers
 * installed globally or a single millisecond of real sleeping.
 */
export class ManualScheduler implements Scheduler {
  private sequence = 0;
  private readonly timers = new Map<
    number,
    { dueAt: number; every: number | null; fn: () => void; cancelled: boolean }
  >();

  /** Virtual time, advanced by {@link advance} and by {@link fireInterval}. */
  now = 0;

  every(ms: number, fn: () => void): () => void {
    return this.add(ms, fn, true);
  }

  after(ms: number, fn: () => void): () => void {
    return this.add(ms, fn, false);
  }

  /** How many timers are armed. Zero after a full teardown. */
  get armedCount(): number {
    let count = 0;
    for (const timer of this.timers.values()) if (!timer.cancelled) count += 1;
    return count;
  }

  /** Moves virtual time forward, firing anything due. */
  advance(ms: number): void {
    this.now += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => !timer.cancelled && timer.dueAt <= this.now)
      .sort((a, b) => a[1].dueAt - b[1].dueAt);

    for (const [id, timer] of due) {
      if (timer.every === null) this.timers.delete(id);
      else timer.dueAt = this.now + timer.every;
      timer.fn();
    }
  }

  /**
   * Fires every armed interval once, without moving time.
   *
   * Stands in for the wall clock reaching the interval, and keeps the test free of
   * any dependency on how long the interval happens to be.
   */
  fireIntervals(): void {
    for (const timer of [...this.timers.values()]) {
      if (timer.cancelled || timer.every === null) continue;
      timer.dueAt = this.now + timer.every;
      timer.fn();
    }
  }

  private add(ms: number, fn: () => void, repeat: boolean): () => void {
    const id = (this.sequence += 1);
    this.timers.set(id, {
      dueAt: this.now + ms,
      every: repeat ? ms : null,
      fn,
      cancelled: false,
    });
    return () => {
      const timer = this.timers.get(id);
      if (timer !== undefined) timer.cancelled = true;
      this.timers.delete(id);
    };
  }
}
