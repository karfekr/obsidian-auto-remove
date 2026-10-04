import { PluginSettingTab, Setting } from "obsidian";
import type { App, Plugin } from "obsidian";
import type { FolderRule } from "../domain/types";
import { validateSettings } from "../domain/validation";
import type { ConfigurationProblem } from "../domain/validation";
import { createFolderRule, DEFAULT_TTL_DAYS } from "../settings/defaults";
import type { SettingsStore } from "../settings/settings-store";
import { FolderRuleEditor } from "./folder-rule-editor";
import { FolderSuggest } from "./folder-suggest";
import { pluralize } from "./format";

/**
 * The Auto Remove settings page.
 *
 * Editing a rule re-renders the whole tab. The page is small, rules are few,
 * and a full redraw is what keeps conditional fields — the destination folder
 * appearing only for Move — correct without any incremental update logic.
 *
 * This uses the imperative `display()` API rather than the declarative
 * `getSettingDefinitions()` introduced in Obsidian 1.13.0. The declarative API
 * maps settings keys to controls one-for-one, which cannot express a list of
 * folder rules the user adds to and removes from at will. Adopting it would
 * also raise the minimum app version from 1.6.6 to 1.13.0 for no gain to the
 * feature that needs it least.
 */
export class AutoRemoveSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly store: SettingsStore,
    /** Runs a dry run, so the page can offer the same check as the command. */
    private readonly onDryRun: () => void,
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.containerEl.empty();
    this.renderDefaults();
    this.renderDiagnostics();
    this.renderFolderRules();
  }

  private renderDefaults(): void {
    const { settings } = this.store;

    new Setting(this.containerEl)
      .setName("Notes that opt in")
      .setDesc(
        'These settings apply to notes containing "auto-remove: true". ' +
          "Folder rules never apply to them.",
      )
      .setHeading();

    new Setting(this.containerEl)
      .setName("Default time to live")
      .setDesc('Used when a note opts in without giving a "ttl" property.')
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_TTL_DAYS))
          .setValue(String(settings.defaultTtlDays))
          .onChange((value) => {
            const days = Number(value);
            if (Number.isInteger(days) && days >= 0)
              void this.store.update({ defaultTtlDays: days });
          });
        text.inputEl.type = "number";
        text.inputEl.min = "0";
      });

    new Setting(this.containerEl)
      .setName("Default action")
      .setDesc("What happens to an opted-in note once it expires.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ trash: "Trash", move: "Move" })
          .setValue(settings.defaultAction)
          .onChange(async (value) => {
            await this.store.update({ defaultAction: value === "move" ? "move" : "trash" });
            this.display();
          }),
      );

    if (settings.defaultAction === "move") {
      new Setting(this.containerEl)
        .setName("Default destination folder")
        .setDesc("Where opted-in notes are moved when they expire.")
        .addSearch((search) => {
          search
            .setPlaceholder("Archive")
            .setValue(settings.defaultMoveDestination)
            .onChange((folder) => void this.store.update({ defaultMoveDestination: folder }));
          new FolderSuggest(
            this.app,
            search.inputEl,
            (folder) => void this.store.update({ defaultMoveDestination: folder }),
          );
        });
    }
  }

  /**
   * Configuration that is currently doing nothing, stated plainly.
   *
   * This exists because of a specific failure: a `move` with no destination used
   * to resolve to "no policy at all", so every opted-in note was silently
   * ignored. The page now says so in as many words, and the rule claims nothing
   * rather than falling back to a delete.
   */
  private renderDiagnostics(): void {
    const problems = validateSettings(this.store.settings);
    const brokenRules = problems.filter((problem) => problem.target.startsWith("rule:")).length;

    if (problems.length > 0) {
      // Stated as a list rather than a hint, because these rules are *not running*.
      // Silently inert configuration is what made this plugin look broken.
      const banner = this.containerEl.createDiv({ cls: "auto-remove-banner is-visible" });
      banner.createEl("p", {
        text:
          problems.length === 1
            ? "One rule is not running until you fix it:"
            : `${problems.length} rules are not running until you fix them:`,
      });
      banner.createEl("ul");
      const list = banner.querySelector("ul");
      for (const problem of problems) {
        list?.createEl("li", {
          text: `${describeTarget(problem.target)}: ${problem.message}`,
        });
      }
      banner.createEl("p", {
        text: "Nothing is deleted or moved by an incomplete rule — it is never treated as a request to trash.",
      });
    }

    if (brokenRules === 0) {
      new Setting(this.containerEl)
        .setName("Developer logging")
        .setDesc(
          "Write every decision and failure to the developer console, and explain any file you ask about.",
        )
        .addToggle((toggle) =>
          toggle.setValue(this.store.settings.debugLogging).onChange((debugLogging) => {
            void this.store.update({ debugLogging });
          }),
        );

      new Setting(this.containerEl)
        .setName("Check without changing anything")
        .setDesc("Report what a reconciliation would do right now, and why. Touches nothing.")
        .addButton((button) => button.setButtonText("Preview").onClick(this.onDryRun));
    }
  }

  private renderFolderRules(): void {
    const { folderRules } = this.store.settings;

    new Setting(this.containerEl)
      .setName("Folder rules")
      .setDesc(
        folderRules.length === 0
          ? "Apply a time to live to the notes in a folder. Attachments are opt-in per rule."
          : `${pluralize(folderRules.length, "rule")}. The most specific folder wins.`,
      )
      .setHeading()
      .addButton((button) =>
        button
          .setIcon("plus")
          .setButtonText("Add rule")
          .setCta()
          .onClick(async () => {
            await this.replaceRules([...folderRules, createFolderRule()]);
            this.display();
          }),
      );

    for (const rule of folderRules) {
      new FolderRuleEditor(this.containerEl, {
        app: this.app,
        rule,
        onChange: (changes) => void this.updateRule(rule.id, changes),
        onDelete: () => void this.deleteRule(rule.id),
      }).render();
    }
  }

  /**
   * Changing the action re-renders, because it decides whether the destination
   * field belongs on the page at all; other edits leave the DOM alone so the
   * user does not lose focus mid-keystroke.
   */
  private async updateRule(id: string, changes: Partial<FolderRule>): Promise<void> {
    await this.replaceRules(
      this.store.settings.folderRules.map((rule) =>
        rule.id === id ? { ...rule, ...changes } : rule,
      ),
    );
    if (changes.action !== undefined) this.display();
  }

  private async deleteRule(id: string): Promise<void> {
    await this.replaceRules(this.store.settings.folderRules.filter((rule) => rule.id !== id));
    this.display();
  }

  private async replaceRules(folderRules: readonly FolderRule[]): Promise<void> {
    await this.store.update({ folderRules });
  }
}

/** Turns a validation target back into something a person recognises. */
function describeTarget(target: ConfigurationProblem["target"]): string {
  return target === "default-action" ? "Default action" : "A folder rule";
}
