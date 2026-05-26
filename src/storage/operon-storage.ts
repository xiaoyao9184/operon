/**
 * Operon storage manager.
 * Handles .operon/ data folder, JSON persistence, and settings.
 * Based on Spec Section 9.6 Storage Location Contract.
 */

import { App } from 'obsidian';
import { OperonSettings, DEFAULT_SETTINGS, migrateSettings } from '../types/settings';
import { IndexData } from '../types/fields';
import { WriteQueue } from './write-queue';
import { PinnedCache } from './pinned-cache';
import { RepeatSeriesStore } from './repeat-series-store';
import { ExternalCalendarCacheStore } from './external-calendar-cache';
import { FilterStore } from './filter-store';
import { PipelineStore, PipelineStoreSettings } from './pipeline-store';
import { CalendarPresetStore, CalendarPresetStoreSettings } from './calendar-preset-store';
import { KanbanPresetStore, KanbanPresetStoreSettings } from './kanban-preset-store';
import { KanbanOrderStore } from './kanban-order-store';
import { KeyMappingStore } from './key-mapping-store';
import { PriorityStore, PriorityStoreSettings } from './priority-store';
import { ExternalCalendarSourceStore } from './external-calendar-source-store';
import { ContextualMenuStore, ContextualMenuStoreSettings } from './contextual-menu-store';
import { TaskUiPreferenceStore, TaskUiPreferenceStoreSettings } from './task-ui-preference-store';
import { TaskCreationProfileStore, TaskCreationProfileStoreSettings } from './task-creation-profile-store';
import { TaskAutomationPolicyStore, TaskAutomationPolicyStoreSettings } from './task-automation-policy-store';
import { ActiveTrackerStore } from './active-tracker-store';
import { isRecord } from '../core/unknown-value';
import { enginePerfNow, WriteJsonMetrics } from '../core/engine-perf';
import { writeTextSafely, type RecoveredStoreWriteOptions } from './storage-file-ops';

const DATA_FOLDER = '.operon';
const SETTINGS_FILE = `${DATA_FOLDER}/settings.json`;
const INDEX_FILE = `${DATA_FOLDER}/index.json`;
const CACHE_FOLDER = `${DATA_FOLDER}/cache`;
const FILTERS_FOLDER = `${DATA_FOLDER}/filters`;
const PRIORITY_SETTINGS_KEYS = [
	'priorities',
	'defaultPriority',
] as const;
const PIPELINE_SETTINGS_KEYS = [
	'pipelines',
	'defaultPipelineName',
] as const;
const CALENDAR_PRESET_SETTINGS_KEYS = [
	'calendarPresets',
	'calendarDefaultPresetId',
] as const;
const KANBAN_PRESET_SETTINGS_KEYS = [
	'kanbanPresets',
	'kanbanDefaultPresetId',
] as const;
const CONTEXTUAL_MENU_SETTINGS_KEYS = [
	'contextualMenuActionAllowlist',
	'calendarHoverActionAllowlist',
	'contextualMenuSurfaceActionMatrix',
	'contextualMenuOpenDelayMs',
	'calendarHoverMenuOpenDelayMs',
] as const;
const TASK_UI_PREFERENCE_SETTINGS_KEYS = [
	'taskCreatorToolbar',
	'taskEditorWorkflowPickers',
	'inlineExpandedTaskChips',
	'inlineTaskCompactChips',
	'filterTaskCompactChips',
	'taskFinderCompactChips',
	'taskFinderDefaultScope',
	'taskFinderRememberLastScopes',
	'taskFinderSelectedProjectId',
	'taskFinderShortcuts',
	'overlayTaskCompactChips',
	'overlayTaskShowPlayAction',
	'overlayTaskShowPinAction',
	'overlayTaskShowNoteAction',
	'overlayTaskShowSubtaskAction',
	'inlineTaskShowPlayAction',
	'inlineTaskShowPinAction',
	'inlineTaskShowSubtaskAction',
	'filterTaskShowPlayAction',
	'filterTaskShowPinAction',
	'filterTaskShowSubtaskAction',
] as const;
const TASK_CREATION_PROFILE_SETTINGS_KEYS = [
	'taskDescriptionRequired',
	'assigneesRequired',
	'fileTasksFolder',
	'inlineTaskSaveMode',
	'inlineTaskUseDailyNote',
	'inlineTaskTargetFile',
	'inlineTaskHeading',
	'calendarInlineTaskHeading',
	'autoParentFileTask',
	'autoParentLinkedFileSubtasks',
	'fileTaskTemplateFolder',
	'createDailyNotesAsOperonTask',
	'defaultEstimateMinutes',
] as const;
const TASK_AUTOMATION_POLICY_SETTINGS_KEYS = [
	'autoCompleteParentWhenAllChildrenTerminal',
	'cascadeCancelToDescendants',
	'newOccurrencePosition',
	'fileTaskAutoArchiveEnabled',
	'fileTaskArchiveFolder',
	'fileTaskArchiveDelaySeconds',
	'fileTaskArchiveOnlyFromFileTasksFolder',
	'fileRepeatDestination',
	'fileRepeatCustomFolder',
	'estimateAutoReallocation',
	'trackerSplitSessionsAtMidnight',
] as const;
const LEGACY_AGENT_EXPORT_SETTINGS_KEYS = [
	'agentAllowlistFields',
	'agentDenylistFields',
	'agentExportFormat',
] as const;

function pickPipelineStoreSettings(settings: OperonSettings): PipelineStoreSettings {
	return {
		pipelines: settings.pipelines,
		defaultPipelineName: settings.defaultPipelineName,
	};
}

function pickCalendarPresetStoreSettings(settings: OperonSettings): CalendarPresetStoreSettings {
	return {
		calendarPresets: settings.calendarPresets,
		calendarDefaultPresetId: settings.calendarDefaultPresetId,
	};
}

function pickKanbanPresetStoreSettings(settings: OperonSettings): KanbanPresetStoreSettings {
	return {
		kanbanPresets: settings.kanbanPresets,
		kanbanDefaultPresetId: settings.kanbanDefaultPresetId,
	};
}

function pickPriorityStoreSettings(settings: OperonSettings): PriorityStoreSettings {
	return {
		priorities: settings.priorities,
		defaultPriority: settings.defaultPriority,
	};
}

function pickContextualMenuStoreSettings(settings: OperonSettings): ContextualMenuStoreSettings {
	return {
		contextualMenuActionAllowlist: settings.contextualMenuActionAllowlist,
		contextualMenuSurfaceActionMatrix: settings.contextualMenuSurfaceActionMatrix,
		contextualMenuOpenDelayMs: settings.contextualMenuOpenDelayMs,
	};
}

function pickTaskUiPreferenceStoreSettings(settings: OperonSettings): TaskUiPreferenceStoreSettings {
	return {
		taskCreatorToolbar: settings.taskCreatorToolbar,
		taskEditorWorkflowPickers: settings.taskEditorWorkflowPickers,
		inlineExpandedTaskChips: settings.inlineExpandedTaskChips,
		inlineTaskCompactChips: settings.inlineTaskCompactChips,
		filterTaskCompactChips: settings.filterTaskCompactChips,
		taskFinderCompactChips: settings.taskFinderCompactChips,
		taskFinderDefaultScope: settings.taskFinderDefaultScope,
		taskFinderRememberLastScopes: settings.taskFinderRememberLastScopes,
		taskFinderSelectedProjectId: settings.taskFinderSelectedProjectId,
		taskFinderShortcuts: settings.taskFinderShortcuts,
		overlayTaskCompactChips: settings.overlayTaskCompactChips,
		overlayTaskShowPlayAction: settings.overlayTaskShowPlayAction,
		overlayTaskShowPinAction: settings.overlayTaskShowPinAction,
		overlayTaskShowNoteAction: settings.overlayTaskShowNoteAction,
		overlayTaskShowSubtaskAction: settings.overlayTaskShowSubtaskAction,
		inlineTaskShowPlayAction: settings.inlineTaskShowPlayAction,
		inlineTaskShowPinAction: settings.inlineTaskShowPinAction,
		inlineTaskShowSubtaskAction: settings.inlineTaskShowSubtaskAction,
		filterTaskShowPlayAction: settings.filterTaskShowPlayAction,
		filterTaskShowPinAction: settings.filterTaskShowPinAction,
		filterTaskShowSubtaskAction: settings.filterTaskShowSubtaskAction,
	};
}

function pickTaskCreationProfileStoreSettings(settings: OperonSettings): TaskCreationProfileStoreSettings {
	return {
		taskDescriptionRequired: settings.taskDescriptionRequired,
		assigneesRequired: settings.assigneesRequired,
		fileTasksFolder: settings.fileTasksFolder,
		inlineTaskSaveMode: settings.inlineTaskSaveMode,
		inlineTaskUseDailyNote: settings.inlineTaskUseDailyNote,
		inlineTaskTargetFile: settings.inlineTaskTargetFile,
		inlineTaskHeading: settings.inlineTaskHeading,
		calendarInlineTaskHeading: settings.calendarInlineTaskHeading,
		autoParentFileTask: settings.autoParentFileTask,
		autoParentLinkedFileSubtasks: settings.autoParentLinkedFileSubtasks,
		fileTaskTemplateFolder: settings.fileTaskTemplateFolder,
		createDailyNotesAsOperonTask: settings.createDailyNotesAsOperonTask,
		defaultEstimateMinutes: settings.defaultEstimateMinutes,
	};
}

function pickTaskAutomationPolicyStoreSettings(settings: OperonSettings): TaskAutomationPolicyStoreSettings {
	return {
		autoCompleteParentWhenAllChildrenTerminal: settings.autoCompleteParentWhenAllChildrenTerminal,
		cascadeCancelToDescendants: settings.cascadeCancelToDescendants,
		newOccurrencePosition: settings.newOccurrencePosition,
		fileTaskAutoArchiveEnabled: settings.fileTaskAutoArchiveEnabled,
		fileTaskArchiveFolder: settings.fileTaskArchiveFolder,
		fileTaskArchiveDelaySeconds: settings.fileTaskArchiveDelaySeconds,
		fileTaskArchiveOnlyFromFileTasksFolder: settings.fileTaskArchiveOnlyFromFileTasksFolder,
		fileRepeatDestination: settings.fileRepeatDestination,
		fileRepeatCustomFolder: settings.fileRepeatCustomFolder,
		estimateAutoReallocation: settings.estimateAutoReallocation,
		trackerSplitSessionsAtMidnight: settings.trackerSplitSessionsAtMidnight,
	};
}

function hasAnyPersistedKey(source: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.some(key => key in source);
}

function hasLegacyTaskBarChipSettings(source: Record<string, unknown>): boolean {
	return !!source.taskBarChips
		&& typeof source.taskBarChips === 'object'
		&& !Array.isArray(source.taskBarChips);
}

export class OperonStorage {
	private app: App;
	private writeQueue: WriteQueue;
	private settings: OperonSettings;
	private loadedSettingsSource: Record<string, unknown> = {};
	private pinnedCache: PinnedCache;
	private repeatSeriesStore: RepeatSeriesStore;
	private externalCalendarCache: ExternalCalendarCacheStore;
	private filterStore: FilterStore;
	private pipelineStore: PipelineStore;
	private calendarPresetStore: CalendarPresetStore;
	private kanbanPresetStore: KanbanPresetStore;
	private kanbanOrderStore: KanbanOrderStore;
	private keyMappingStore: KeyMappingStore;
	private priorityStore: PriorityStore;
	private externalCalendarSourceStore: ExternalCalendarSourceStore;
	private contextualMenuStore: ContextualMenuStore;
	private taskUiPreferenceStore: TaskUiPreferenceStore;
	private taskCreationProfileStore: TaskCreationProfileStore;
	private taskAutomationPolicyStore: TaskAutomationPolicyStore;
	private activeTrackerStore: ActiveTrackerStore;

	constructor(app: App) {
		this.app = app;
		this.writeQueue = new WriteQueue();
		this.settings = { ...DEFAULT_SETTINGS };
		this.pinnedCache = new PinnedCache(app, this.writeQueue);
		this.repeatSeriesStore = new RepeatSeriesStore(app, this.writeQueue);
		this.externalCalendarCache = new ExternalCalendarCacheStore(app, this.writeQueue);
		this.filterStore = new FilterStore(app, this.writeQueue);
		this.pipelineStore = new PipelineStore(
			app,
			this.writeQueue,
			pickPipelineStoreSettings(DEFAULT_SETTINGS),
		);
		this.calendarPresetStore = new CalendarPresetStore(
			app,
			this.writeQueue,
			pickCalendarPresetStoreSettings(DEFAULT_SETTINGS),
		);
		this.kanbanPresetStore = new KanbanPresetStore(
			app,
			this.writeQueue,
			pickKanbanPresetStoreSettings(DEFAULT_SETTINGS),
		);
		this.kanbanOrderStore = new KanbanOrderStore(app, this.writeQueue);
		this.keyMappingStore = new KeyMappingStore(app, this.writeQueue);
		this.priorityStore = new PriorityStore(
			app,
			this.writeQueue,
			pickPriorityStoreSettings(DEFAULT_SETTINGS),
		);
		this.externalCalendarSourceStore = new ExternalCalendarSourceStore(app, this.writeQueue);
		this.contextualMenuStore = new ContextualMenuStore(
			app,
			this.writeQueue,
			pickContextualMenuStoreSettings(DEFAULT_SETTINGS),
		);
		this.taskUiPreferenceStore = new TaskUiPreferenceStore(
			app,
			this.writeQueue,
			pickTaskUiPreferenceStoreSettings(DEFAULT_SETTINGS),
		);
		this.taskCreationProfileStore = new TaskCreationProfileStore(
			app,
			this.writeQueue,
			pickTaskCreationProfileStoreSettings(DEFAULT_SETTINGS),
		);
		this.taskAutomationPolicyStore = new TaskAutomationPolicyStore(
			app,
			this.writeQueue,
			pickTaskAutomationPolicyStoreSettings(DEFAULT_SETTINGS),
		);
		this.activeTrackerStore = new ActiveTrackerStore(app, this.writeQueue);
	}

	/**
	 * Initialize storage: create data folder structure if needed, load settings.
	 */
	async initialize(): Promise<void> {
		await this.ensureDataFolder();
		const hadSettingsFile = await this.app.vault.adapter.exists(SETTINGS_FILE);
		await this.loadSettings();
		const hadPersistedKeyMappings = Array.isArray(this.loadedSettingsSource.keyMappings);
		const hadPersistedFilters = Array.isArray(this.loadedSettingsSource.filterSets);
		const hadPersistedPipelines = hasAnyPersistedKey(this.loadedSettingsSource, PIPELINE_SETTINGS_KEYS);
		const hadPersistedCalendarPresets = hasAnyPersistedKey(this.loadedSettingsSource, CALENDAR_PRESET_SETTINGS_KEYS);
		const hadPersistedKanbanPresets = hasAnyPersistedKey(this.loadedSettingsSource, KANBAN_PRESET_SETTINGS_KEYS);
		const hadPersistedPriorities = hasAnyPersistedKey(this.loadedSettingsSource, PRIORITY_SETTINGS_KEYS);
		const hadPersistedExternalCalendars = Array.isArray(this.loadedSettingsSource.externalCalendars);
		const hadPersistedContextualMenu = hasAnyPersistedKey(this.loadedSettingsSource, CONTEXTUAL_MENU_SETTINGS_KEYS);
		const hadPersistedTaskUiPreferenceKeys = hasAnyPersistedKey(this.loadedSettingsSource, TASK_UI_PREFERENCE_SETTINGS_KEYS);
		const hadPersistedTaskCreationProfile = hasAnyPersistedKey(this.loadedSettingsSource, TASK_CREATION_PROFILE_SETTINGS_KEYS);
		const hadPersistedTaskAutomationPolicy = hasAnyPersistedKey(this.loadedSettingsSource, TASK_AUTOMATION_POLICY_SETTINGS_KEYS);
		const hadLegacyAgentExportSettings = hasAnyPersistedKey(this.loadedSettingsSource, LEGACY_AGENT_EXPORT_SETTINGS_KEYS);
		const hadTaskUiPreferenceStore = await this.taskUiPreferenceStore.exists();
		const shouldSeedTaskUiPreferencesFromSettings = hadPersistedTaskUiPreferenceKeys
			|| (!hadTaskUiPreferenceStore && (hadSettingsFile || hasLegacyTaskBarChipSettings(this.loadedSettingsSource)));
		await this.keyMappingStore.load(hadPersistedKeyMappings ? this.settings.keyMappings : null, DEFAULT_SETTINGS.keyMappings);
		await this.filterStore.load(hadPersistedFilters ? this.settings.filterSets : []);
		if (!hadSettingsFile && !hadPersistedFilters && this.filterStore.getAll().length === 0) {
			await this.filterStore.replaceAll(DEFAULT_SETTINGS.filterSets);
		}
		await this.pipelineStore.load(
			hadPersistedPipelines ? pickPipelineStoreSettings(this.settings) : null,
			pickPipelineStoreSettings(DEFAULT_SETTINGS),
		);
		await this.calendarPresetStore.load(
			hadPersistedCalendarPresets ? pickCalendarPresetStoreSettings(this.settings) : null,
			pickCalendarPresetStoreSettings(DEFAULT_SETTINGS),
		);
		await this.kanbanPresetStore.load(
			hadPersistedKanbanPresets ? pickKanbanPresetStoreSettings(this.settings) : null,
			pickKanbanPresetStoreSettings(DEFAULT_SETTINGS),
		);
		await this.priorityStore.load(
			hadPersistedPriorities ? pickPriorityStoreSettings(this.settings) : null,
			pickPriorityStoreSettings(DEFAULT_SETTINGS),
		);
		await this.externalCalendarSourceStore.load(hadPersistedExternalCalendars ? this.settings.externalCalendars : null);
		await this.contextualMenuStore.load(
			hadPersistedContextualMenu ? pickContextualMenuStoreSettings(this.settings) : null,
			pickContextualMenuStoreSettings(DEFAULT_SETTINGS),
		);
		await this.taskUiPreferenceStore.load(
			shouldSeedTaskUiPreferencesFromSettings ? pickTaskUiPreferenceStoreSettings(this.settings) : null,
			pickTaskUiPreferenceStoreSettings(DEFAULT_SETTINGS),
		);
		await this.taskCreationProfileStore.load(
			hadPersistedTaskCreationProfile ? pickTaskCreationProfileStoreSettings(this.settings) : null,
			pickTaskCreationProfileStoreSettings(DEFAULT_SETTINGS),
		);
		await this.taskAutomationPolicyStore.load(
			hadPersistedTaskAutomationPolicy ? pickTaskAutomationPolicyStoreSettings(this.settings) : null,
			pickTaskAutomationPolicyStoreSettings(DEFAULT_SETTINGS),
		);
		this.settings.keyMappings = this.keyMappingStore.getAll();
		this.settings.filterSets = this.filterStore.getAll();
		Object.assign(this.settings, this.pipelineStore.getAll());
		Object.assign(this.settings, this.calendarPresetStore.getAll());
		Object.assign(this.settings, this.kanbanPresetStore.getAll());
		Object.assign(this.settings, this.priorityStore.getAll());
		this.settings.externalCalendars = this.externalCalendarSourceStore.getAll();
		Object.assign(this.settings, this.contextualMenuStore.getAll());
		Object.assign(this.settings, this.taskUiPreferenceStore.getAll());
		Object.assign(this.settings, this.taskCreationProfileStore.getAll());
		Object.assign(this.settings, this.taskAutomationPolicyStore.getAll());
		this.settings = migrateSettings(this.settings);
		await this.keyMappingStore.replaceAll(this.settings.keyMappings);
		await this.pipelineStore.replaceAll(pickPipelineStoreSettings(this.settings));
		await this.calendarPresetStore.replaceAll(pickCalendarPresetStoreSettings(this.settings));
		await this.kanbanPresetStore.replaceAll(pickKanbanPresetStoreSettings(this.settings));
		await this.priorityStore.replaceAll(pickPriorityStoreSettings(this.settings));
		await this.externalCalendarSourceStore.replaceAll(this.settings.externalCalendars);
		await this.contextualMenuStore.replaceAll(pickContextualMenuStoreSettings(this.settings));
		await this.taskUiPreferenceStore.replaceAll(pickTaskUiPreferenceStoreSettings(this.settings));
		await this.taskCreationProfileStore.replaceAll(pickTaskCreationProfileStoreSettings(this.settings));
		await this.taskAutomationPolicyStore.replaceAll(pickTaskAutomationPolicyStoreSettings(this.settings));
		if (
			hadPersistedKeyMappings
			|| hadPersistedFilters
			|| hadPersistedPipelines
			|| hadPersistedCalendarPresets
			|| hadPersistedKanbanPresets
			|| hadPersistedPriorities
			|| hadPersistedExternalCalendars
			|| hadPersistedContextualMenu
			|| hadPersistedTaskUiPreferenceKeys
			|| shouldSeedTaskUiPreferencesFromSettings
			|| hadPersistedTaskCreationProfile
			|| hadPersistedTaskAutomationPolicy
			|| hadLegacyAgentExportSettings
		) {
			await this.saveSettings({ forceRecoveredWrite: false });
		}
		await this.pinnedCache.load();
		await this.activeTrackerStore.load();
		await this.repeatSeriesStore.load();
		await this.externalCalendarCache.load();
		await this.kanbanOrderStore.load();
	}

	/**
	 * Ensure the .operon/ directory structure exists.
	 */
	private async ensureDataFolder(): Promise<void> {
		const adapter = this.app.vault.adapter;

		for (const folder of [DATA_FOLDER, CACHE_FOLDER, FILTERS_FOLDER]) {
			if (!(await adapter.exists(folder))) {
				await adapter.mkdir(folder);
			}
		}
	}

	// --- Settings ---

	/**
	 * Load settings from .operon/settings.json, migrating if needed.
	 */
	async loadSettings(): Promise<OperonSettings> {
		const adapter = this.app.vault.adapter;

		if (await adapter.exists(SETTINGS_FILE)) {
			try {
				const raw = await adapter.read(SETTINGS_FILE);
				const parsed: unknown = JSON.parse(raw);
				this.loadedSettingsSource = isRecord(parsed) ? parsed : {};
				this.settings = migrateSettings(parsed);
			} catch {
				console.warn('Operon: Failed to parse settings, using defaults');
				this.loadedSettingsSource = {};
				this.settings = { ...DEFAULT_SETTINGS };
			}
		} else {
			this.loadedSettingsSource = {};
			this.settings = { ...DEFAULT_SETTINGS };
		}

		return this.settings;
	}

	/**
	 * Save current settings to .operon/settings.json.
	 */
	async saveSettings(options: RecoveredStoreWriteOptions = { forceRecoveredWrite: true }): Promise<void> {
		const normalized = migrateSettings(this.settings);
		this.applySettingsInPlace(normalized);
		const recoveredWriteOptions = options;
		await this.keyMappingStore.replaceAll(this.settings.keyMappings, recoveredWriteOptions);
		await this.pipelineStore.replaceAll(pickPipelineStoreSettings(this.settings), recoveredWriteOptions);
		await this.calendarPresetStore.replaceAll(pickCalendarPresetStoreSettings(this.settings), recoveredWriteOptions);
		await this.kanbanPresetStore.replaceAll(pickKanbanPresetStoreSettings(this.settings), recoveredWriteOptions);
		await this.priorityStore.replaceAll(pickPriorityStoreSettings(this.settings), recoveredWriteOptions);
		await this.externalCalendarSourceStore.replaceAll(this.settings.externalCalendars, recoveredWriteOptions);
		await this.contextualMenuStore.replaceAll(pickContextualMenuStoreSettings(this.settings), recoveredWriteOptions);
		await this.taskUiPreferenceStore.replaceAll(pickTaskUiPreferenceStoreSettings(this.settings), recoveredWriteOptions);
		await this.taskCreationProfileStore.replaceAll(pickTaskCreationProfileStoreSettings(this.settings), recoveredWriteOptions);
		await this.taskAutomationPolicyStore.replaceAll(pickTaskAutomationPolicyStoreSettings(this.settings), recoveredWriteOptions);
		const persistedSettings = { ...this.settings } as Partial<OperonSettings>;
		delete persistedSettings.keyMappings;
		delete persistedSettings.filterSets;
		delete persistedSettings.pipelines;
		delete persistedSettings.defaultPipelineName;
		delete persistedSettings.calendarPresets;
		delete persistedSettings.calendarDefaultPresetId;
		delete persistedSettings.kanbanPresets;
		delete persistedSettings.kanbanDefaultPresetId;
		delete persistedSettings.priorities;
		delete persistedSettings.defaultPriority;
		delete persistedSettings.externalCalendars;
		delete persistedSettings.contextualMenuActionAllowlist;
		delete persistedSettings.contextualMenuSurfaceActionMatrix;
		delete persistedSettings.contextualMenuOpenDelayMs;
		delete persistedSettings.taskCreatorToolbar;
		delete persistedSettings.taskEditorWorkflowPickers;
		delete persistedSettings.inlineExpandedTaskChips;
		delete persistedSettings.inlineTaskCompactChips;
		delete persistedSettings.filterTaskCompactChips;
		delete persistedSettings.taskFinderCompactChips;
		delete persistedSettings.taskFinderDefaultScope;
		delete persistedSettings.taskFinderRememberLastScopes;
		delete persistedSettings.taskFinderSelectedProjectId;
		delete persistedSettings.taskFinderShortcuts;
		delete persistedSettings.overlayTaskCompactChips;
		delete persistedSettings.overlayTaskShowPlayAction;
		delete persistedSettings.overlayTaskShowPinAction;
		delete persistedSettings.overlayTaskShowNoteAction;
		delete persistedSettings.overlayTaskShowSubtaskAction;
		delete persistedSettings.inlineTaskShowPlayAction;
		delete persistedSettings.inlineTaskShowPinAction;
		delete persistedSettings.inlineTaskShowSubtaskAction;
		delete persistedSettings.filterTaskShowPlayAction;
		delete persistedSettings.filterTaskShowPinAction;
		delete persistedSettings.filterTaskShowSubtaskAction;
		delete (persistedSettings as Record<string, unknown>).taskBarChips;
		delete persistedSettings.taskDescriptionRequired;
		delete persistedSettings.assigneesRequired;
		delete persistedSettings.fileTasksFolder;
		delete persistedSettings.inlineTaskSaveMode;
		delete persistedSettings.inlineTaskUseDailyNote;
		delete persistedSettings.inlineTaskTargetFile;
		delete persistedSettings.inlineTaskHeading;
		delete persistedSettings.calendarInlineTaskHeading;
		delete persistedSettings.autoParentFileTask;
		delete persistedSettings.autoParentLinkedFileSubtasks;
		delete persistedSettings.fileTaskTemplateFolder;
		delete persistedSettings.createDailyNotesAsOperonTask;
		delete persistedSettings.defaultEstimateMinutes;
		delete persistedSettings.autoCompleteParentWhenAllChildrenTerminal;
		delete persistedSettings.cascadeCancelToDescendants;
		delete persistedSettings.newOccurrencePosition;
		delete persistedSettings.fileTaskAutoArchiveEnabled;
		delete persistedSettings.fileTaskArchiveFolder;
		delete persistedSettings.fileTaskArchiveDelaySeconds;
		delete persistedSettings.fileTaskArchiveOnlyFromFileTasksFolder;
		delete persistedSettings.fileRepeatDestination;
		delete persistedSettings.fileRepeatCustomFolder;
		delete persistedSettings.estimateAutoReallocation;
		delete persistedSettings.trackerSplitSessionsAtMidnight;
		delete (persistedSettings as Record<string, unknown>).draftDiscardIfEmpty;
		delete (persistedSettings as Record<string, unknown>).inlineParentDefaultExpanded;
		delete (persistedSettings as Record<string, unknown>).inlineQuickActionsEnabled;
		delete (persistedSettings as Record<string, unknown>).inlineQuickActionAllowlist;
		delete (persistedSettings as Record<string, unknown>).agentAllowlistFields;
		delete (persistedSettings as Record<string, unknown>).agentDenylistFields;
		delete (persistedSettings as Record<string, unknown>).agentExportFormat;
		this.loadedSettingsSource = persistedSettings;
		await this.writeJson(SETTINGS_FILE, persistedSettings);
	}

	/**
	 * Get current settings (in-memory).
	 */
	getSettings(): OperonSettings {
		return this.settings;
	}

	/**
	 * Update settings and persist.
	 */
	async updateSettings(partial: Partial<OperonSettings>): Promise<void> {
		Object.assign(this.settings, partial);
		await this.saveSettings();
	}

	private applySettingsInPlace(normalized: OperonSettings): void {
		const target = this.settings as unknown as Record<string, unknown>;
		const source = normalized as unknown as Record<string, unknown>;
		for (const key of Object.keys(normalized)) {
			target[key] = source[key];
		}
	}

	// --- Index ---

	/**
	 * Load active task index from .operon/index.json.
	 */
	async loadIndex(): Promise<IndexData | null> {
		return this.readJson<IndexData>(INDEX_FILE);
	}

	/**
	 * Save active task index to .operon/index.json (atomic write).
	 */
	async saveIndex(data: IndexData): Promise<WriteJsonMetrics> {
		return await this.writeJson(INDEX_FILE, data);
	}

	// --- Generic JSON I/O ---

	/**
	 * Read and parse a JSON file. Returns null if file doesn't exist or parse fails.
	 */
	private async readJson<T>(path: string): Promise<T | null> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(path))) return null;

		try {
			const raw = await adapter.read(path);
			return JSON.parse(raw) as T;
		} catch {
			console.warn(`Operon: Failed to parse ${path}`);
			return null;
		}
	}

	/**
	 * Write data as JSON to a file. Uses write queue for atomic writes.
	 */
	private async writeJson<T>(path: string, data: T): Promise<WriteJsonMetrics> {
		const totalStartedAt = enginePerfNow();
		let metrics: WriteJsonMetrics | null = null;
		await this.writeQueue.enqueue(path, async () => {
			const operationStartedAt = enginePerfNow();
			const stringifyStartedAt = enginePerfNow();
			const json = JSON.stringify(data, null, '\t');
			const stringifyMs = enginePerfNow() - stringifyStartedAt;
			const writeStartedAt = enginePerfNow();
			await writeTextSafely(this.app.vault.adapter, path, json);
			const writeMs = enginePerfNow() - writeStartedAt;
			metrics = {
				jsonBytes: this.getJsonByteLength(json),
				stringifyMs,
				writeMs,
				queueWaitMs: operationStartedAt - totalStartedAt,
				totalMs: enginePerfNow() - totalStartedAt,
			};
		});
		return metrics ?? {
			jsonBytes: 0,
			stringifyMs: 0,
			writeMs: 0,
			queueWaitMs: 0,
			totalMs: enginePerfNow() - totalStartedAt,
		};
	}

	private getJsonByteLength(json: string): number {
		if (typeof TextEncoder !== 'undefined') {
			return new TextEncoder().encode(json).length;
		}
		return json.length;
	}

	// --- Paths ---

	get dataFolder(): string { return DATA_FOLDER; }
	get settingsPath(): string { return SETTINGS_FILE; }
	get indexPath(): string { return INDEX_FILE; }
	get pinned(): PinnedCache { return this.pinnedCache; }
	get activeTrackers(): ActiveTrackerStore { return this.activeTrackerStore; }
	get repeatSeries(): RepeatSeriesStore { return this.repeatSeriesStore; }
	get externalCalendars(): ExternalCalendarCacheStore { return this.externalCalendarCache; }
	get externalCalendarSources(): ExternalCalendarSourceStore { return this.externalCalendarSourceStore; }
	get filters(): FilterStore { return this.filterStore; }
	get pipelines(): PipelineStore { return this.pipelineStore; }
	get calendarPresets(): CalendarPresetStore { return this.calendarPresetStore; }
	get kanbanPresets(): KanbanPresetStore { return this.kanbanPresetStore; }
	get kanbanOrder(): KanbanOrderStore { return this.kanbanOrderStore; }
	get keyMappings(): KeyMappingStore { return this.keyMappingStore; }
	get priorities(): PriorityStore { return this.priorityStore; }

	async flushPendingWrites(): Promise<void> {
		const storeDrainResults = await Promise.allSettled([
			this.pinnedCache.drain(),
			this.activeTrackerStore.drain(),
			this.repeatSeriesStore.drain(),
			this.externalCalendarCache.drain(),
		]);
		await this.writeQueue.drain();
		const failedDrain = storeDrainResults.find(result => result.status === 'rejected');
		if (failedDrain?.status === 'rejected') {
			throw failedDrain.reason;
		}
	}

	/**
	 * Cleanup on plugin unload.
	 */
	destroy(): void {
		this.writeQueue.clear();
	}
}
