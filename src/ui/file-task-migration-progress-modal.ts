import { App, Modal } from 'obsidian';
import {
	FileTaskMigrationApplyResult,
	FileTaskMigrationProgress,
	FileTaskMigrationScanResult,
} from '../core/file-task-migration';
import { t } from '../core/i18n';

export interface FileTaskMigrationProgressModalOptions {
	scanResult: FileTaskMigrationScanResult;
	ruleLabel: string;
	onConvert: (
		onProgress: (progress: FileTaskMigrationProgress) => void,
		setStatus: (message: string) => void,
	) => Promise<FileTaskMigrationApplyResult>;
}

interface ValueRow {
	valueEl: HTMLElement;
}

export class FileTaskMigrationProgressModal extends Modal {
	private readonly options: FileTaskMigrationProgressModalOptions;
	private eligibleRow: ValueRow | null = null;
	private convertedRow: ValueRow | null = null;
	private alreadyRow: ValueRow | null = null;
	private excludedRow: ValueRow | null = null;
	private failedRow: ValueRow | null = null;
	private statusEl: HTMLElement | null = null;
	private cancelButton: HTMLButtonElement | null = null;
	private convertButton: HTMLButtonElement | null = null;
	private finishedButton: HTMLButtonElement | null = null;
	private closed = false;
	private running = false;

	constructor(app: App, options: FileTaskMigrationProgressModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('operon-file-task-migration-progress-modal');
		contentEl.empty();
		this.titleEl.setText(t('settings', 'fileTaskMigrationConfirmTitle'));

		const table = contentEl.createDiv('operon-confirm-action-table');
		this.renderStaticRow(table, t('settings', 'fileTaskMigrationConfirmRule'), this.options.ruleLabel);
		this.eligibleRow = this.renderValueRow(table, t('settings', 'fileTaskMigrationConfirmEligible'), this.options.scanResult.convertibleFiles.length);
		this.convertedRow = this.renderValueRow(table, t('settings', 'fileTaskMigrationConverted'), 0);
		this.alreadyRow = this.renderValueRow(table, t('settings', 'fileTaskMigrationConfirmAlready'), this.options.scanResult.alreadyFileTaskFiles.length);
		this.excludedRow = this.renderValueRow(table, t('settings', 'fileTaskMigrationConfirmExcluded'), this.options.scanResult.excludedFiles.length);
		this.failedRow = this.renderValueRow(table, t('settings', 'fileTaskMigrationFailed'), 0);

		contentEl.createEl('p', {
			text: t('settings', 'fileTaskMigrationConfirmMessage', {
				count: String(this.options.scanResult.convertibleFiles.length),
			}),
		});
		this.statusEl = contentEl.createDiv({
			text: t('settings', 'fileTaskMigrationReady'),
			cls: 'operon-file-task-migration-modal-status',
		});

		const actions = contentEl.createDiv('operon-file-task-migration-modal-actions');
		this.cancelButton = actions.createEl('button', {
			text: t('buttons', 'cancel'),
			cls: 'operon-file-task-migration-modal-cancel',
		});
		this.cancelButton.addEventListener('click', () => {
			if (!this.running) this.close();
		});

		this.convertButton = actions.createEl('button', {
			text: t('settings', 'fileTaskMigrationConfirmConvert'),
		});
		this.convertButton.addClass('mod-cta');
		this.convertButton.addEventListener('click', () => {
			void this.runConversion();
		});

		this.finishedButton = actions.createEl('button', {
			text: t('settings', 'fileTaskMigrationFinished'),
			cls: 'operon-file-task-migration-modal-finished',
		});
		this.finishedButton.addClass('mod-cta');
		this.finishedButton.addClass('is-hidden');
		this.finishedButton.addEventListener('click', () => {
			this.close();
		});

		window.setTimeout(() => this.convertButton?.focus(), 0);
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	close(): void {
		if (this.running) return;
		super.close();
	}

	private renderStaticRow(table: HTMLElement, label: string, value: string): void {
		const item = table.createDiv('operon-confirm-action-table-row');
		item.createDiv({ cls: 'operon-confirm-action-table-label', text: label });
		item.createDiv({ cls: 'operon-confirm-action-table-value operon-confirm-action-table-value-full', text: value });
	}

	private renderValueRow(table: HTMLElement, label: string, value: number): ValueRow {
		const item = table.createDiv('operon-confirm-action-table-row');
		item.createDiv({ cls: 'operon-confirm-action-table-label', text: label });
		const valueEl = item.createDiv({
			cls: 'operon-confirm-action-table-value operon-confirm-action-table-value-full',
			text: String(value),
		});
		return { valueEl };
	}

	private setRow(row: ValueRow | null, value: number): void {
		row?.valueEl.setText(String(value));
	}

	private setStatus(message: string): void {
		if (this.closed) return;
		this.statusEl?.setText(message);
	}

	private applyProgress(progress: FileTaskMigrationProgress): void {
		if (this.closed) return;
		this.setRow(this.eligibleRow, progress.remainingEligible);
		this.setRow(this.convertedRow, progress.converted);
		this.setRow(this.alreadyRow, this.options.scanResult.alreadyFileTaskFiles.length + progress.skippedExisting);
		this.setRow(this.failedRow, progress.failed);
		this.setStatus(progress.currentPath
			? t('settings', 'fileTaskMigrationConvertingFile', { path: progress.currentPath })
			: t('settings', 'fileTaskMigrationConverting'));
	}

	private async runConversion(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.cancelButton?.setAttribute('disabled', 'true');
		this.convertButton?.setAttribute('disabled', 'true');
		this.setStatus(t('settings', 'fileTaskMigrationConverting'));

		try {
			const result = await this.options.onConvert(
				progress => this.applyProgress(progress),
				message => this.setStatus(message),
			);
			this.finishConversion(result);
		} catch (error) {
			this.setStatus(error instanceof Error ? error.message : String(error));
			this.setRow(this.failedRow, this.options.scanResult.convertibleFiles.length);
		} finally {
			this.running = false;
			this.finishedButton?.removeClass('is-hidden');
			this.finishedButton?.focus();
		}
	}

	private finishConversion(result: FileTaskMigrationApplyResult): void {
		this.cancelButton?.setAttribute('disabled', 'true');
		this.convertButton?.setAttribute('disabled', 'true');
		if (result.abortedReason) {
			const currentScan = result.currentScan ?? this.options.scanResult;
			this.setRow(this.eligibleRow, currentScan.convertibleFiles.length);
			this.setRow(this.convertedRow, 0);
			this.setRow(this.alreadyRow, currentScan.alreadyFileTaskFiles.length);
			this.setRow(this.excludedRow, currentScan.excludedFiles.length);
			this.setRow(this.failedRow, 0);
			this.setStatus(result.abortedReason === 'fileChanged'
				? t('settings', 'fileTaskMigrationFilesChanged')
				: t('settings', 'fileTaskMigrationScanChanged'));
			return;
		}
		this.setRow(this.eligibleRow, 0);
		this.setRow(this.convertedRow, result.convertedFiles.length);
		this.setRow(this.alreadyRow, this.options.scanResult.alreadyFileTaskFiles.length + result.skippedExistingFiles.length);
		this.setRow(this.excludedRow, this.options.scanResult.excludedFiles.length);
		this.setRow(this.failedRow, result.failedFiles.length);
		this.setStatus(result.failedFiles.length > 0
			? t('settings', 'fileTaskMigrationCompletedWithFailures', {
				converted: String(result.convertedFiles.length),
				failed: String(result.failedFiles.length),
			})
			: t('settings', 'fileTaskMigrationCompleted', { converted: String(result.convertedFiles.length) }));
	}
}
