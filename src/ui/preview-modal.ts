import type { App } from "obsidian";
import { Modal, Setting } from "obsidian";
import { buildTree, collapseSingleChildFolders } from "../domain/file-tree";
import type { ExpiredFile } from "../domain/types";
import { pluralize } from "./format";
import { TreeSelection } from "./tree-selection";
import { TreeView } from "./tree-view";

/**
 * Asks the user to confirm what Auto Remove is about to do.
 *
 * Nothing is ever removed without passing through here. Everything starts
 * selected, because confirming the whole batch is the common case, and any file
 * can be unchecked individually or by folder.
 *
 * `confirm` resolves with the files the user kept, or `null` if they cancelled
 * or dismissed the dialog — so closing the window can never be mistaken for
 * approval.
 */
export class CleanupPreviewModal extends Modal {
	private readonly selection: TreeSelection;
	private readonly tree: ReturnType<typeof collapseSingleChildFolders>;
	private confirmed: readonly ExpiredFile[] | null = null;
	private confirmButton: HTMLButtonElement | null = null;
	private summaryEl: HTMLElement | null = null;

	private constructor(
		app: App,
		private readonly items: readonly ExpiredFile[],
		private readonly openPaths: ReadonlySet<string>,
		private readonly resolve: (selected: readonly ExpiredFile[] | null) => void,
	) {
		super(app);
		this.tree = collapseSingleChildFolders(buildTree(items));
		this.selection = TreeSelection.selectAll(this.tree);
	}

	static confirm(
		app: App,
		items: readonly ExpiredFile[],
		openPaths: ReadonlySet<string>,
	): Promise<readonly ExpiredFile[] | null> {
		return new Promise((resolve) => {
			new CleanupPreviewModal(app, items, openPaths, resolve).open();
		});
	}

	override onOpen(): void {
		this.setTitle("Expired files");
		this.modalEl.addClass("auto-remove-modal");

		this.renderSummary();
		this.renderTree();
		this.renderControls();
		this.updateSummary();
	}

	override onClose(): void {
		this.contentEl.empty();
		// Covers Escape and the close button as well as Cancel: anything other
		// than an explicit confirmation resolves to `null`.
		this.resolve(this.confirmed);
	}

	private renderSummary(): void {
		const intro = this.contentEl.createDiv({ cls: "auto-remove-modal__intro" });
		intro.createEl("p", {
			text: `${pluralize(this.items.length, "file")} reached the end of their time to live.`,
		});
		this.summaryEl = intro.createEl("p", { cls: "auto-remove-modal__summary" });
	}

	private renderTree(): void {
		const host = this.contentEl.createDiv({ cls: "auto-remove-tree" });
		const view = new TreeView(host, {
			selection: this.selection,
			openPaths: this.openPaths,
			onChange: () => this.updateSummary(),
		});
		view.render(this.tree);

		new Setting(this.contentEl)
			.setClass("auto-remove-modal__bulk")
			.addExtraButton((button) =>
				button
					.setIcon("check-square")
					.setTooltip("Select all")
					.onClick(() => {
						this.selection.setSubtree(this.tree, true);
						view.refresh();
						this.updateSummary();
					}),
			)
			.addExtraButton((button) =>
				button
					.setIcon("square")
					.setTooltip("Select none")
					.onClick(() => {
						this.selection.setSubtree(this.tree, false);
						view.refresh();
						this.updateSummary();
					}),
			);
	}

	private renderControls(): void {
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => {
				this.confirmButton = button.buttonEl;
				button
					.setButtonText("Remove selected")
					.setCta()
					.onClick(() => {
						this.confirmed = this.selectedItems();
						this.close();
					});
			});
	}

	private selectedItems(): ExpiredFile[] {
		return this.items.filter((item) => this.selection.isSelected(item.file.path));
	}

	private updateSummary(): void {
		const selected = this.selection.size;
		const deferred = this.selectedItems().filter((item) =>
			this.openPaths.has(item.file.path),
		).length;

		if (this.summaryEl !== null) {
			const parts = [`${pluralize(selected, "file")} selected`];
			if (deferred > 0) parts.push(`${deferred} open and will run after closing`);
			this.summaryEl.setText(parts.join(" · "));
		}

		if (this.confirmButton !== null) this.confirmButton.disabled = selected === 0;
	}
}
