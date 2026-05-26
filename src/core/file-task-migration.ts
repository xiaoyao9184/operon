import { App, parseYaml, TFile } from 'obsidian';
import { OperonSettings } from '../types/settings';
import { generateOperonId } from './id-generator';
import { localNow } from './local-time';
import { isOperonExcludedPath, isPathInsideFolder } from './operon-path-exclusions';
import { normalizeSettingsFolderPath } from './settings-folder-rules';
import { getManagedYamlAliases, getVisiblePropertyName } from './yaml-fields';

export type FileTaskMigrationRuleType = 'folder' | 'tag' | 'property';

export type FileTaskMigrationRule =
	| { type: 'folder'; folderPath: string }
	| { type: 'tag'; tag: string }
	| { type: 'property'; propertyKey: string; propertyValue: string };

export interface FileTaskMigrationScanResult {
	rule: FileTaskMigrationRule;
	totalMatchedCount: number;
	convertibleFiles: TFile[];
	convertibleSnapshots: FileTaskMigrationFileSnapshot[];
	alreadyFileTaskFiles: TFile[];
	excludedFiles: TFile[];
}

export interface FileTaskMigrationFileSnapshot {
	path: string;
	mtime: number;
	size: number;
}

export type FileTaskMigrationAbortReason = 'scanChanged' | 'fileChanged';

export interface FileTaskMigrationValidationResult {
	valid: boolean;
	currentScan: FileTaskMigrationScanResult;
	abortedReason?: FileTaskMigrationAbortReason;
	changedPaths: string[];
}

export interface FileTaskMigrationApplyResult {
	convertedFiles: string[];
	skippedExistingFiles: string[];
	failedFiles: Array<{ path: string; message: string }>;
	abortedReason?: FileTaskMigrationAbortReason;
	currentScan?: FileTaskMigrationScanResult;
	changedPaths?: string[];
}

export interface FileTaskMigrationProgress {
	totalEligible: number;
	remainingEligible: number;
	converted: number;
	skippedExisting: number;
	failed: number;
	currentPath?: string;
}

export interface FileTaskMigrationApplyOptions {
	now?: () => string;
	generateId?: () => string;
	onProgress?: (progress: FileTaskMigrationProgress) => void;
}

interface CachedMetadataLike {
	frontmatter?: Record<string, unknown>;
	tags?: Array<{ tag?: string }>;
}

function getFileCache(app: App, file: TFile): CachedMetadataLike | null {
	return app.metadataCache.getFileCache(file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeScalarValue(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
	return null;
}

function collectScalarValues(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map(item => normalizeScalarValue(item))
			.filter((item): item is string => !!item);
	}
	const scalar = normalizeScalarValue(value);
	return scalar ? [scalar] : [];
}

export function normalizeFileTaskMigrationTag(value: string): string {
	return value.trim().replace(/^#/, '');
}

function hasNonEmptyMappedValue(
	frontmatter: Record<string, unknown> | undefined,
	canonicalKey: string,
	settings: OperonSettings,
): boolean {
	if (!frontmatter) return false;
	for (const yamlKey of getManagedYamlAliases(canonicalKey, settings.keyMappings)) {
		if (!Object.prototype.hasOwnProperty.call(frontmatter, yamlKey)) continue;
		const values = collectScalarValues(frontmatter[yamlKey]);
		if (values.some(value => value.length > 0)) return true;
	}
	return false;
}

function writeMappedValue(
	frontmatter: Record<string, unknown>,
	canonicalKey: string,
	value: string,
	settings: OperonSettings,
): void {
	const preferredKey = getVisiblePropertyName(canonicalKey, settings.keyMappings);
	frontmatter[preferredKey] = value;
}

function matchesFolderRule(file: TFile, folderPath: string): boolean {
	const normalizedFolderPath = normalizeSettingsFolderPath(folderPath);
	return !!normalizedFolderPath && isPathInsideFolder(file.path, normalizedFolderPath);
}

function collectFileTags(app: App, file: TFile): string[] {
	const cache = getFileCache(app, file);
	const tags = new Set<string>();
	for (const tagCache of cache?.tags ?? []) {
		const normalized = normalizeFileTaskMigrationTag(tagCache.tag ?? '');
		if (normalized) tags.add(normalized);
	}
	const frontmatterTags = cache?.frontmatter?.['tags'];
	for (const tag of collectScalarValues(frontmatterTags)) {
		const normalized = normalizeFileTaskMigrationTag(tag);
		if (normalized) tags.add(normalized);
	}
	return Array.from(tags);
}

function matchesTagRule(app: App, file: TFile, tag: string): boolean {
	const normalizedTarget = normalizeFileTaskMigrationTag(tag);
	if (!normalizedTarget) return false;
	return collectFileTags(app, file).some(candidate => candidate === normalizedTarget);
}

function matchesPropertyRule(app: App, file: TFile, propertyKey: string, propertyValue: string): boolean {
	const key = propertyKey.trim();
	const target = propertyValue.trim();
	if (!key || !target) return false;
	const frontmatter = getFileCache(app, file)?.frontmatter;
	if (!frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, key)) return false;
	return collectScalarValues(frontmatter[key]).some(value => value === target);
}

function matchesMigrationRule(app: App, file: TFile, rule: FileTaskMigrationRule): boolean {
	if (rule.type === 'folder') return matchesFolderRule(file, rule.folderPath);
	if (rule.type === 'tag') return matchesTagRule(app, file, rule.tag);
	return matchesPropertyRule(app, file, rule.propertyKey, rule.propertyValue);
}

function createFileSnapshot(file: TFile): FileTaskMigrationFileSnapshot {
	return {
		path: file.path,
		mtime: file.stat?.mtime ?? 0,
		size: file.stat?.size ?? 0,
	};
}

function pathCategoryMap(scan: FileTaskMigrationScanResult): Map<string, string> {
	const categories = new Map<string, string>();
	for (const file of scan.convertibleFiles) categories.set(file.path, 'convertible');
	for (const file of scan.alreadyFileTaskFiles) categories.set(file.path, 'already');
	for (const file of scan.excludedFiles) categories.set(file.path, 'excluded');
	return categories;
}

function collectCategoryChangedPaths(
	previous: FileTaskMigrationScanResult,
	current: FileTaskMigrationScanResult,
): string[] {
	const previousCategories = pathCategoryMap(previous);
	const currentCategories = pathCategoryMap(current);
	const paths = new Set<string>([
		...previousCategories.keys(),
		...currentCategories.keys(),
	]);
	const changed: string[] = [];
	for (const path of paths) {
		if (previousCategories.get(path) !== currentCategories.get(path)) {
			changed.push(path);
		}
	}
	return changed.sort((left, right) => left.localeCompare(right));
}

function collectSnapshotChangedPaths(
	previous: FileTaskMigrationScanResult,
	current: FileTaskMigrationScanResult,
): string[] {
	const previousSnapshots = new Map(previous.convertibleSnapshots.map(snapshot => [snapshot.path, snapshot]));
	const changed: string[] = [];
	for (const currentSnapshot of current.convertibleSnapshots) {
		const previousSnapshot = previousSnapshots.get(currentSnapshot.path);
		if (!previousSnapshot) {
			changed.push(currentSnapshot.path);
			continue;
		}
		if (previousSnapshot.mtime !== currentSnapshot.mtime || previousSnapshot.size !== currentSnapshot.size) {
			changed.push(currentSnapshot.path);
		}
	}
	return changed.sort((left, right) => left.localeCompare(right));
}

export function scanFileTaskMigration(
	app: App,
	settings: OperonSettings,
	rule: FileTaskMigrationRule,
): FileTaskMigrationScanResult {
	const convertibleFiles: TFile[] = [];
	const alreadyFileTaskFiles: TFile[] = [];
	const excludedFiles: TFile[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		if (!matchesMigrationRule(app, file, rule)) continue;
		if (isOperonExcludedPath(file.path, settings)) {
			excludedFiles.push(file);
			continue;
		}
		if (hasNonEmptyMappedValue(getFileCache(app, file)?.frontmatter, 'operonId', settings)) {
			alreadyFileTaskFiles.push(file);
			continue;
		}
		convertibleFiles.push(file);
	}

	const byPath = (left: TFile, right: TFile): number => left.path.localeCompare(right.path);
	convertibleFiles.sort(byPath);
	alreadyFileTaskFiles.sort(byPath);
	excludedFiles.sort(byPath);
	const convertibleSnapshots = convertibleFiles.map(createFileSnapshot);

	return {
		rule,
		totalMatchedCount: convertibleFiles.length + alreadyFileTaskFiles.length + excludedFiles.length,
		convertibleFiles,
		convertibleSnapshots,
		alreadyFileTaskFiles,
		excludedFiles,
	};
}

export function validateFileTaskMigrationScan(
	app: App,
	settings: OperonSettings,
	scanResult: FileTaskMigrationScanResult,
): FileTaskMigrationValidationResult {
	const currentScan = scanFileTaskMigration(app, settings, scanResult.rule);
	const categoryChangedPaths = collectCategoryChangedPaths(scanResult, currentScan);
	if (categoryChangedPaths.length > 0) {
		return {
			valid: false,
			currentScan,
			abortedReason: 'scanChanged',
			changedPaths: categoryChangedPaths,
		};
	}
	const snapshotChangedPaths = collectSnapshotChangedPaths(scanResult, currentScan);
	if (snapshotChangedPaths.length > 0) {
		return {
			valid: false,
			currentScan,
			abortedReason: 'fileChanged',
			changedPaths: snapshotChangedPaths,
		};
	}
	return {
		valid: true,
		currentScan,
		changedPaths: [],
	};
}

function generateUniqueMigrationId(options: FileTaskMigrationApplyOptions, usedIds: Set<string>): string {
	const generate = options.generateId ?? generateOperonId;
	for (let attempt = 0; attempt < 100; attempt++) {
		const next = generate();
		if (usedIds.has(next)) continue;
		usedIds.add(next);
		return next;
	}
	throw new Error('Failed to generate unique migration operonId after 100 attempts');
}

function resolveMarkdownFileByPath(app: App, path: string): TFile | null {
	const vaultWithPathLookup = app.vault as unknown as { getAbstractFileByPath?: (path: string) => unknown };
	const abstractFile: unknown = vaultWithPathLookup.getAbstractFileByPath
		? vaultWithPathLookup.getAbstractFileByPath(path)
		: null;
	if (abstractFile instanceof TFile) return abstractFile;
	return app.vault.getMarkdownFiles().find(file => file.path === path) ?? null;
}

async function readFrontmatterFromDisk(app: App, file: TFile): Promise<Record<string, unknown> | undefined> {
	const content = await app.vault.read(file);
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) return undefined;
	try {
		const parsed: unknown = parseYaml(match[1]);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function applyFileTaskMigration(
	app: App,
	settings: OperonSettings,
	scanResult: FileTaskMigrationScanResult,
	options: FileTaskMigrationApplyOptions = {},
): Promise<FileTaskMigrationApplyResult> {
	const convertedFiles: string[] = [];
	const skippedExistingFiles: string[] = [];
	const failedFiles: Array<{ path: string; message: string }> = [];
	const usedIds = new Set<string>();
	const validation = validateFileTaskMigrationScan(app, settings, scanResult);
	if (!validation.valid) {
		return {
			convertedFiles,
			skippedExistingFiles,
			failedFiles,
			abortedReason: validation.abortedReason,
			currentScan: validation.currentScan,
			changedPaths: validation.changedPaths,
		};
	}
	const totalEligible = validation.currentScan.convertibleSnapshots.length;
	const notifyProgress = (currentPath?: string): void => {
		options.onProgress?.({
			totalEligible,
			remainingEligible: Math.max(0, totalEligible - convertedFiles.length - skippedExistingFiles.length - failedFiles.length),
			converted: convertedFiles.length,
			skippedExisting: skippedExistingFiles.length,
			failed: failedFiles.length,
			currentPath,
		});
	};

	for (const snapshot of validation.currentScan.convertibleSnapshots) {
		const file = resolveMarkdownFileByPath(app, snapshot.path);
		if (!file) {
			failedFiles.push({
				path: snapshot.path,
				message: 'File no longer exists',
			});
			notifyProgress(snapshot.path);
			continue;
		}

		try {
			const diskFrontmatter = await readFrontmatterFromDisk(app, file);
			if (hasNonEmptyMappedValue(diskFrontmatter, 'operonId', settings)) {
				skippedExistingFiles.push(file.path);
				notifyProgress(file.path);
				continue;
			}
		} catch (error) {
			failedFiles.push({
				path: file.path,
				message: error instanceof Error ? error.message : String(error),
			});
			notifyProgress(file.path);
			continue;
		}

		const nextOperonId = generateUniqueMigrationId(options, usedIds);
		const timestamp = options.now?.() ?? localNow();
		let foundExistingDuringWrite = false;

		try {
			await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				if (hasNonEmptyMappedValue(frontmatter, 'operonId', settings)) {
					foundExistingDuringWrite = true;
					return;
				}
				writeMappedValue(frontmatter, 'operonId', nextOperonId, settings);
				writeMappedValue(frontmatter, 'datetimeModified', timestamp, settings);
			});
			if (foundExistingDuringWrite) {
				skippedExistingFiles.push(file.path);
			} else {
				convertedFiles.push(file.path);
			}
			notifyProgress(file.path);
		} catch (error) {
			failedFiles.push({
				path: file.path,
				message: error instanceof Error ? error.message : String(error),
			});
			notifyProgress(file.path);
		}
	}

	return {
		convertedFiles,
		skippedExistingFiles,
		failedFiles,
	};
}

export function collectFileTaskMigrationTagCandidates(app: App): string[] {
	const tagSource = (app.metadataCache as unknown as { getTags?: () => Record<string, number> }).getTags?.() ?? {};
	return Object.keys(tagSource)
		.map(normalizeFileTaskMigrationTag)
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

export function collectFileTaskMigrationPropertyKeyCandidates(app: App): string[] {
	const values = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		const frontmatter = getFileCache(app, file)?.frontmatter;
		if (!frontmatter) continue;
		for (const key of Object.keys(frontmatter)) {
			if (key === 'position') continue;
			values.add(key);
		}
	}
	return Array.from(values).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

export function collectFileTaskMigrationPropertyValueCandidates(app: App, propertyKey: string): string[] {
	const key = propertyKey.trim();
	if (!key) return [];
	const values = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		const frontmatter = getFileCache(app, file)?.frontmatter;
		if (!frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, key)) continue;
		for (const value of collectScalarValues(frontmatter[key])) {
			if (value) values.add(value);
		}
	}
	return Array.from(values).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}
