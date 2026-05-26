import { App, TFile, TFolder } from 'obsidian';
import type { OperonIndexer } from '../indexer/indexer';
import { clearWindowTimeout, setWindowTimeout, type WindowTimeoutHandle } from '../core/dom-compat';
import { normalizeSettingsFolderPath } from '../core/settings-folder-rules';
import type { IndexedTask } from '../types/fields';
import type { OperonSettings } from '../types/settings';

interface PendingArchive {
	timer: WindowTimeoutHandle;
}

interface FileTaskArchiverOptions {
	isTaskActive?: (operonId: string) => boolean;
}

export class FileTaskArchiver {
	private static readonly MAX_RENAME_ATTEMPTS = 5;

	private readonly app: App;
	private readonly indexer: OperonIndexer;
	private readonly getSettings: () => OperonSettings;
	private readonly isTaskActive: (operonId: string) => boolean;
	private readonly pendingByTaskId = new Map<string, PendingArchive>();

	constructor(
		app: App,
		indexer: OperonIndexer,
		getSettings: () => OperonSettings,
		options: FileTaskArchiverOptions = {},
	) {
		this.app = app;
		this.indexer = indexer;
		this.getSettings = getSettings;
		this.isTaskActive = options.isTaskActive ?? (() => false);
	}

	scheduleForIndexedChange(beforeTask: IndexedTask | null, afterTask: IndexedTask | null): void {
		if (!afterTask) {
			if (beforeTask) this.cancelPending(beforeTask.operonId);
			return;
		}

		if (!this.isEligible(afterTask)) {
			this.cancelPending(afterTask.operonId);
			return;
		}

		const nextSignature = this.buildTriggerSignature(afterTask);
		if (beforeTask && this.buildTriggerSignature(beforeTask) === nextSignature) return;

		this.cancelPending(afterTask.operonId);
		const delayMs = Math.max(0, Math.round(this.getSettings().fileTaskArchiveDelaySeconds) * 1000);
		const timer = setWindowTimeout(() => {
			this.pendingByTaskId.delete(afterTask.operonId);
			void this.archiveIfStillEligible(afterTask.operonId, nextSignature);
		}, delayMs);
		this.pendingByTaskId.set(afterTask.operonId, { timer });
	}

	destroy(): void {
		for (const pending of this.pendingByTaskId.values()) {
			clearWindowTimeout(pending.timer);
		}
		this.pendingByTaskId.clear();
	}

	private async archiveIfStillEligible(operonId: string, expectedSignature: string): Promise<void> {
		const task = this.indexer.getTask(operonId);
		if (!task) return;
		if (!this.isEligible(task)) return;
		if (this.buildTriggerSignature(task) !== expectedSignature) return;

		const sourceFile = this.app.vault.getAbstractFileByPath(task.primary.filePath);
		if (!(sourceFile instanceof TFile) || sourceFile.extension !== 'md') return;

		const archiveFolder = normalizeSettingsFolderPath(this.getSettings().fileTaskArchiveFolder);
		if (!archiveFolder) return;

		try {
			await this.ensureFolderExists(archiveFolder);
			await this.moveToUniqueArchivePath(sourceFile, archiveFolder);
		} catch (error) {
			console.warn('Operon: failed to archive file task', task.operonId, error);
		}
	}

	private isEligible(task: IndexedTask): boolean {
		const settings = this.getSettings();
		if (!settings.fileTaskAutoArchiveEnabled) return false;
		if (task.primary.format !== 'yaml') return false;
		if (!this.isTerminal(task)) return false;
		if (this.isTaskActive(task.operonId)) return false;
		const archiveFolder = normalizeSettingsFolderPath(settings.fileTaskArchiveFolder);
		if (!archiveFolder) return false;
		if (this.isPathInsideFolder(task.primary.filePath, archiveFolder)) return false;
		if (settings.fileTaskArchiveOnlyFromFileTasksFolder) {
			const fileTasksFolder = normalizeSettingsFolderPath(settings.fileTasksFolder);
			if (fileTasksFolder && !this.isPathInsideFolder(task.primary.filePath, fileTasksFolder)) return false;
		}
		return true;
	}

	private isTerminal(task: IndexedTask): boolean {
		return task.checkbox === 'done'
			|| task.checkbox === 'cancelled'
			|| !!(task.fieldValues['dateCompleted'] ?? '').trim()
			|| !!(task.fieldValues['dateCancelled'] ?? '').trim();
	}

	private buildTriggerSignature(task: IndexedTask): string {
		return [
			task.primary.filePath,
			task.checkbox,
			task.fieldValues['status'] ?? '',
			task.fieldValues['dateCompleted'] ?? '',
			task.fieldValues['dateCancelled'] ?? '',
		].join('|');
	}

	private cancelPending(operonId: string): void {
		const pending = this.pendingByTaskId.get(operonId);
		if (!pending) return;
		clearWindowTimeout(pending.timer);
		this.pendingByTaskId.delete(operonId);
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) return;

		const parts = folderPath.split('/').filter(Boolean);
		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const node = this.app.vault.getAbstractFileByPath(currentPath);
			if (node instanceof TFolder) continue;
			if (node) {
				throw new Error(`Cannot create archive folder "${currentPath}" because a file exists at this path`);
			}
			try {
				await this.app.vault.createFolder(currentPath);
			} catch (error) {
				const retryNode = this.app.vault.getAbstractFileByPath(currentPath);
				if (retryNode instanceof TFolder) continue;
				if (await this.app.vault.adapter.exists(currentPath)) continue;
				throw error;
			}
		}
	}

	private async moveToUniqueArchivePath(sourceFile: TFile, archiveFolder: string): Promise<void> {
		for (let attempt = 0; attempt < FileTaskArchiver.MAX_RENAME_ATTEMPTS; attempt += 1) {
			const targetPath = this.getUniqueArchivePath(archiveFolder, sourceFile.basename);
			if (targetPath === sourceFile.path) return;
			try {
				await this.app.fileManager.renameFile(sourceFile, targetPath);
				return;
			} catch (error) {
				const targetExists = !!this.app.vault.getAbstractFileByPath(targetPath);
				const sourceStillExists = this.app.vault.getAbstractFileByPath(sourceFile.path) instanceof TFile;
				if (!targetExists || !sourceStillExists || attempt === FileTaskArchiver.MAX_RENAME_ATTEMPTS - 1) {
					throw error;
				}
			}
		}
	}

	private getUniqueArchivePath(folderPath: string, basename: string): string {
		let candidate = `${folderPath}/${basename}.md`;
		let index = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${folderPath}/${basename} (${index}).md`;
			index += 1;
		}
		return candidate;
	}

	private isPathInsideFolder(filePath: string, folderPath: string): boolean {
		const normalizedFilePath = filePath.trim().replace(/^\/+/, '').toLowerCase();
		const normalizedFolderPath = normalizeSettingsFolderPath(folderPath).toLowerCase();
		if (!normalizedFilePath || !normalizedFolderPath) return false;
		return normalizedFilePath === normalizedFolderPath
			|| normalizedFilePath.startsWith(`${normalizedFolderPath}/`);
	}
}
