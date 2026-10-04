import { Setting } from "obsidian";
import type { App } from "obsidian";
import { validateIgnorePattern } from "../domain/ignore-matcher";
import type { FolderRule } from "../domain/types";
import { describeRuleProblem, splitPatternLines } from "../settings/settings-schema";
import { FolderSuggest } from "./folder-suggest";

export interface FolderRuleEditorOptions {
  readonly app: App;
  readonly rule: FolderRule;
  readonly onChange: (changes: Partial<FolderRule>) => void;
  readonly onDelete: () => void;
}

/**
 * Renders one folder rule.
 *
 * Kept separate from the settings tab so that each stays readable: the tab is
 * about the shape of the settings page, this is about the shape of a rule.
 */
export class FolderRuleEditor {
  constructor(
    private readonly container: HTMLElement,
    private readonly options: FolderRuleEditorOptions,
  ) {}

  render(): void {
    const { rule } = this.options;
    const card = this.container.createDiv({ cls: "auto-remove-rule" });

    this.renderHeader(card, rule);
    this.renderTtl(card, rule);
    this.renderScope(card, rule);
    this.renderAction(card, rule);
    if (rule.action === "move") this.renderDestination(card, rule);
    this.renderIgnorePatterns(card, rule);
    this.renderProblem(card, rule);
  }

  private renderHeader(card: HTMLElement, rule: FolderRule): void {
    new Setting(card)
      .setName("Folder")
      .setDesc("Everything inside this folder, at any depth. Leave empty for the whole vault.")
      .addSearch((search) => {
        search
          .setPlaceholder("Vault root")
          .setValue(rule.folder)
          .onChange((folder) => this.options.onChange({ folder }));
        new FolderSuggest(this.options.app, search.inputEl, (folder) =>
          this.options.onChange({ folder }),
        );
      })
      .addToggle((toggle) =>
        toggle
          .setTooltip(rule.enabled ? "Rule is active" : "Rule is paused")
          .setValue(rule.enabled)
          .onChange((enabled) => this.options.onChange({ enabled })),
      )
      .addExtraButton((button) =>
        button.setIcon("trash-2").setTooltip("Delete rule").onClick(this.options.onDelete),
      );
  }

  private renderTtl(card: HTMLElement, rule: FolderRule): void {
    new Setting(card)
      .setName("Time to live")
      .setDesc("Days since a file was last modified before it expires.")
      .addText((text) => {
        text
          .setPlaceholder("7")
          .setValue(String(rule.ttlDays))
          .onChange((value) => {
            const days = Number(value);
            // Ignore keystrokes that are not yet a usable number, so the field
            // does not fight the user mid-typing.
            if (Number.isInteger(days) && days >= 0) this.options.onChange({ ttlDays: days });
          });
        text.inputEl.type = "number";
        text.inputEl.min = "0";
      });
  }

  /**
   * Which files the rule may claim.
   *
   * Markdown only by default, and the wording says why: attachments carry no
   * frontmatter, so nothing stops them being expired again from their new home.
   */
  private renderScope(card: HTMLElement, rule: FolderRule): void {
    new Setting(card)
      .setName("Applies to")
      .setDesc(
        rule.scope === "md"
          ? "Markdown notes only."
          : "Markdown notes and attachments. Attachments carry no properties, so one moved into a folder this rule covers would be filed again on the next run.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ md: "Notes only", all: "Notes and attachments" })
          .setValue(rule.scope)
          .onChange((value) => this.options.onChange({ scope: value === "all" ? "all" : "md" })),
      );
  }

  private renderAction(card: HTMLElement, rule: FolderRule): void {
    new Setting(card)
      .setName("Action")
      .setDesc("What happens to a file once it expires.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ trash: "Trash", move: "Move" })
          .setValue(rule.action)
          .onChange((value) =>
            this.options.onChange({ action: value === "move" ? "move" : "trash" }),
          ),
      );
  }

  private renderDestination(card: HTMLElement, rule: FolderRule): void {
    new Setting(card)
      .setName("Destination folder")
      .setDesc("Expired files are moved here, and stop expiring afterwards.")
      .addSearch((search) => {
        search
          .setPlaceholder("Archive")
          .setValue(rule.moveDestination)
          .onChange((moveDestination) => this.options.onChange({ moveDestination }));
        new FolderSuggest(this.options.app, search.inputEl, (moveDestination) =>
          this.options.onChange({ moveDestination }),
        );
      });
  }

  private renderIgnorePatterns(card: HTMLElement, rule: FolderRule): void {
    const setting = new Setting(card)
      .setName("Ignore patterns")
      .setDesc("One gitignore-style pattern per line, relative to the folder above.")
      .setClass("auto-remove-rule__patterns");

    const errorEl = setting.descEl.createDiv({ cls: "auto-remove-rule__error" });

    setting.addTextArea((area) => {
      area
        .setPlaceholder("Templates/**\n*.canvas\n!Templates/keep.md")
        .setValue(rule.ignorePatterns.join("\n"))
        .onChange((value) => {
          const patterns = splitPatternLines(value);
          this.showPatternErrors(errorEl, patterns);
          this.options.onChange({ ignorePatterns: patterns });
        });
      area.inputEl.rows = 4;
    });

    this.showPatternErrors(errorEl, [...rule.ignorePatterns]);
  }

  private showPatternErrors(errorEl: HTMLElement, patterns: string[]): void {
    const invalid = patterns.filter((pattern) => validateIgnorePattern(pattern) !== null);
    errorEl.setText(invalid.length === 0 ? "" : `Unusable pattern: ${invalid.join(", ")}`);
    errorEl.toggleClass("is-visible", invalid.length > 0);
  }

  private renderProblem(card: HTMLElement, rule: FolderRule): void {
    const problem = describeRuleProblem(rule);
    if (problem === null) return;

    // A rule in this state claims nothing, which is easy to mistake for a bug.
    card.createDiv({ cls: "auto-remove-rule__error is-visible", text: problem });
  }
}
