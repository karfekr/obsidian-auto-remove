import { normalizePath, TFolder } from "obsidian";
import type { App, TFile } from "obsidian";
import { MANAGED_PROPERTIES } from "../domain/policy/frontmatter-policy-source";
import { basename, joinPath, splitExtension } from "../domain/vault-path";
import type { FileActions, Logger, MoveResult } from "../services/ports";
import { requireFile } from "./vault-file-repository";

/**
 * How many names to try before giving up on finding a free one.
 *
 * `availablePath` has no natural termination condition other than "this name is
 * free", so it needs an explicit ceiling. Without one, a destination Obsidian
 * will not resolve — a hidden folder, say — would spin forever instead of
 * failing.
 */
const MAX_COLLISION_ATTEMPTS = 1000;

/**
 * Performs removals through Obsidian's own file manager.
 *
 * Both actions delegate rather than reimplement: `trashFile` already honours
 * whichever deletion behaviour the user configured, and `renameFile` already
 * rewrites inbound links according to their link preferences. Reproducing
 * either here would mean quietly disagreeing with the rest of the app.
 *
 * The product semantics are unchanged: "trash" means Obsidian's own configured
 * deletion behaviour, which may be the system trash, the vault's `.trash`
 * folder, or permanent deletion if the user has asked for that. Auto Remove has
 * no opinion of its own and keeps no trash of its own.
 */
export class VaultFileActions implements FileActions {
  constructor(
    private readonly app: App,
    private readonly logger: Logger,
  ) {}

  /**
   * Deletes according to the user's "Deleted files" preference — system trash,
   * the vault's `.trash` folder, or permanent deletion.
   *
   * Throws if the file has gone, rather than reporting a success that did not
   * happen.
   */
  async trash(path: string): Promise<MoveResult> {
    await this.app.fileManager.trashFile(requireFile(this.app, path));
    return { path, moved: true, warnings: [] };
  }

  /**
   * Moves a file into `destination` and hands back its new path.
   *
   * Once the move succeeds the file is released from Auto Remove's control by
   * stripping the properties that opted it in — otherwise an archived note would
   * simply expire again from its new home.
   *
   * A failure in that second step is reported as a *warning* on a successful
   * move, not as a failed move. The audit's clearest bug was exactly this: the
   * two mutations shared one promise, so a note with malformed frontmatter moved
   * correctly and was then reported to the user as a failure.
   */
  async move(path: string, destination: string): Promise<MoveResult> {
    const file = requireFile(this.app, path);
    const folder = normalizePath(destination);
    const warnings: string[] = [];

    await this.ensureFolderExists(folder);
    const target = this.availablePath(folder, file.name);

    // `renameFile` mutates the TFile in place, so `file` stays valid afterwards.
    await this.app.fileManager.renameFile(file, target);

    try {
      await this.releaseFromAutoRemove(file);
    } catch (error) {
      // The move has already happened. Rolling it back would be a second, riskier
      // mutation, so the file is left where it is and the problem is reported.
      warnings.push(
        `its Auto Remove properties could not be removed (${describeError(error)}); ` +
          "it may expire again from its new location",
      );
    }

    return { path: file.path, moved: true, warnings };
  }

  /**
   * Removes the properties Auto Remove owns.
   *
   * Skipped entirely when there is nothing of ours to remove. `processFrontMatter`
   * *adds* a frontmatter block to a file that has none, so calling it on an
   * ordinary note would leave `---\n---` behind in the user's file — a pointless
   * edit of content nobody asked us to touch. The check is against the in-memory
   * metadata cache, so it costs nothing.
   *
   * Malformed YAML is the remaining failure. `processFrontMatter` throws rather
   * than writing something it cannot parse, which is the right behaviour:
   * corrupting someone's note to tidy up two keys is a far worse outcome than
   * leaving them.
   */
  private async releaseFromAutoRemove(file: TFile): Promise<void> {
    if (file.extension.toLowerCase() !== "md") return;
    if (!this.managesPropertiesOf(file)) return;

    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      for (const property of MANAGED_PROPERTIES) delete frontmatter[property];
    });
  }

  /** Whether this file carries at least one property Auto Remove owns. */
  private managesPropertiesOf(file: TFile): boolean {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (frontmatter === undefined) return false;
    return MANAGED_PROPERTIES.some((property) => property in frontmatter);
  }

  /**
   * Creates the destination folder, including any missing parents.
   *
   * `createFolder` throws if the folder exists, which is the normal outcome when
   * two files are filed into the same place in one run — so a throw is only
   * re-raised when the folder genuinely is not there afterwards.
   */
  private async ensureFolderExists(folder: string): Promise<void> {
    if (folder.length === 0) return;
    if (this.app.vault.getFolderByPath(folder) instanceof TFolder) return;

    try {
      await this.app.vault.createFolder(folder);
      this.logger.debug(`Created the destination folder "${folder}"`, { folder });
    } catch (error) {
      // Concurrent runs, or a folder created between the check and the call.
      if (this.app.vault.getFolderByPath(folder) === null) throw error;
    }
  }

  /**
   * Finds a free name in the destination, appending ` 1`, ` 2`, … the way
   * Obsidian does elsewhere. Expiring a file must never overwrite an unrelated
   * one that happens to share its name.
   */
  private availablePath(folder: string, name: string): string {
    const direct = joinPath(folder, name);
    if (!this.exists(direct)) return direct;

    const { stem, suffix } = splitExtension(basename(name));
    for (let index = 1; index <= MAX_COLLISION_ATTEMPTS; index += 1) {
      const candidate = joinPath(folder, `${stem} ${index}${suffix}`);
      if (!this.exists(candidate)) return candidate;
    }

    throw new Error(
      `Auto Remove: no free name for "${name}" in "${folder}" after ${MAX_COLLISION_ATTEMPTS} attempts.`,
    );
  }

  /**
   * Whether a path is genuinely taken.
   *
   * The Vault API returns `null` for anything inside a hidden (dot-prefixed)
   * folder, so a plain `=== null` check would report such paths as free and hand
   * `renameFile` a target that already exists. `domain/validation.ts` rejects
   * those destinations; this is the second line of defence for a destination that
   * was set by other means.
   */
  private exists(path: string): boolean {
    if (this.app.vault.getAbstractFileByPath(path) !== null) return true;
    return segmentsOf(path).some((segment) => segment.startsWith(".") && segment.length > 1);
  }
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
