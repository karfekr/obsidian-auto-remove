/**
 * A hand-written stand-in for the parts of Obsidian's API that Auto Remove uses.
 *
 * The audit's most expensive gap was that no test ever reached
 * `src/adapters` or `src/main.ts`, so the real `trashFile` / `renameFile` /
 * `createFolder` calls — the entire production delete and move path — were
 * unverified while every unit test passed. This module is what closes that gap.
 *
 * ## Why a hand-written mock rather than a testing library
 *
 * `vi.mock` is used to point the `obsidian` module here (see
 * `installObsidianMock`). No mocking library is added: the surface is small, the
 * behaviour is simple, and the point is to model the *semantics* — including the
 * awkward ones, like the Vault API refusing to resolve paths inside hidden folders
 * — rather than to assert that a function was called.
 *
 * ## What is modelled, and why it matters
 *
 * - `getAbstractFileByPath` returns `null` inside dot-prefixed folders. This is real
 *   Obsidian behaviour and it is why a `.trash` destination is refused; the
 *   adapter's collision check depends on it.
 * - `createFolder` throws when the folder exists, which the adapter has to treat
 *   as a normal race rather than a failure.
 * - `renameFile` moves the `TFile` in place, so a reference held across the call
 *   keeps working and reflects the new path.
 * - `processFrontMatter` throws on malformed YAML, which is what turns a completed
 *   move into a warning rather than a failure.
 * - `onLayoutReady` invokes its callback immediately when layout is already ready,
 *   which is what happens whenever a plugin is enabled from settings.
 *
 * ## Deliberate omissions
 *
 * The workspace is event-driven and headless: leaves are a set of paths, layout
 * readiness is a flag. Nothing here renders anything, and the UI classes exist
 * only as constructors that record that they were built.
 */

/**
 * The application object the plugin is handed.
 *
 * Aliased to {@link FakeApp} so a test's `app as never` cast in production code
 * and the mock here cannot drift apart.
 */
export type App = FakeApp;

/** A recorded call, for asserting on the exact Obsidian API usage. */
export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  stat = { ctime: 0, mtime: 0, size: 0 };
  extension = "";
  basename = "";
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === "" || this.path === "/";
  }
}

export function normalizePath(path: string): string {
  return path
    .replace(/([\\/])+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/$/, "");
}

export function setIcon(): void {}
export function addIcon(): void {}
export function debounce<T extends unknown[]>(
  cb: (...args: T) => unknown,
  timeout = 0,
  resetTimer = false,
): ((...args: T) => void) & { cancel: () => void; run: (...args: T) => void } {
  // `globalThis` rather than `window`: this module also runs under the Node test
  // environment, where there is no `window`. It is the one spelling that works in
  // both, and it satisfies the type on either side of the Node/DOM split.
  let handle: ReturnType<typeof globalThis.setTimeout> | null = null;
  const wrapped = (...args: T): void => {
    if (handle !== null) globalThis.clearTimeout(handle);
    if (!resetTimer && handle !== null) return;
    handle = globalThis.setTimeout(() => {
      handle = null;
      cb(...args);
    }, timeout);
  };
  wrapped.cancel = () => {
    if (handle !== null) globalThis.clearTimeout(handle);
    handle = null;
  };
  wrapped.run = (...args: T) => {
    wrapped.cancel();
    cb(...args);
  };
  return wrapped;
}

export class Notice {
  static readonly messages: string[] = [];
  constructor(message: string | DocumentFragment) {
    Notice.messages.push(String(message));
  }
  hide(): void {}
}

export class Component {
  load(): void {}
  unload(): void {}
  /** Registers a teardown callback. The plugin collects these for unload. */
  register(_cb: () => unknown): void {}
  registerEvent(): void {}
  registerDomEvent(): void {}
  registerInterval(id: number): number {
    return id;
  }
  addChild<T>(child: T): T {
    return child;
  }
}

export class Plugin extends Component {
  constructor(public app: App) {
    super();
  }
  addCommand(): void {}
  addSettingTab(): void {}
  addRibbonIcon(): void {}
}

export class Modal {
  app: App;
  contentEl = element();
  modalEl = element();
  constructor(app: App) {
    this.app = app;
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
  setTitle(): this {
    return this;
  }
}

export class PluginSettingTab {
  containerEl = element();
  constructor(
    public app: App,
    public plugin: unknown,
  ) {}
  display(): void {}
  hide(): void {}
}

export class Setting {
  constructor(public containerEl: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  setClass(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addTextArea(): this {
    return this;
  }
  addSearch(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addDropdown(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
  addExtraButton(): this {
    return this;
  }
}

export class PopoverSuggest<T> {
  constructor(
    public app: App,
    public inputEl: unknown,
  ) {}
  close(): void {}
  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_value: T, _el: unknown): void {}
  selectSuggestion(_value: T, _evt?: unknown): void {}
  setValue(): void {}
  getValue(): string {
    return "";
  }
  onSelect(): this {
    return this;
  }
}

export class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  limit = 100;
}

/** A DOM stand-in good enough for the `createDiv`/`createEl` chains Obsidian adds. */
function element(): Record<string, unknown> {
  const el: Record<string, unknown> = {};
  el.empty = () => {};
  el.addClass = () => {};
  el.removeClass = () => {};
  el.toggleClass = () => {};
  el.createDiv = () => element();
  el.createSpan = () => element();
  el.createEl = () => element();
  el.setText = () => {};
  el.setAttr = () => {};
  return el;
}

/* -------------------------------------------------------------------------- */
/*                              The vault                                     */
/* -------------------------------------------------------------------------- */

export interface FakeFileSpec {
  path: string;
  mtime?: number;
  /** Raw frontmatter body, parsed only well enough for the tests that need it. */
  frontmatter?: Record<string, unknown> | null;
  /** Makes `processFrontMatter` reject, as malformed YAML would. */
  malformedFrontmatter?: boolean;
  content?: string;
}

export interface FakeAppOptions {
  files?: FakeFileSpec[];
  folders?: string[];
  /** Whether `onLayoutReady` should fire its callback at once. */
  layoutReady?: boolean;
  /** Paths the workspace should report as open. */
  openPaths?: string[];
}

export interface FakeVault {
  readonly calls: RecordedCall[];
  addFile(spec: FakeFileSpec): TFile;
  getFileByPath(path: string): TFile | null;
  getAbstractFileByPath(path: string): TAbstractFile | null;
  getFolderByPath(path: string): TFolder | null;
  createFolder(path: string): Promise<TFolder>;
  getFiles(): TFile[];
  getMarkdownFiles(): TFile[];
  getAllLoadedFiles(): TAbstractFile[];
  /** Makes the next call to `method` reject, once. */
  failNext(method: string, error?: Error): void;
  on(
    name: string,
    callback: (...args: unknown[]) => void,
  ): { name: string; callback: (...args: unknown[]) => void };
  offref(ref: unknown): void;
  /** Fires a vault event to every registered listener. */
  emit(name: string, ...args: unknown[]): void;
  /** How many listeners are currently attached. */
  listenerCount(): number;
}

export interface FakeFileManager {
  readonly calls: RecordedCall[];
  trashFile(file: TAbstractFile): Promise<void>;
  renameFile(file: TAbstractFile, newPath: string): Promise<void>;
  processFrontMatter(
    file: TFile,
    fn: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void>;
  failNext(method: string, error?: Error): void;
}

export interface FakeWorkspace {
  readonly calls: RecordedCall[];
  layoutReady: boolean;
  openPaths: string[];
  activeFile: TFile | null;
  onLayoutReady(callback: () => void): void;
  on(name: string, callback: (...args: unknown[]) => void): unknown;
  offref(ref: unknown): void;
  iterateAllLeaves(
    callback: (leaf: { getViewState(): { state?: { file?: string } } }) => void,
  ): void;
  getActiveFile(): TFile | null;
  emitLayoutReady(): void;
  /** Fires a workspace event to every registered listener. */
  emit(name: string, ...args: unknown[]): void;
  /** How many workspace listeners are currently attached. */
  listenerCount(): number;
}

export interface FakeMetadataCache {
  readonly calls: RecordedCall[];
  getFileCache(file: TFile): { frontmatter?: Record<string, unknown> } | null;
}

export interface FakeApp {
  vault: FakeVault;
  fileManager: FakeFileManager;
  workspace: FakeWorkspace;
  metadataCache: FakeMetadataCache;
}

/** Whether a path lies inside a hidden (dot-prefixed) folder. */
function isHidden(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".") && segment.length > 1);
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/**
 * Creates a fake `App`.
 *
 * The returned object is a plain object, not an `App`, and is passed in as
 * `RuntimeOptions.app`. That is the point of typing the runtime's `app` parameter
 * structurally: the production code and this stand-in are the same shape, so the
 * wiring under test is the wiring that ships.
 */
export function createFakeApp(options: FakeAppOptions = {}): FakeApp {
  const vaultCalls: RecordedCall[] = [];
  const fileManagerCalls: RecordedCall[] = [];
  const workspaceCalls: RecordedCall[] = [];
  const metadataCalls: RecordedCall[] = [];

  const failures = new Map<string, Error>();
  const files = new Map<string, TFile>();
  const folders = new Map<string, TFolder>();
  /**
   * Tracked by identity rather than by path: a file is renamed before its
   * frontmatter is rewritten, so a path-keyed set would miss exactly the case it
   * exists to model.
   */
  const malformed = new Set<TFile>();
  /**
   * What `MetadataCache` believes, keyed by identity.
   *
   * Held separately from the file body on purpose. In Obsidian the cache and the
   * file on disk can disagree — a cache built from an earlier successful parse,
   * with the file edited badly since — and that disagreement is exactly what turns
   * a completed move into a warning.
   */
  const cachedFrontmatter = new Map<TFile, Record<string, unknown>>();
  const contents = new Map<string, string>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const maybeFail = (method: string): void => {
    const error = failures.get(method);
    if (error === undefined) return;
    failures.delete(method);
    throw error;
  };

  const ensureFolder = (path: string): TFolder => {
    const existing = folders.get(path);
    if (existing !== undefined) return existing;

    const folder = new TFolder();
    folder.path = path;
    folder.name = path.split("/").pop() ?? path;
    folder.parent = path === "" ? null : ensureFolder(parentOf(path));
    folders.set(path, folder);
    return folder;
  };

  ensureFolder("");

  const vault: FakeVault = {
    calls: vaultCalls,

    addFile(spec) {
      maybeFail("addFile");
      const file = new TFile();
      file.path = spec.path;
      file.name = spec.path.split("/").pop() ?? spec.path;
      const dot = file.name.lastIndexOf(".");
      file.basename = dot <= 0 ? file.name : file.name.slice(0, dot);
      file.extension = dot <= 0 ? "" : file.name.slice(dot + 1).toLowerCase();
      file.stat = { ctime: spec.mtime ?? 0, mtime: spec.mtime ?? 0, size: 0 };

      const parent = parentOf(spec.path);
      ensureFolder(parent);
      files.set(spec.path, file);

      if (spec.frontmatter !== undefined && spec.frontmatter !== null) {
        cachedFrontmatter.set(file, { ...spec.frontmatter });
      }
      if (spec.malformedFrontmatter === true) {
        malformed.add(file);
        contents.set(spec.path, MALFORMED_YAML);
      } else {
        contents.set(spec.path, spec.content ?? renderFrontmatter(spec.frontmatter ?? null));
      }
      return file;
    },

    getFileByPath(path) {
      vaultCalls.push({ method: "getFileByPath", args: [path] });
      maybeFail("getFileByPath");
      // Obsidian does not expose files inside hidden folders through the Vault API.
      if (isHidden(path)) return null;
      return files.get(path) ?? null;
    },

    getAbstractFileByPath(path) {
      vaultCalls.push({ method: "getAbstractFileByPath", args: [path] });
      maybeFail("getAbstractFileByPath");
      if (isHidden(path)) return null;
      return files.get(path) ?? folders.get(path) ?? null;
    },

    getFolderByPath(path) {
      vaultCalls.push({ method: "getFolderByPath", args: [path] });
      maybeFail("getFolderByPath");
      if (isHidden(path)) return null;
      return folders.get(path) ?? null;
    },

    async createFolder(path) {
      vaultCalls.push({ method: "createFolder", args: [path] });
      maybeFail("createFolder");
      // Obsidian's documented behaviour: creating an existing folder throws.
      if (folders.has(path)) throw new Error(`Folder already exists: ${path}`);
      return ensureFolder(path);
    },

    getFiles() {
      vaultCalls.push({ method: "getFiles", args: [] });
      maybeFail("getFiles");
      return [...files.values()].filter((file) => !isHidden(file.path));
    },

    getMarkdownFiles() {
      return vault.getFiles().filter((file) => file.extension === "md");
    },

    getAllLoadedFiles() {
      vaultCalls.push({ method: "getAllLoadedFiles", args: [] });
      return [...folders.values(), ...files.values()];
    },

    failNext(method, error) {
      failures.set(method, error ?? new Error(`Simulated failure: ${method}`));
    },

    on(name, callback) {
      const ref = { name, callback };
      const set = listeners.get(name) ?? new Set();
      set.add(callback);
      listeners.set(name, set);
      return ref;
    },

    offref(ref) {
      const entry = ref as { name: string; callback: (...args: unknown[]) => void } | undefined;
      if (entry === undefined) return;
      listeners.get(entry.name)?.delete(entry.callback);
    },

    emit(name, ...args) {
      for (const callback of listeners.get(name) ?? []) callback(...args);
    },

    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };

  const fileManager: FakeFileManager = {
    calls: fileManagerCalls,

    async trashFile(file) {
      fileManagerCalls.push({ method: "trashFile", args: [file.path] });
      maybeFail("fileManager.trashFile");
      if (!files.has(file.path)) throw new Error(`No file at "${file.path}"`);
      files.delete(file.path);
    },

    async renameFile(file, newPath) {
      fileManagerCalls.push({ method: "renameFile", args: [file.path, newPath] });
      maybeFail("fileManager.renameFile");
      const from = file.path;
      if (!files.has(from)) throw new Error(`No file at "${from}"`);
      if (files.has(newPath)) throw new Error(`A file already exists at "${newPath}"`);

      files.delete(from);
      ensureFolder(parentOf(newPath));

      // The file's contents travel with it, as they do on disk.
      const body = contents.get(from);
      contents.delete(from);
      if (body !== undefined) contents.set(newPath, body);

      // Obsidian mutates the TFile in place, so a reference taken before the call
      // stays valid and reports the new path. The adapter relies on this.
      const moved = file as TFile;
      moved.path = newPath;
      moved.name = newPath.split("/").pop() ?? newPath;
      files.set(newPath, moved);
      vault.emit("rename", moved, from);
    },

    async processFrontMatter(file, fn) {
      fileManagerCalls.push({ method: "processFrontMatter", args: [file.path] });
      maybeFail("fileManager.processFrontMatter");
      if (malformed.has(file)) {
        throw new Error(`Malformed YAML in "${file.path}"`);
      }

      const current = parseFrontmatter(contents.get(file.path) ?? "") ?? {};
      fn(current);
      cachedFrontmatter.set(file, current);
      contents.set(file.path, renderFrontmatter(current));
    },

    failNext(method, error) {
      failures.set(`fileManager.${method}`, error ?? new Error(`Simulated failure: ${method}`));
    },
  };

  const workspaceListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let layoutCallbacks: Array<() => void> = [];

  const workspace: FakeWorkspace = {
    calls: workspaceCalls,
    layoutReady: options.layoutReady ?? true,
    openPaths: options.openPaths ?? [],
    activeFile: null,

    onLayoutReady(callback) {
      workspaceCalls.push({ method: "onLayoutReady", args: [] });
      layoutCallbacks.push(callback);
      // Obsidian runs the callback at once when the layout is already ready.
      if (workspace.layoutReady) callback();
    },

    on(name, callback) {
      workspaceCalls.push({ method: `workspace.on:${name}`, args: [] });
      const set = workspaceListeners.get(name) ?? new Set();
      set.add(callback);
      workspaceListeners.set(name, set);
      return { name, callback };
    },

    offref(ref) {
      const entry = ref as { name: string; callback: (...args: unknown[]) => void } | undefined;
      if (entry === undefined) return;
      workspaceListeners.get(entry.name)?.delete(entry.callback);
    },

    iterateAllLeaves(callback) {
      workspaceCalls.push({ method: "iterateAllLeaves", args: [] });
      for (const path of workspace.openPaths) {
        callback({ getViewState: () => ({ state: { file: path } }) });
      }
    },

    getActiveFile() {
      const path = workspace.activeFile?.path ?? workspace.openPaths[0] ?? null;
      return path === null ? null : (files.get(path) ?? null);
    },

    emitLayoutReady() {
      for (const callback of layoutCallbacks) callback();
    },

    emit(name, ...args) {
      for (const callback of workspaceListeners.get(name) ?? []) callback(...args);
    },

    listenerCount() {
      let total = 0;
      for (const set of workspaceListeners.values()) total += set.size;
      return total;
    },
  };

  const metadataCache: FakeMetadataCache = {
    calls: metadataCalls,

    getFileCache(file) {
      metadataCalls.push({ method: "getFileCache", args: [file.path] });
      maybeFail("getFileCache");
      if (file.extension !== "md") return null;
      const frontmatter = cachedFrontmatter.get(file);
      return frontmatter === undefined ? null : { frontmatter };
    },
  };

  for (const folder of options.folders ?? []) ensureFolder(folder);
  for (const spec of options.files ?? []) vault.addFile(spec);

  return {
    vault,
    fileManager,
    workspace,
    metadataCache: metadataCache,
  };
}

/* ------------------------------- YAML-ish ---------------------------------- */
/*                                                                            */
/* Only as much parsing as the plugin's own behaviour needs: a flat key/value   */
/* block. Anything richer would be testing the mock rather than the adapter.   */

/** A body that looks like frontmatter but that no parser will accept. */
const MALFORMED_YAML = "---\nttl: [unclosed\n  bad: : :\n---\n";

function renderFrontmatter(frontmatter: Record<string, unknown> | null): string {
  if (frontmatter === null || Object.keys(frontmatter).length === 0) return "";
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${formatScalar(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function parseFrontmatter(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;

  const result: Record<string, unknown> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length === 0) continue;
    result[key] = parseScalar(value);
  }
  return result;
}

function formatScalar(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => String(entry)).join(", ")}]`;
  return String(value);
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/*                          Installed as `obsidian`                           */
/* -------------------------------------------------------------------------- */

/**
 * The most recently created fake app.
 *
 * Set by {@link installObsidianMock}, which a test calls from `beforeEach`. It
 * exists so a test can make the fake vault misbehave — fail a call, emit an event
 * — without threading the app through every layer in between.
 */
export const state: { app: FakeApp | null } = { app: null };

/**
 * Resets the shared state and returns the fake app.
 *
 * Called from `beforeEach` so no state leaks between tests.
 */
export function installObsidianMock(options: FakeAppOptions = {}): FakeApp {
  Notice.messages.length = 0;
  const app = createFakeApp(options);
  state.app = app;
  return app;
}
