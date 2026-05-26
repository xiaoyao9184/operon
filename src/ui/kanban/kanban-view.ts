import { ItemView, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import { getSchemePalette, isLightScheme } from '../appearance-schemes';
import { OperonIndexer } from '../../indexer/indexer';
import { PinnedCache } from '../../storage/pinned-cache';
import { IndexedTask } from '../../types/fields';
import {
	KanbanCellActionContext,
	KanbanDropContext,
	KanbanLeafState,
	KanbanPreset,
	KanbanViewCallbacks,
	KANBAN_COLLAPSED_COLUMN_WIDTH_PX,
	normalizeKanbanLeafState,
} from '../../types/kanban';
import {
	resolveContextualMenu,
	type ContextualMenuContext,
	type ResolvedContextualMenuAction,
} from '../../core/contextual-menu-engine';
import { ContextualHoverMenuController } from '../contextual-hover-menu';
import { resolveContextualHoverMenuPosition } from '../contextual-hover-menu-position';
import { findStatusDef, Pipeline } from '../../types/pipeline';
import {
	FilterSet,
	OperonSettings,
	resolveTaskDisplayIcon,
	TASK_FINDER_DEFAULT_SCOPE_ICONS,
	TaskFinderDefaultScopeKey,
} from '../../types/settings';
import { t } from '../../core/i18n';
import { resolveTaskColorSourceForTask } from '../../core/task-color-source';
import { filterTasksForCalendar, stripFilterViewOnlyOptions } from '../../systems/calendar-filter-materialization';
import {
	buildKanbanTaskComparator,
	buildKanbanCellKey,
	isTaskInPipeline,
	KanbanBoardData,
	KanbanColumn,
	KanbanLane,
	KANBAN_NO_VALUE_KEY,
	queryKanbanBoard,
} from '../../systems/kanban-query';
import {
	applyKanbanOptimisticMovesToBoard,
	buildKanbanOptimisticStatusMovePlan,
	createKanbanDropOptimisticMove,
	isKanbanOptimisticMoveSatisfied,
	KanbanOptimisticMove,
	shouldApplyImmediateKanbanCardDrop,
} from '../../systems/kanban-optimistic-move';
import {
	buildProjectSearchCandidates,
	ProjectSearchCandidate,
	ProjectSearchMode,
	resolveProjectSearchVisibleTaskIds,
} from '../../systems/task-search';
import { asHTMLElement, createOwnerElement, getOwnerBody, getOwnerDocument, getOwnerWindow } from '../../core/dom-compat';
import { localNow } from '../../core/local-time';
import { resolveKanbanDescendantSummaryFromStats } from '../../core/task-stats-read-model';
import { bindOperonHoverTooltip } from '../operon-hover-tooltip';
import { setAccessibleLabelWithoutTooltip } from '../accessibility-label';
import { bindTaskTitleLinkPreview } from '../compact-chip-link-preview';
import {
	applyTaskSearchBoxShortcutCommand,
	cloneTaskSearchBoxScopeState,
	getTaskSearchBoxShortcutLabel,
	isDefaultKanbanSearchBoxScope,
	KANBAN_SEARCH_BOX_DEFAULT_SCOPE,
	matchesTaskSearchBoxScope,
	resolveTaskSearchBoxTextQuery,
	TaskSearchBoxScopeState,
	toggleTaskSearchBoxScope,
} from '../task-search-box-integration';
import { enginePerfLog, enginePerfNow } from '../../core/engine-perf';

export const KANBAN_VIEW_TYPE = 'operon-kanban-view';
const KANBAN_CARD_RENDER_BATCH_SIZE = 10;
const KANBAN_SEARCH_MIN_QUERY_LENGTH = 2;
const KANBAN_SEARCH_BOX_DISABLED_KEYS = new Set<TaskFinderDefaultScopeKey>(['recentModified']);
const KANBAN_TRACKER_FIELD_KEYS = new Set(['activeTracker', 'datetimeModified', 'duration', 'totalDuration', 'trackers']);
const KANBAN_SEARCH_SCOPE_GROUPS: TaskFinderDefaultScopeKey[][] = [
	['projectTasks', 'projectTree'],
	['overdue', 'happensToday', 'recentModified'],
	['includeInline', 'includeFile'],
	['includeCancelled', 'includeFinished'],
];

interface KanbanScrollState {
	left: number;
	top: number;
}

interface KanbanSearchFocusState {
	selectionStart: number | null;
	selectionEnd: number | null;
}

type KanbanParentSearchMode = ProjectSearchMode;

interface KanbanParentSearchSelection {
	mode: KanbanParentSearchMode;
	parentId: string;
	parentName: string;
}

type KanbanParentSearchCandidate = ProjectSearchCandidate;

interface KanbanParentSearchUiState {
	mode: KanbanParentSearchMode;
	query: string;
	candidates: KanbanParentSearchCandidate[];
	selectedParentId: string | null;
	dropdownVisible: boolean;
}

interface DraggedKanbanCardContext extends Pick<KanbanDropContext, 'taskId' | 'sourceStatusId' | 'sourceLaneKey'> {
	cardEl: HTMLElement;
}

interface KanbanDescendantSummary {
	generation: number;
	open: number;
	total: number;
}

export class KanbanView extends ItemView {
	private readonly indexer: OperonIndexer;
	private readonly getSettings: () => OperonSettings;
	private readonly getPinnedCache: () => PinnedCache | null;
	private readonly callbacks: KanbanViewCallbacks;
	private state: KanbanLeafState | null = null;
	private persistStateTimer: number | null = null;
	private renderFrame: number | null = null;
	private laneColumnWidthFrame: number | null = null;
	private boardLayoutRefreshFrame: number | null = null;
	private boardLayoutRefreshCleanup: (() => void) | null = null;
	private toolbarLayoutCleanup: (() => void) | null = null;
	private kanbanLazyObservers: IntersectionObserver[] = [];
	private lastLaneColumnWidthPx: number | null = null;
	private readonly hoverMenu = new ContextualHoverMenuController({
		getDelayMs: () => this.getSettings().contextualMenuOpenDelayMs,
		getHost: () => this.containerEl.children[1] as HTMLElement | null,
		positionMenu: (anchorRect, menu) => this.positionHoverMenu(anchorRect, menu),
	});
	private draggedCardContext: DraggedKanbanCardContext | null = null;
	private optimisticMoves = new Map<string, KanbanOptimisticMove>();
	private lastBoardScrollState: KanbanScrollState = { left: 0, top: 0 };
	private pendingSearchFocusState: KanbanSearchFocusState | null = null;
	private temporarilyExpandedAutoCollapsedStatusIds = new Set<string>();
	private temporarilyExpandedAutoCollapsedLaneKeys = new Set<string>();
	private searchScope: TaskSearchBoxScopeState = cloneTaskSearchBoxScopeState(KANBAN_SEARCH_BOX_DEFAULT_SCOPE);
	private parentSearchSelection: KanbanParentSearchSelection | null = null;
	private parentSearchHighlightedIndex = 0;
	private parentSearchDismissed = false;
	private descendantSummaryCache = new Map<string, KanbanDescendantSummary>();
	private lastRenderSignature: string | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		indexer: OperonIndexer,
		getSettings: () => OperonSettings,
		getPinnedCache: () => PinnedCache | null,
		callbacks: KanbanViewCallbacks = {},
	) {
		super(leaf);
		this.indexer = indexer;
		this.getSettings = getSettings;
		this.getPinnedCache = getPinnedCache;
		this.callbacks = callbacks;
	}

	getViewType(): string {
		return KANBAN_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.getCurrentPresetTitle();
	}

	private getCurrentPresetTitle(): string {
		const settings = this.getSettings();
		const state = this.state;
		return settings.kanbanPresets.find(entry => entry.id === state?.presetId)?.name ?? t('commands', 'openKanban');
	}

	private syncLeafTitle(): void {
		const title = this.getCurrentPresetTitle();
		const leafWithHeader = this.leaf as WorkspaceLeaf & {
			tabHeaderInnerTitleEl?: HTMLElement;
		};
		leafWithHeader.tabHeaderInnerTitleEl?.setText(title);
	}

	getIcon(): string {
		return 'square-kanban';
	}

	getState(): Record<string, unknown> {
		return {
			...this.ensureState(),
			searchQuery: '',
		};
	}

	async setState(state: Partial<KanbanLeafState> | null | undefined, _result: unknown): Promise<void> {
		const nextState = this.normalizeState(
			!this.containerEl.isConnected
				? { ...(state ?? {}), searchQuery: '' }
				: state,
		);
		const changed = !this.areLeafStatesEqual(this.state, nextState);
		this.state = nextState;
		this.syncLeafTitle();
		if (changed && this.containerEl.isConnected) {
			this.markDirty();
		}
	}

	async onOpen(): Promise<void> {
		this.temporarilyExpandedAutoCollapsedStatusIds.clear();
		this.temporarilyExpandedAutoCollapsedLaneKeys.clear();
		this.resetKanbanSearchScope();
		this.lastRenderSignature = null;
		this.state = {
			...this.ensureState(),
			searchQuery: '',
		};
		this.syncLeafTitle();
		this.registerEvent(this.app.workspace.on('css-change', () => { this.render(); }));
		this.render();
	}

	async onClose(): Promise<void> {
		this.temporarilyExpandedAutoCollapsedStatusIds.clear();
		this.temporarilyExpandedAutoCollapsedLaneKeys.clear();
		this.resetKanbanSearchScope();
		this.lastRenderSignature = null;
		if (this.persistStateTimer !== null) {
			this.clearPersistStateTimer();
			this.app.workspace.requestSaveLayout();
		}
		this.clearRender();
		this.clearLaneColumnWidthFrame();
		this.clearBoardLayoutRefresh();
		this.clearToolbarLayout();
		this.clearKanbanLazyObservers();
		this.hideHoverMenu(true);
	}

	markDirty(): void {
		this.scheduleRender(true);
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		const state = this.ensureState();
		const settings = this.getSettings();
		const preset = settings.kanbanPresets.find(entry => entry.id === state.presetId) ?? settings.kanbanPresets[0] ?? null;
		const pipeline = preset?.pipelineId
			? settings.pipelines.find(entry => entry.id === preset.pipelineId) ?? null
			: null;
		const filterSet = (() => {
			const raw = preset?.filterSetId
				? settings.filterSets.find(entry => entry.id === preset.filterSetId) ?? null
				: null;
			return raw ? stripFilterViewOnlyOptions(raw) : null;
		})();
		const parentSearchUi = pipeline && preset
			? this.buildParentSearchUiState(state.searchQuery, pipeline, filterSet, settings, this.searchScope)
			: null;
		const nextSignature = this.buildRenderSignature(container, state, preset, pipeline, filterSet, settings, parentSearchUi);
		if (this.lastRenderSignature === nextSignature && container.classList.contains('operon-kanban-view')) {
			return;
		}

		this.hideHoverMenu(true);
		this.clearBoardLayoutRefresh();
		this.clearToolbarLayout();
		this.clearKanbanLazyObservers();
		this.captureSearchFocusState(container);
		this.captureBoardScrollState(container);
		container.empty();
		container.addClass('operon-kanban-view');

		const root = container.createDiv('operon-kanban-root');
		if (!preset) {
			root.createDiv({ text: t('notifications', 'kanbanPresetsMissing') });
			this.lastRenderSignature = nextSignature;
			return;
		}
		this.applyKanbanPresetTheme(root, preset);

		this.renderToolbar(root, state, preset, parentSearchUi);
		const content = root.createDiv('operon-kanban-content');
		this.renderBoardContent(content, state, preset, pipeline, filterSet, settings, parentSearchUi);
		this.restoreSearchFocus(root);
		this.lastRenderSignature = nextSignature;
	}

	private buildRenderSignature(
		container: HTMLElement,
		state: KanbanLeafState,
		preset: KanbanPreset | null,
		pipeline: Pipeline | null,
		filterSet: FilterSet | null,
		settings: OperonSettings,
		parentSearchUi: KanbanParentSearchUiState | null,
	): string {
		const includeTrackerFields = this.usesTrackerFields(preset, filterSet);
		const taskSignature = this.indexer.getAllTasks()
			.map(task => this.buildTaskRenderSignature(task, includeTrackerFields))
			.sort();
		const includePinnedGeneration = this.filterSetUsesField(filterSet, 'pinned');
		const pinnedGeneration = includePinnedGeneration ? (this.getPinnedCache()?.getGeneration() ?? 0) : 0;
		const activeAppearanceMode = preset
			? (getOwnerBody(container).classList.contains('theme-dark') ? preset.appearanceModeDark : preset.appearanceModeLight)
			: 'theme';

		return JSON.stringify({
			appearance: activeAppearanceMode,
			state,
			searchScope: this.searchScope,
			parentSearchSelection: this.parentSearchSelection,
			parentSearchDismissed: this.parentSearchDismissed,
			parentSearchHighlightedIndex: this.parentSearchHighlightedIndex,
			parentSearchUi: this.buildParentSearchUiSignature(parentSearchUi),
			kanbanPresets: settings.kanbanPresets,
			pipeline,
			pipelines: settings.pipelines,
			filterSet,
			priorities: settings.priorities,
			fallbackTaskIconSource: settings.fallbackTaskIconSource,
			fallbackStateIcons: settings.fallbackStateIcons,
			maxVisibleTasksPerCell: settings.kanbanMaxVisibleTasksPerCell,
			taskFinderShortcuts: settings.taskFinderShortcuts,
			pinnedGeneration,
			optimisticMoves: Array.from(this.optimisticMoves.entries())
				.map(([taskId, move]) => ({ taskId, move }))
				.sort((left, right) => left.taskId.localeCompare(right.taskId)),
			manualOrder: preset?.sortMode === 'manual' && preset.id
				? this.callbacks.getManualOrder?.(preset.id) ?? {}
				: null,
			tasks: taskSignature,
		});
	}

	private buildTaskRenderSignature(task: IndexedTask, includeTrackerFields: boolean): string {
		const fieldEntries = Object.entries(task.fieldValues)
			.filter(([key]) => includeTrackerFields || !KANBAN_TRACKER_FIELD_KEYS.has(key))
			.sort(([left], [right]) => left.localeCompare(right));
		return JSON.stringify({
			id: task.operonId,
			description: task.description,
			checkbox: task.checkbox,
			tags: [...task.tags].sort(),
			primary: task.primary,
			datetimeModified: includeTrackerFields ? task.datetimeModified : '',
			fields: fieldEntries,
		});
	}

	private buildParentSearchUiSignature(parentSearchUi: KanbanParentSearchUiState | null): unknown {
		if (!parentSearchUi) return null;
		return {
			mode: parentSearchUi.mode,
			query: parentSearchUi.query,
			selectedParentId: parentSearchUi.selectedParentId,
			dropdownVisible: parentSearchUi.dropdownVisible,
			candidates: parentSearchUi.candidates.map(candidate => ({
				taskId: candidate.task.operonId,
				taskName: candidate.task.description,
				directVisibleCount: candidate.directVisibleCount,
				treeVisibleCount: candidate.treeVisibleCount,
			})),
		};
	}

	private usesTrackerFields(preset: KanbanPreset | null, filterSet: FilterSet | null): boolean {
		if (preset?.sortRules.some(rule => KANBAN_TRACKER_FIELD_KEYS.has(rule.field))) return true;
		if (this.filterSetUsesTrackerFields(filterSet)) return true;
		return false;
	}

	private filterSetUsesTrackerFields(filterSet: FilterSet | null): boolean {
		return Array.from(KANBAN_TRACKER_FIELD_KEYS).some(field => this.filterSetUsesField(filterSet, field));
	}

	private filterSetUsesField(filterSet: FilterSet | null, field: string): boolean {
		if (!filterSet) return false;
		for (const condition of filterSet.conditions) {
			if (condition.field === field) return true;
		}
		if (filterSet.sorts.some(sort => sort.field === field)) return true;
		for (const key of [filterSet.sortBy, filterSet.groupBy, filterSet.subgroupBy]) {
			if (key === field) return true;
		}
		return this.filterNodeUsesField(filterSet.rootGroup, field);
	}

	private filterNodeUsesField(node: FilterSet['rootGroup'], field: string): boolean {
		for (const child of node.children) {
			if ('children' in child) {
				if (this.filterNodeUsesField(child, field)) return true;
				continue;
			}
			if (child.field === field) return true;
		}
		return false;
	}

		private renderBoardContent(
			container: HTMLElement,
			state: KanbanLeafState,
			preset: KanbanPreset,
			pipeline: Pipeline | null,
			filterSet: FilterSet | null,
			settings: OperonSettings,
			parentSearchUi: KanbanParentSearchUiState | null,
		): void {
			if (!pipeline) {
				this.renderEmptyState(container, t('notifications', 'kanbanChoosePipeline'));
				return;
			}

			const activeSearchQuery = this.getActiveSearchQuery(state.searchQuery, parentSearchUi);
			const taskIdFilter = this.resolveKanbanSearchTaskIdFilter(this.searchScope, filterSet, pipeline, settings, parentSearchUi);
		const searchActive = !!activeSearchQuery
			|| !!parentSearchUi?.selectedParentId
			|| this.hasKanbanSearchScopeFilters(this.searchScope);
		const hasVisibleSwimlanes = preset.swimlaneBy !== null;
		const skippedStatusIds = searchActive
			? new Set<string>()
			: this.resolveSkippedStatusMaterializationIds(pipeline, preset, state);
		const board = queryKanbanBoard({
			preset,
			pipeline,
			filterSet,
			tasks: this.indexer.getAllTasks(),
			priorities: settings.priorities,
			searchQuery: activeSearchQuery,
			taskIdFilter,
				skippedStatusIds,
				skippedLaneKeys: searchActive || !hasVisibleSwimlanes ? undefined : state.collapsedLaneKeys,
				pinnedCache: this.getPinnedCache(),
				manualOrder: preset.sortMode === 'manual'
					? this.callbacks.getManualOrder?.(preset.id) ?? {}
					: undefined,
				});
			this.reconcileOptimisticMoves(board, pipeline, preset);
			this.applyOptimisticMoves(board, settings);
			if (board.columns.length === 0) {
				this.renderEmptyState(container, t('notifications', 'kanbanNoColumns'));
				return;
			}
			if (board.lanes.length === 0) {
				this.renderEmptyState(container, t('notifications', 'kanbanNoTasks'));
				return;
			}

			this.renderBoard(container, board, searchActive);
		}

	private renderToolbar(
		container: HTMLElement,
		state: KanbanLeafState,
		preset: KanbanPreset,
		parentSearchUi: KanbanParentSearchUiState | null,
	): void {
		const toolbar = container.createDiv('operon-kanban-toolbar');
		const start = toolbar.createDiv('operon-kanban-toolbar-start');
		const center = toolbar.createDiv('operon-kanban-toolbar-center');
		const end = toolbar.createDiv('operon-kanban-toolbar-end');
		const title = start.createDiv('operon-kanban-toolbar-title');
		title.createDiv({
			text: t('commands', 'openKanban'),
			cls: 'operon-kanban-toolbar-title-main',
		});

		for (const entry of this.getSettings().kanbanPresets) {
			const button = center.createEl('button', {
				text: entry.name,
				cls: 'operon-kanban-toolbar-preset-button',
				attr: { type: 'button' },
			});
			button.classList.toggle('is-active', entry.id === preset.id);
			button.addEventListener('click', () => {
				this.clearParentSearchState();
				void this.updateLeafState(this.buildStateForPresetSwitch(entry.id));
			});
			}

			const searchWrap = end.createDiv('operon-kanban-toolbar-search-wrap');
			this.syncKanbanSearchWrapClasses(searchWrap, state.searchQuery);
			searchWrap.addClass('has-scope-popover');
		const searchInput = searchWrap.createEl('input', {
			cls: 'operon-kanban-toolbar-search',
			attr: {
				type: 'search',
				placeholder: t('tooltips', 'searchTasksInKanban', { name: preset.name }),
			},
		});
		setAccessibleLabelWithoutTooltip(searchInput, t('tooltips', 'searchTasksInKanbanBoard'));
		searchInput.value = state.searchQuery;
		searchInput.addEventListener('input', () => {
			const previousSearchQuery = this.ensureState().searchQuery;
			const shortcutResult = applyTaskSearchBoxShortcutCommand(
				searchInput.value,
				this.searchScope,
				this.getSettings(),
				{
					disabledKeys: KANBAN_SEARCH_BOX_DISABLED_KEYS,
					preserveTerminalStateScopes: true,
				},
			);
			let nextSearchQuery = searchInput.value;
			if (shortcutResult.handled) {
				nextSearchQuery = shortcutResult.query;
				searchInput.value = nextSearchQuery;
				const previousProjectMode = this.searchScope.projectMode;
				this.searchScope = shortcutResult.scope;
				if (previousProjectMode !== this.searchScope.projectMode) {
					this.parentSearchSelection = null;
				}
			}
				this.parentSearchDismissed = false;
				this.parentSearchHighlightedIndex = 0;
				if (this.searchScope.projectMode !== this.parentSearchSelection?.mode) {
					this.parentSearchSelection = null;
				}
				this.setSearchQueryState(nextSearchQuery);
				if (shortcutResult.handled) {
					if (nextSearchQuery === previousSearchQuery) {
						this.markDirty();
					} else {
						this.render();
					}
				} else {
					this.syncKanbanSearchWrapClasses(searchWrap, nextSearchQuery);
					this.refreshKanbanSearchResults(searchWrap);
				}
			});
			searchInput.addEventListener('keydown', event => {
				const currentParentSearchUi = this.resolveCurrentParentSearchUi();
				if (!currentParentSearchUi || !currentParentSearchUi.dropdownVisible || currentParentSearchUi.candidates.length === 0) {
					return;
				}
				if (event.key === 'ArrowDown') {
					event.preventDefault();
					this.updateParentSearchHighlight(Math.min(
						currentParentSearchUi.candidates.length - 1,
						this.parentSearchHighlightedIndex + 1,
					));
					return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				this.updateParentSearchHighlight(Math.max(0, this.parentSearchHighlightedIndex - 1));
				return;
				}
				if (event.key === 'Enter') {
					event.preventDefault();
					const candidate = currentParentSearchUi.candidates[this.parentSearchHighlightedIndex] ?? currentParentSearchUi.candidates[0];
					if (candidate) {
						this.selectParentSearchCandidate(currentParentSearchUi.mode, candidate);
					}
					return;
				}
			if (event.key === 'Escape') {
				event.preventDefault();
				this.parentSearchDismissed = true;
				this.render();
			}
		});
			const clearButton = searchWrap.createEl('button', {
				cls: 'operon-kanban-toolbar-search-clear',
				text: '×',
				attr: {
					type: 'button',
				},
			});
			setAccessibleLabelWithoutTooltip(clearButton, t('tooltips', 'clearSearch'));
			clearButton.addEventListener('pointerdown', event => {
				event.preventDefault();
			});
			clearButton.addEventListener('click', () => {
				const previousSearchQuery = this.ensureState().searchQuery;
				this.resetKanbanSearchScope();
				searchInput.value = '';
				this.syncKanbanSearchWrapClasses(searchWrap, '');
				searchInput.focus({ preventScroll: true });
				void this.updateLeafState({
					...this.ensureState(),
					searchQuery: '',
				});
				if (!previousSearchQuery) {
					this.markDirty();
				}
			});
			this.renderKanbanSearchScopeToolbar(searchWrap);
			this.renderParentSearchDropdown(searchWrap, parentSearchUi);

			const settingsButton = end.createEl('button', {
				cls: 'operon-kanban-toolbar-settings-button',
				attr: { type: 'button' },
			});
			setIcon(settingsButton, 'settings-2');
			setAccessibleLabelWithoutTooltip(settingsButton, t('tooltips', 'editKanbanPreset', { name: preset.name }));
			bindOperonHoverTooltip(settingsButton, {
				content: t('tooltips', 'editKanbanPreset', { name: preset.name }),
				taskColor: null,
			});
			settingsButton.addEventListener('click', () => {
				if (!preset.id) return;
				void this.callbacks.onOpenPresetSettings?.(preset.id);
			});
			this.applyKanbanToolbarLayoutMode(toolbar, start, center, end);
		}

		private applyKanbanToolbarLayoutMode(
			toolbar: HTMLElement,
			start: HTMLElement,
			center: HTMLElement,
			end: HTMLElement,
		): void {
			const updateLayout = (): void => {
				const width = toolbar.clientWidth;
				if (width <= 0) return;
				const requiredWidth = this.measureKanbanToolbarGroupWidth(start)
					+ this.measureKanbanToolbarGroupWidth(center)
					+ this.measureKanbanToolbarGroupWidth(end)
					+ 24;
				toolbar.classList.toggle('is-compact', requiredWidth > width);
			};

			this.clearToolbarLayout();

			updateLayout();
			window.requestAnimationFrame(updateLayout);
			window.requestAnimationFrame(() => window.requestAnimationFrame(updateLayout));
			window.setTimeout(updateLayout, 0);
			window.setTimeout(updateLayout, 120);

			const observer = new ResizeObserver(() => updateLayout());
			observer.observe(toolbar);
			observer.observe(start);
			observer.observe(center);
			observer.observe(end);
			this.toolbarLayoutCleanup = () => observer.disconnect();
		}

		private measureKanbanToolbarGroupWidth(group: HTMLElement): number {
			const children = Array.from(group.children) as HTMLElement[];
			if (children.length === 0) return 0;
			let total = 0;
			for (const child of children) {
				const rectWidth = Math.ceil(child.getBoundingClientRect().width);
				const naturalWidth = Math.ceil(child.scrollWidth || 0);
				total += Math.max(rectWidth, naturalWidth);
			}
			return total + Math.max(0, children.length - 1) * 8;
		}

		private clearToolbarLayout(): void {
			this.toolbarLayoutCleanup?.();
			this.toolbarLayoutCleanup = null;
		}

		private syncKanbanSearchWrapClasses(searchWrap: HTMLElement, rawQuery: string): void {
			const hasSearchQuery = !!rawQuery.trim();
			const hasActiveSearchScope = !isDefaultKanbanSearchBoxScope(this.searchScope) || !!this.parentSearchSelection;
			searchWrap.classList.toggle('has-value', hasSearchQuery || hasActiveSearchScope);
			searchWrap.classList.toggle('has-search-query', hasSearchQuery);
			searchWrap.classList.toggle('has-active-scope', hasActiveSearchScope);
		}

		private setSearchQueryState(searchQuery: string): void {
			this.state = this.normalizeState({
				...this.ensureState(),
				searchQuery,
			});
		}

		private refreshKanbanSearchResults(searchWrap: HTMLElement): void {
			const host = this.containerEl.children[1] as HTMLElement | undefined;
			const root = host?.querySelector<HTMLElement>('.operon-kanban-root');
			const content = root?.querySelector<HTMLElement>('.operon-kanban-content');
			if (!root || !content) {
				this.render();
				return;
			}
			const state = this.ensureState();
			const settings = this.getSettings();
			const preset = settings.kanbanPresets.find(entry => entry.id === state.presetId) ?? settings.kanbanPresets[0] ?? null;
			if (!preset) {
				this.render();
				return;
			}
			const pipeline = preset.pipelineId
				? settings.pipelines.find(entry => entry.id === preset.pipelineId) ?? null
				: null;
			const filterSet = (() => {
				const raw = preset.filterSetId
					? settings.filterSets.find(entry => entry.id === preset.filterSetId) ?? null
					: null;
				return raw ? stripFilterViewOnlyOptions(raw) : null;
			})();
			const parentSearchUi = pipeline
				? this.buildParentSearchUiState(state.searchQuery, pipeline, filterSet, settings, this.searchScope)
				: null;
			this.renderParentSearchDropdown(searchWrap, parentSearchUi);
			this.hideHoverMenu(true);
			this.clearBoardLayoutRefresh();
			this.clearKanbanLazyObservers();
			this.captureBoardScrollState(content);
			content.empty();
			this.renderBoardContent(content, state, preset, pipeline, filterSet, settings, parentSearchUi);
		}

		private resolveCurrentParentSearchUi(): KanbanParentSearchUiState | null {
			const state = this.ensureState();
			const settings = this.getSettings();
			const preset = settings.kanbanPresets.find(entry => entry.id === state.presetId) ?? settings.kanbanPresets[0] ?? null;
			if (!preset) return null;
			const pipeline = preset.pipelineId
				? settings.pipelines.find(entry => entry.id === preset.pipelineId) ?? null
				: null;
			if (!pipeline) return null;
			const filterSet = (() => {
				const raw = preset.filterSetId
					? settings.filterSets.find(entry => entry.id === preset.filterSetId) ?? null
					: null;
				return raw ? stripFilterViewOnlyOptions(raw) : null;
			})();
			return this.buildParentSearchUiState(state.searchQuery, pipeline, filterSet, settings, this.searchScope);
		}

		private renderKanbanSearchScopeToolbar(searchWrap: HTMLElement): void {
			const popover = searchWrap.createDiv('operon-kanban-search-scope-popover');
			const tools = popover.createDiv('operon-task-finder-tools operon-kanban-search-scope-tools');
			for (const group of KANBAN_SEARCH_SCOPE_GROUPS) {
				const groupEl = tools.createDiv('operon-task-finder-tool-group operon-kanban-search-scope-group');
				for (const key of group) {
					const isDisabled = KANBAN_SEARCH_BOX_DISABLED_KEYS.has(key);
					const button = groupEl.createEl('button', {
						cls: 'operon-task-finder-tool operon-kanban-search-scope-button',
						attr: {
							type: 'button',
						},
					});
					button.classList.toggle('is-active', this.isKanbanSearchScopeKeyActive(key));
					button.classList.toggle('is-disabled', isDisabled);
					if (isDisabled) {
						button.setAttribute('aria-disabled', 'true');
					}
					button.addEventListener('pointerdown', event => event.preventDefault());
					button.addEventListener('click', () => {
						if (!isDisabled) {
							const previousProjectMode = this.searchScope.projectMode;
							this.searchScope = toggleTaskSearchBoxScope(this.searchScope, key, {
								preserveTerminalStateScopes: true,
							});
							if (previousProjectMode !== this.searchScope.projectMode) {
								this.parentSearchSelection = null;
							}
							this.parentSearchDismissed = false;
							this.parentSearchHighlightedIndex = 0;
							this.markDirty();
						}
						this.focusKanbanSearchInput();
					});
					const icon = button.createSpan('operon-task-finder-tool-icon');
					setIcon(icon, TASK_FINDER_DEFAULT_SCOPE_ICONS[key]);
					setAccessibleLabelWithoutTooltip(button, this.getSearchScopeButtonLabel(key));
					const shortcut = getTaskSearchBoxShortcutLabel(this.getSettings(), key);
					const tooltip = shortcut
						? `${this.getSearchScopeButtonLabel(key)} ${shortcut}`
						: this.getSearchScopeButtonLabel(key);
					bindOperonHoverTooltip(button, { content: tooltip, taskColor: null });
				}
			}
			if (this.parentSearchSelection) {
				const selectedParent = popover.createDiv('operon-kanban-search-selected-parent');
				selectedParent.createSpan({
					cls: 'operon-kanban-search-selected-parent-label',
					text: this.parentSearchSelection.parentName,
				});
				const clearButton = selectedParent.createEl('button', {
					cls: 'operon-kanban-search-selected-parent-clear',
					text: '×',
					attr: { type: 'button' },
				});
				setAccessibleLabelWithoutTooltip(clearButton, t('tooltips', 'clearSearch'));
				clearButton.addEventListener('pointerdown', event => event.preventDefault());
				clearButton.addEventListener('click', () => {
					this.parentSearchSelection = null;
					this.parentSearchDismissed = false;
					this.parentSearchHighlightedIndex = 0;
					this.markDirty();
					this.focusKanbanSearchInput();
				});
			}
		}

		private renderParentSearchDropdown(
			searchWrap: HTMLElement,
			parentSearchUi: KanbanParentSearchUiState | null,
		): void {
			searchWrap.querySelector<HTMLElement>('.operon-kanban-parent-search-dropdown')?.remove();
			if (!parentSearchUi?.dropdownVisible) return;
			const dropdown = searchWrap.createDiv('operon-kanban-parent-search-dropdown');
			if (parentSearchUi.candidates.length === 0) {
				dropdown.createDiv({
					cls: 'operon-kanban-parent-search-empty',
					text: t('notifications', 'kanbanParentSearchNoParents'),
				});
				return;
			}
			parentSearchUi.candidates.forEach((candidate, index) => {
				const item = dropdown.createEl('button', {
					cls: 'operon-kanban-parent-search-item',
					attr: { type: 'button' },
				});
				item.classList.toggle('is-active', index === this.parentSearchHighlightedIndex);
				item.addEventListener('pointerdown', event => event.preventDefault());
				item.addEventListener('click', () => {
					this.selectParentSearchCandidate(parentSearchUi.mode, candidate);
				});
				item.createDiv({
					cls: 'operon-kanban-parent-search-item-name',
					text: candidate.task.description,
				});
				item.createDiv({
					cls: 'operon-kanban-parent-search-item-meta',
					text: parentSearchUi.mode === 'pc'
						? String(candidate.directVisibleCount)
						: String(candidate.treeVisibleCount),
				});
			});
		}

	private renderBoard(container: HTMLElement, board: KanbanBoardData, searchActive: boolean): void {
		const boardEl = container.createDiv('operon-kanban-board');
		this.bindBoardDelegatedCardEvents(boardEl);
		const hasSwimlanes = board.preset.swimlaneBy !== null;
		boardEl.toggleClass('is-no-swimlanes', !hasSwimlanes);
		boardEl.toggleClass('is-manual-order', board.preset.sortMode === 'manual');
		boardEl.style.setProperty('--operon-kanban-column-width', `${this.getSettings().kanbanExpandedColumnWidthPx}px`);
		boardEl.style.setProperty('--operon-kanban-collapsed-width', `${KANBAN_COLLAPSED_COLUMN_WIDTH_PX}px`);
		boardEl.style.setProperty('--operon-kanban-lane-column-width', `${this.lastLaneColumnWidthPx ?? 96}px`);
		const columns = board.columns;
		const state = this.ensureState();
		const collapsedStatusIds = this.resolveCollapsedStatusIds(board, state, searchActive);
		const collapsedLaneKeys = this.resolveCollapsedLaneKeys(board, state, searchActive);
		const columnTemplate = this.buildColumnTemplate(columns, Array.from(collapsedStatusIds));

		const gridViewport = boardEl.createDiv('operon-kanban-grid-viewport');
		const gridContent = gridViewport.createDiv('operon-kanban-grid-content');
		const fullColumnTemplate = hasSwimlanes
			? `var(--operon-kanban-lane-column-width, 96px) ${columnTemplate}`
			: columnTemplate;
		const headerRow = gridContent.createDiv('operon-kanban-header-row');
		headerRow.style.gridTemplateColumns = fullColumnTemplate;
		if (hasSwimlanes) {
			const corner = headerRow.createDiv('operon-kanban-corner-cell');
			this.renderCornerSummary(corner, board.relevantTasks.length);
		}

		for (const column of columns) {
			const header = headerRow.createDiv('operon-kanban-column-header');
			const isCollapsed = collapsedStatusIds.has(column.statusId);
			header.classList.toggle('is-collapsed', isCollapsed);
			if (column.color) {
				header.style.setProperty('--operon-kanban-status-color', column.color);
			}
			const title = header.createDiv('operon-kanban-column-header-title');
			title.setText(column.statusLabel);
				const toggle = header.createEl('button', {
					cls: 'operon-kanban-column-count-button',
					text: String(column.count),
					attr: {
						type: 'button',
					},
				});
				setAccessibleLabelWithoutTooltip(toggle, isCollapsed
					? t('tooltips', 'expandKanbanColumn', { name: column.statusLabel })
					: t('tooltips', 'collapseKanbanColumn', { name: column.statusLabel }));
				bindOperonHoverTooltip(toggle, { content: column.statusLabel, taskColor: column.color || null });
			toggle.addEventListener('click', () => {
				if (this.isStatusAutoCollapsed(board, column)) {
					const state = this.ensureState();
					const isTemporarilyExpanded = this.temporarilyExpandedAutoCollapsedStatusIds.has(column.statusId);
					const isManuallyCollapsed = state.collapsedStatusIds.includes(column.statusId);
					if (collapsedStatusIds.has(column.statusId)) {
						this.temporarilyExpandedAutoCollapsedStatusIds.add(column.statusId);
						if (isManuallyCollapsed) {
							const nextCollapsed = new Set(state.collapsedStatusIds);
							nextCollapsed.delete(column.statusId);
							void this.updateLeafState(this.withCurrentPresetCollapseState({
								collapsedStatusIds: Array.from(nextCollapsed),
							}));
							return;
						}
						this.render();
						return;
					}
					if (isTemporarilyExpanded) {
						this.temporarilyExpandedAutoCollapsedStatusIds.delete(column.statusId);
						this.render();
						return;
					}
				}
				const nextCollapsed = new Set(this.ensureState().collapsedStatusIds);
				if (nextCollapsed.has(column.statusId)) {
					nextCollapsed.delete(column.statusId);
				} else {
					nextCollapsed.add(column.statusId);
				}
				void this.updateLeafState(this.withCurrentPresetCollapseState({
					collapsedStatusIds: Array.from(nextCollapsed),
				}));
			});
		}

		const laneLabelEls: HTMLElement[] = [];
		const laneTitleEls: HTMLElement[] = [];
		const gridRowEls: HTMLElement[] = [];

		for (const lane of board.lanes) {
			const row = gridContent.createDiv('operon-kanban-row');
			row.style.gridTemplateColumns = fullColumnTemplate;
			const isLaneCollapsed = hasSwimlanes && collapsedLaneKeys.has(lane.key);
			row.classList.toggle('is-collapsed', isLaneCollapsed);
			let laneLabel: HTMLElement | null = null;
			if (hasSwimlanes) {
				laneLabel = row.createDiv('operon-kanban-lane-label');
				laneLabel.classList.toggle('is-collapsed', isLaneCollapsed);
				laneLabel.classList.toggle('is-no-value', lane.isNoValue);
				if (lane.color) {
					laneLabel.style.setProperty('--operon-kanban-lane-color', lane.color);
				}
				const laneTitle = laneLabel.createDiv({ text: lane.label, cls: 'operon-kanban-lane-title' });
				const laneToggle = laneLabel.createEl('button', {
					cls: 'operon-kanban-lane-count-button',
					text: String(lane.count),
					attr: {
						type: 'button',
					},
				});
				setAccessibleLabelWithoutTooltip(laneToggle, isLaneCollapsed
					? t('tooltips', 'expandKanbanSwimlane', { name: lane.label })
					: t('tooltips', 'collapseKanbanSwimlane', { name: lane.label }));
				bindOperonHoverTooltip(laneToggle, { content: lane.label, taskColor: lane.color || null });
				laneTitleEls.push(laneTitle);
				laneToggle.addEventListener('click', () => {
					if (this.isLaneAutoCollapsed(board, lane)) {
						const state = this.ensureState();
						const isTemporarilyExpanded = this.temporarilyExpandedAutoCollapsedLaneKeys.has(lane.key);
						const isManuallyCollapsed = state.collapsedLaneKeys.includes(lane.key);
						if (collapsedLaneKeys.has(lane.key)) {
							this.temporarilyExpandedAutoCollapsedLaneKeys.add(lane.key);
							if (isManuallyCollapsed) {
								const nextCollapsed = new Set(state.collapsedLaneKeys);
								nextCollapsed.delete(lane.key);
								void this.updateLeafState(this.withCurrentPresetCollapseState({
									collapsedLaneKeys: Array.from(nextCollapsed),
								}));
								return;
							}
							this.render();
							return;
						}
						if (isTemporarilyExpanded) {
							this.temporarilyExpandedAutoCollapsedLaneKeys.delete(lane.key);
							this.render();
							return;
						}
					}
					const nextCollapsed = new Set(this.ensureState().collapsedLaneKeys);
					if (nextCollapsed.has(lane.key)) {
						nextCollapsed.delete(lane.key);
					} else {
						nextCollapsed.add(lane.key);
					}
					void this.updateLeafState(this.withCurrentPresetCollapseState({
						collapsedLaneKeys: Array.from(nextCollapsed),
					}));
				});
			}

			for (const column of columns) {
				const cell = row.createDiv('operon-kanban-cell');
				const cellKey = buildKanbanCellKey(column.statusId, lane.key);
				const tasks = board.cellMap.get(cellKey) ?? [];
				const taskCount = board.cellCountMap.get(cellKey) ?? tasks.length;
				const isColumnCollapsed = collapsedStatusIds.has(column.statusId);
				const isSearchCollapsed = searchActive && taskCount === 0;
				const isCollapsed = isColumnCollapsed || isLaneCollapsed || isSearchCollapsed;
				cell.classList.toggle('is-collapsed', isCollapsed);
				if (column.color) {
					cell.style.setProperty('--operon-kanban-status-color', column.color);
				}
				if (lane.color) {
					cell.style.setProperty('--operon-kanban-lane-color', lane.color);
				}
				this.bindCellDropTarget(cell, column, lane, board.preset);
				if (isCollapsed) {
					this.renderCollapsedCellSummary(cell, taskCount);
					continue;
				}
				this.bindCellQuickAdd(cell, column, lane, board.preset, gridViewport);
				this.renderInitialCellTasks(cell, tasks, taskCount, board.pipeline, board.preset, column.statusId, lane.key);
			}

			if (laneLabel) laneLabelEls.push(laneLabel);
			gridRowEls.push(row);
		}

		this.bindBoardScrollStateTracking(gridViewport);
		this.restoreBoardScrollState(gridViewport);
		this.syncRowCellHeights(gridRowEls);
		if (hasSwimlanes) {
			this.syncLaneHeights(laneLabelEls, gridRowEls);
			this.refreshLaneColumnWidth(boardEl, laneTitleEls);
		}
		this.bindBoardLayoutRefresh(boardEl, laneLabelEls, gridRowEls, laneTitleEls, hasSwimlanes);
	}

	private renderInitialCellTasks(
		cell: HTMLElement,
		tasks: IndexedTask[],
		totalTaskCount: number,
		pipeline: Pipeline | null,
		preset: KanbanPreset,
		statusId: string,
		laneKey: string,
	): void {
		const maxVisibleTasks = this.getSettings().kanbanMaxVisibleTasksPerCell;
		const initialLimit = Math.min(tasks.length, Math.max(KANBAN_CARD_RENDER_BATCH_SIZE, maxVisibleTasks));
		this.renderTaskCardBatch(cell, tasks, 0, initialLimit, pipeline, preset, statusId, laneKey, null);
		cell.dataset.kanbanVisibleCount = String(initialLimit);
		this.applyCellHeightLimit(cell, maxVisibleTasks, totalTaskCount);
		if (tasks.length <= initialLimit) return;
		this.attachCellLazySentinel(cell, tasks, pipeline, preset, statusId, laneKey, maxVisibleTasks);
	}

	private renderTaskCardBatch(
		cell: HTMLElement,
		tasks: IndexedTask[],
		startIndex: number,
		endIndex: number,
		pipeline: Pipeline | null,
		preset: KanbanPreset,
		statusId: string,
		laneKey: string,
		beforeEl: HTMLElement | null,
	): void {
		for (let index = startIndex; index < endIndex; index++) {
			const task = tasks[index];
			if (!task) continue;
			const card = this.renderTaskCard(cell, task, pipeline, preset, statusId, laneKey, false, 0);
			if (beforeEl) {
				cell.insertBefore(card, beforeEl);
			}
		}
	}

	private attachCellLazySentinel(
		cell: HTMLElement,
		tasks: IndexedTask[],
		pipeline: Pipeline | null,
		preset: KanbanPreset,
		statusId: string,
		laneKey: string,
		maxVisibleTasks: number,
	): void {
		const sentinel = cell.createDiv('operon-kanban-lazy-sentinel');
		sentinel.setAttr('aria-hidden', 'true');
		const setSentinelNextTaskId = (visibleCount: number): void => {
			const nextTaskId = tasks[visibleCount]?.operonId ?? '';
			if (nextTaskId) {
				sentinel.dataset.kanbanNextTaskId = nextTaskId;
			} else {
				delete sentinel.dataset.kanbanNextTaskId;
			}
		};
		setSentinelNextTaskId(Number(cell.dataset.kanbanVisibleCount ?? '0') || 0);
		let observer: IntersectionObserver;
		observer = new IntersectionObserver((entries) => {
			if (!entries.some(entry => entry.isIntersecting)) return;
			const currentVisible = Number(cell.dataset.kanbanVisibleCount ?? '0') || 0;
			if (currentVisible >= tasks.length) {
				observer.disconnect();
				sentinel.remove();
				return;
			}
			const nextVisible = Math.min(tasks.length, currentVisible + KANBAN_CARD_RENDER_BATCH_SIZE);
			this.renderTaskCardBatch(cell, tasks, currentVisible, nextVisible, pipeline, preset, statusId, laneKey, sentinel);
			cell.dataset.kanbanVisibleCount = String(nextVisible);
			setSentinelNextTaskId(nextVisible);
			this.applyCellHeightLimit(cell, maxVisibleTasks, tasks.length);
			this.scheduleBoardLayoutRefreshFromCell(cell);
			if (nextVisible >= tasks.length) {
				observer.disconnect();
				sentinel.remove();
			}
		}, { root: cell, rootMargin: '0px' });
		this.kanbanLazyObservers.push(observer);
		observer.observe(sentinel);
	}

	private bindBoardDelegatedCardEvents(boardEl: HTMLElement): void {
		boardEl.addEventListener('click', event => {
			const target = asHTMLElement(event.target, boardEl);
			if (!target) return;

			const descendantToggle = target.closest<HTMLButtonElement>('.operon-kanban-descendant-toggle');
			if (descendantToggle && !descendantToggle.disabled) {
				const card = descendantToggle.closest<HTMLElement>('.operon-kanban-card');
				const taskId = card?.dataset.operonTaskId;
				if (!taskId) return;
				event.preventDefault();
				event.stopPropagation();
				this.toggleDescendantPreview(taskId);
				return;
			}

			if (target.closest('.operon-calendar-status-button, .operon-calendar-hover-menu')) return;
			const card = target.closest<HTMLElement>('.operon-kanban-card');
			const taskId = card?.dataset.operonTaskId;
			if (!card || !taskId || !boardEl.contains(card)) return;
			event.stopPropagation();
			void this.callbacks.onItemAction?.(taskId, 'openEditor');
		});

		boardEl.addEventListener('dragstart', event => {
			const target = asHTMLElement(event.target, boardEl);
			const card = target?.closest<HTMLElement>('.operon-kanban-card');
			if (!card || card.dataset.kanbanPreview === 'true') return;
			const taskId = card.dataset.operonTaskId;
			const sourceLaneKey = card.dataset.kanbanLaneKey;
			if (!taskId || !sourceLaneKey) return;
			this.draggedCardContext = {
				taskId,
				sourceStatusId: card.dataset.kanbanStatusId ?? null,
				sourceLaneKey,
				cardEl: card,
			};
			event.dataTransfer?.setData('text/plain', taskId);
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = 'move';
			}
			card.addClass('is-dragging');
		});

		boardEl.addEventListener('dragend', event => {
			const target = asHTMLElement(event.target, boardEl);
			const card = target?.closest<HTMLElement>('.operon-kanban-card');
			this.draggedCardContext = null;
			this.clearManualDropIndicators(boardEl);
			card?.removeClass('is-dragging');
		});
	}

	private toggleDescendantPreview(taskId: string): void {
		const expanded = new Set(this.ensureState().expandedPreviewParentIds);
		if (expanded.has(taskId)) {
			expanded.delete(taskId);
		} else {
			expanded.add(taskId);
		}
		void this.updateLeafState({
			...this.ensureState(),
			expandedPreviewParentIds: Array.from(expanded),
		});
	}

	private renderTaskCard(
		container: HTMLElement,
		task: IndexedTask,
		pipeline: Pipeline | null,
		preset: KanbanPreset,
		statusId: string | null,
		laneKey: string,
		isPreview: boolean,
		depth: number,
	): HTMLElement {
		const card = container.createDiv('operon-kanban-card');
		card.dataset.operonTaskId = task.operonId;
		card.dataset.kanbanLaneKey = laneKey;
		card.dataset.kanbanPreview = isPreview ? 'true' : 'false';
		if (statusId) {
			card.dataset.kanbanStatusId = statusId;
		}
		card.classList.toggle('is-readonly-preview', isPreview);
		card.classList.toggle('is-done', task.checkbox === 'done');
		card.classList.toggle('is-cancelled', task.checkbox === 'cancelled');
		card.style.setProperty('--operon-kanban-preview-depth', String(depth));
		this.applyTaskColor(card, task, preset);

		if (isPreview && depth > 0) {
			card.addClass('is-nested-preview');
		}

		const head = card.createDiv('operon-kanban-card-head');
		const hoverTrigger = head.createSpan('operon-calendar-hover-menu-trigger');
		this.renderStatusButton(hoverTrigger, task, pipeline, preset, statusId, laneKey);
		const titleEl = head.createSpan({
			text: task.description || task.operonId,
			cls: 'operon-kanban-card-title',
		});
		if (task.primary.format === 'yaml') {
			bindTaskTitleLinkPreview(this.app, titleEl, task.primary.filePath, task.primary.filePath);
		}

		const descendantSummary = this.buildDescendantSummary(task.operonId);
		if (descendantSummary.total > 0) {
				const button = head.createEl('button', {
					text: `${descendantSummary.open}/${descendantSummary.total}`,
					cls: 'operon-kanban-descendant-toggle',
					attr: { type: 'button' },
				});
				setAccessibleLabelWithoutTooltip(button, t('tooltips', 'toggleDescendantPreview'));
			if (isPreview) {
				button.disabled = true;
			} else {
				button.classList.toggle('is-expanded', this.ensureState().expandedPreviewParentIds.includes(task.operonId));
			}
		}

		if (!isPreview) {
			this.bindHoverMenuTarget(hoverTrigger, task);
			card.draggable = true;
			card.addClass('is-draggable');
		}

		if (!isPreview && this.ensureState().expandedPreviewParentIds.includes(task.operonId)) {
			const preview = card.createDiv('operon-kanban-preview-tree');
			for (const child of this.getPreviewChildren(task.operonId)) {
				this.renderPreviewNode(preview, child, preset, pipeline, depth + 1);
			}
		}
		return card;
	}

	private renderPreviewNode(
		container: HTMLElement,
		task: IndexedTask,
		preset: KanbanPreset,
		pipeline: Pipeline | null,
		depth: number,
	): void {
		this.renderTaskCard(container, task, pipeline, preset, null, KANBAN_NO_VALUE_KEY, true, depth);
		const children = this.getPreviewChildren(task.operonId);
		if (children.length === 0) return;
		const childrenWrap = container.createDiv('operon-kanban-preview-children');
		for (const child of children) {
			this.renderPreviewNode(childrenWrap, child, preset, pipeline, depth + 1);
		}
	}

	private getPreviewChildren(parentId: string): IndexedTask[] {
		const comparator = buildKanbanTaskComparator({
			preset: this.resolveCurrentPreset(),
			priorities: this.getSettings().priorities,
		});
		return [...this.indexer.secondary.getChildIds(parentId)]
			.map(childId => this.indexer.getTask(childId))
			.filter((task): task is IndexedTask => !!task)
			.sort((left, right) => {
				const stateCompare = this.getPreviewChildStateBucket(left) - this.getPreviewChildStateBucket(right);
				if (stateCompare !== 0) return stateCompare;
				return comparator(left, right);
			});
	}

	private getPreviewChildStateBucket(task: IndexedTask): number {
		if (task.checkbox === 'open') return 0;
		if (task.checkbox === 'done') return 1;
		return 2;
	}

	private buildDescendantSummary(parentId: string): { open: number; total: number } {
		const generation = this.indexer.getGeneration();
		const cached = this.descendantSummaryCache.get(parentId);
		if (cached?.generation === generation) {
			return { open: cached.open, total: cached.total };
		}
		const parentTask = this.indexer.getTask(parentId);
		const statsSummary = parentTask ? resolveKanbanDescendantSummaryFromStats(parentTask.fieldValues) : null;
		if (statsSummary) {
			const summary = { generation, open: statsSummary.open, total: statsSummary.total };
			this.descendantSummaryCache.set(parentId, summary);
			return { open: summary.open, total: summary.total };
		}
		const descendantIds = [...this.indexer.secondary.getAllDescendantIds(parentId)];
		let open = 0;
		for (const descendantId of descendantIds) {
			const task = this.indexer.getTask(descendantId);
			if (task?.checkbox === 'open') open += 1;
		}
		const summary = { generation, open, total: descendantIds.length };
		this.descendantSummaryCache.set(parentId, summary);
		return { open: summary.open, total: summary.total };
	}

	private reconcileOptimisticMoves(_board: KanbanBoardData, pipeline: Pipeline | null, preset: KanbanPreset): void {
		if (this.optimisticMoves.size === 0) return;
		const now = Date.now();
		for (const [taskId, move] of this.optimisticMoves) {
			if (Number.isFinite(move.expiresAt) && move.expiresAt < now) {
				this.optimisticMoves.delete(taskId);
				continue;
			}
			const task = this.indexer.getTask(taskId);
			if (!task || !pipeline) {
				this.optimisticMoves.delete(taskId);
				continue;
			}
			if (isKanbanOptimisticMoveSatisfied(task, pipeline, preset, move)) {
				this.optimisticMoves.delete(taskId);
			}
		}
	}

	private applyOptimisticMoves(board: KanbanBoardData, settings: OperonSettings): void {
		applyKanbanOptimisticMovesToBoard(board, settings.priorities, this.optimisticMoves.values());
	}

	private bindCellDropTarget(
		cell: HTMLElement,
		column: KanbanColumn,
		lane: KanbanLane,
		preset: KanbanPreset,
	): void {
		cell.addEventListener('dragenter', event => {
			if (!this.draggedCardContext) return;
			event.preventDefault();
			this.hideCellQuickAdd(cell);
			cell.addClass('is-drop-target');
			this.updateManualDropIndicator(cell, event, preset);
		});
		cell.addEventListener('dragover', event => {
			if (!this.draggedCardContext) return;
			event.preventDefault();
			event.dataTransfer!.dropEffect = 'move';
			this.hideCellQuickAdd(cell);
			cell.addClass('is-drop-target');
			this.updateManualDropIndicator(cell, event, preset);
		});
		cell.addEventListener('dragleave', event => {
			const related = event.relatedTarget;
			if (related instanceof Node && cell.contains(related)) return;
			cell.removeClass('is-drop-target');
			this.clearManualDropIndicator(cell);
		});
		cell.addEventListener('drop', event => {
			if (!this.draggedCardContext || !this.callbacks.onCardDrop) return;
			event.preventDefault();
			this.hideCellQuickAdd(cell);
			cell.removeClass('is-drop-target');
			const dragged = this.draggedCardContext;
			const targetBeforeTaskId = preset.sortMode === 'manual'
				? this.resolveManualDropBeforeTaskId(cell, event, preset)
				: null;
			const context: KanbanDropContext = {
				taskId: dragged.taskId,
				sourceStatusId: dragged.sourceStatusId,
				sourceLaneKey: dragged.sourceLaneKey,
				targetStatusId: column.statusId,
				targetLaneKey: lane.key,
				swimlaneBy: preset.swimlaneBy,
				targetBeforeTaskId,
			};
			this.draggedCardContext = null;
			this.clearManualDropIndicator(cell);
			if (
				preset.sortMode !== 'manual'
				&& context.sourceStatusId === context.targetStatusId
				&& context.sourceLaneKey === context.targetLaneKey
			) {
				return;
			}

			this.registerOptimisticMove(context);
			if (shouldApplyImmediateKanbanCardDrop(cell.classList.contains('is-collapsed'))) {
				this.applyImmediateCardDrop(cell, dragged.cardEl, targetBeforeTaskId);
			} else {
				dragged.cardEl.removeClass('is-dragging');
				this.render();
			}
			void Promise.resolve(this.callbacks.onCardDrop(context))
				.then(() => {
					this.markDirty();
				})
				.catch(error => {
					console.error('Operon: Kanban card drop failed', error);
					new Notice(t('notifications', 'kanbanActionFailed'));
					this.optimisticMoves.delete(context.taskId);
					this.markDirty();
				});
		});
	}

	private updateManualDropIndicator(cell: HTMLElement, event: DragEvent, preset: KanbanPreset): void {
		if (preset.sortMode !== 'manual' || cell.classList.contains('is-collapsed')) {
			this.clearManualDropIndicator(cell);
			return;
		}
		const beforeCard = this.findManualDropBeforeCard(cell, event.clientY);
		const indicator = this.ensureManualDropIndicator(cell);
		let beforeTaskId = beforeCard?.dataset.operonTaskId ?? '';
		if (beforeCard) {
			cell.insertBefore(indicator, beforeCard);
		} else {
			const sentinel = cell.querySelector<HTMLElement>(':scope > .operon-kanban-lazy-sentinel');
			if (sentinel) {
				cell.insertBefore(indicator, sentinel);
				beforeTaskId = sentinel.dataset.kanbanNextTaskId ?? '';
			} else {
				cell.appendChild(indicator);
			}
		}
		cell.dataset.kanbanDropBeforeTaskId = beforeTaskId;
	}

	private resolveManualDropBeforeTaskId(cell: HTMLElement, event: DragEvent, preset: KanbanPreset): string | null {
		this.updateManualDropIndicator(cell, event, preset);
		const beforeTaskId = cell.dataset.kanbanDropBeforeTaskId ?? '';
		return beforeTaskId || null;
	}

	private ensureManualDropIndicator(cell: HTMLElement): HTMLElement {
		const existing = cell.querySelector<HTMLElement>(':scope > .operon-kanban-drop-indicator');
		if (existing) return existing;
		const indicator = cell.createDiv('operon-kanban-drop-indicator');
		indicator.setAttr('aria-hidden', 'true');
		return indicator;
	}

	private findManualDropBeforeCard(cell: HTMLElement, pointerY: number): HTMLElement | null {
		const cards = Array.from(cell.querySelectorAll<HTMLElement>(':scope > .operon-kanban-card'))
			.filter(card => card.dataset.kanbanPreview !== 'true')
			.filter(card => !card.classList.contains('is-dragging'));
		return cards.find(card => {
			const rect = card.getBoundingClientRect();
			return pointerY < rect.top + rect.height / 2;
		}) ?? null;
	}

	private clearManualDropIndicators(root: HTMLElement): void {
		for (const cell of Array.from(root.querySelectorAll<HTMLElement>('.operon-kanban-cell'))) {
			this.clearManualDropIndicator(cell);
		}
	}

	private clearManualDropIndicator(cell: HTMLElement): void {
		cell.querySelector<HTMLElement>(':scope > .operon-kanban-drop-indicator')?.remove();
		delete cell.dataset.kanbanDropBeforeTaskId;
	}

	private applyImmediateCardDrop(targetCell: HTMLElement, cardEl: HTMLElement, beforeTaskId: string | null): void {
		if (!cardEl.isConnected) return;
		cardEl.removeClass('is-dragging');
		cardEl.addClass('is-optimistic-move');
		const beforeCard = beforeTaskId
			? Array.from(targetCell.querySelectorAll<HTMLElement>(':scope > .operon-kanban-card'))
				.find(card => card.dataset.operonTaskId === beforeTaskId && card !== cardEl) ?? null
			: null;
		const sentinel = targetCell.querySelector<HTMLElement>(':scope > .operon-kanban-lazy-sentinel');
		if (beforeCard) {
			targetCell.insertBefore(cardEl, beforeCard);
		} else if (sentinel) {
			targetCell.insertBefore(cardEl, sentinel);
		} else {
			targetCell.appendChild(cardEl);
		}
		const cardCount = targetCell.querySelectorAll(':scope > .operon-kanban-card').length;
		this.applyCellHeightLimit(targetCell, this.getSettings().kanbanMaxVisibleTasksPerCell, cardCount);
		const boardEl = targetCell.closest<HTMLElement>('.operon-kanban-board');
		if (!boardEl) return;
		const laneLabels = Array.from(boardEl.querySelectorAll<HTMLElement>('.operon-kanban-lane-label'));
		const gridRows = Array.from(boardEl.querySelectorAll<HTMLElement>('.operon-kanban-row'));
		this.syncRowCellHeights(gridRows);
		this.syncLaneHeights(laneLabels, gridRows);
	}

	private registerOptimisticMove(context: KanbanDropContext): void {
		this.optimisticMoves.set(context.taskId, createKanbanDropOptimisticMove(context));
	}

	private bindCellQuickAdd(
		cell: HTMLElement,
		column: KanbanColumn,
		lane: KanbanLane,
		preset: KanbanPreset,
		gridViewport: HTMLElement,
	): void {
		if (!this.callbacks.onCellAction) return;
		const overlay = cell.createDiv('operon-kanban-cell-add-overlay');
			const button = overlay.createEl('button', {
				cls: 'operon-kanban-cell-add-button',
				attr: {
					type: 'button',
				},
			});
			setIcon(button, 'list-plus');
			if (!button.querySelector('svg')) {
				setIcon(button, 'list');
			}
			setAccessibleLabelWithoutTooltip(button, preset.swimlaneBy
				? t('tooltips', 'addTaskToKanbanCell', {
					status: column.statusLabel,
					lane: lane.label,
				})
				: t('tooltips', 'addTaskToKanbanStatus', {
					status: column.statusLabel,
				}));
		const actionContext: KanbanCellActionContext = {
			targetStatusId: column.statusId,
			targetStatusLabel: column.statusLabel,
			targetLaneKey: lane.key,
			targetLaneLabel: lane.label,
			swimlaneBy: preset.swimlaneBy,
			pipelineId: preset.pipelineId,
		};
		button.addEventListener('pointerdown', event => {
			event.preventDefault();
			event.stopPropagation();
		});
		button.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			this.hideCellQuickAdd(cell);
			void this.callbacks.onCellAction?.(actionContext);
		});

		let isVisible = false;
		const setVisible = (nextVisible: boolean): void => {
			if (isVisible === nextVisible) return;
			isVisible = nextVisible;
			cell.classList.toggle('is-add-hotspot-active', nextVisible);
			overlay.classList.toggle('is-visible', nextVisible);
		};
		const updateFromPointer = (event: PointerEvent): void => {
			if (this.draggedCardContext) {
				setVisible(false);
				return;
			}
			const rect = cell.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				setVisible(false);
				return;
			}
			const xRatio = (event.clientX - rect.left) / rect.width;
			const yRatio = (event.clientY - rect.top) / rect.height;
			const isWithinCenter = xRatio >= 0.375 && xRatio <= 0.625
				&& yRatio >= 0.375 && yRatio <= 0.625;
			setVisible(isWithinCenter);
		};

		cell.addEventListener('pointermove', updateFromPointer);
		cell.addEventListener('pointerleave', () => setVisible(false));
		cell.addEventListener('scroll', () => setVisible(false));
		gridViewport.addEventListener('scroll', () => setVisible(false));
		cell.addEventListener('dragstart', () => setVisible(false));
		cell.addEventListener('drop', () => setVisible(false));
	}

	private hideCellQuickAdd(cell: HTMLElement): void {
		cell.classList.remove('is-add-hotspot-active');
		const overlay = cell.querySelector<HTMLElement>('.operon-kanban-cell-add-overlay');
		overlay?.classList.remove('is-visible');
	}

	private renderStatusButton(
		container: HTMLElement,
		task: IndexedTask,
		pipeline: Pipeline | null,
		preset: KanbanPreset,
		statusId: string | null,
		laneKey: string,
	): void {
		if (!this.callbacks.onStatusIconClick) return;
			const button = container.createEl('button', {
				cls: 'operon-checkbox operon-calendar-status-button is-compact',
				attr: {
					type: 'button',
				},
			});
		const iconName = resolveTaskDisplayIcon(this.getSettings(), task.fieldValues, task.checkbox);
			if (iconName) {
				setIcon(button, iconName);
			}
			setAccessibleLabelWithoutTooltip(button, t('tooltips', 'cycleTaskStatus'));
		const statusDef = findStatusDef(this.getSettings().pipelines, task.fieldValues['status'] ?? '');
		if (statusDef?.color) {
			button.style.color = statusDef.color;
		}
		button.addEventListener('pointerdown', event => {
			event.preventDefault();
			event.stopPropagation();
		});
		button.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			this.invokeKanbanStatusIconClick(task, pipeline, preset, statusId, laneKey);
		});
	}

	private invokeKanbanStatusIconClick(
		task: IndexedTask,
		pipeline: Pipeline | null,
		preset: KanbanPreset,
		statusId: string | null,
		laneKey: string,
	): void {
		if (!this.callbacks.onStatusIconClick) return;
		const startedAt = enginePerfNow();
		const plan = buildKanbanOptimisticStatusMovePlan({
			task,
			pipeline,
			preset,
			pipelines: this.getSettings().pipelines,
			sourceStatusId: statusId,
			sourceLaneKey: laneKey,
		});
		const applied = plan.move !== null;
		const fallbackReason = applied ? 'none' : plan.fallbackReason;
		if (applied) {
			this.optimisticMoves.set(task.operonId, plan.move);
			this.render();
		}

		enginePerfLog(
			'kanban.optimisticStatus',
			`taskId=${task.operonId}`,
			`applied=${String(applied)}`,
			`nextStatus=${applied ? plan.nextStatus : 'none'}`,
			`nextCheckbox=${applied ? plan.nextCheckbox : 'none'}`,
			`sourceLanes=${applied ? plan.sourceLaneKeys.join(',') : 'none'}`,
			`targetStatusId=${applied ? plan.targetStatusId : 'none'}`,
			`renderMs=${Math.round(enginePerfNow() - startedAt)}`,
			`fallbackReason=${fallbackReason}`,
		);

		void Promise.resolve(this.callbacks.onStatusIconClick(task.operonId))
			.then(() => {
				if (applied) this.markDirty();
			})
			.catch(error => {
				console.error('Operon: Kanban status click failed', error);
				new Notice(t('notifications', 'kanbanActionFailed'));
				this.optimisticMoves.delete(task.operonId);
				this.markDirty();
			});
	}

	private applyTaskColor(element: HTMLElement, task: IndexedTask, preset: KanbanPreset): void {
		if (preset.colorSource === 'noColor') {
			element.setCssProps({ '--operon-calendar-accent': 'transparent' });
			return;
		}
		const resolvedColor = resolveTaskColorSourceForTask(task, preset.colorSource, this.getSettings());
		if (!resolvedColor) {
			element.style.removeProperty('--operon-calendar-accent');
			return;
		}
		element.style.setProperty('--operon-calendar-accent', resolvedColor);
	}

	private bindHoverMenuTarget(triggerEl: HTMLElement, task: IndexedTask): void {
		if (!this.callbacks.onItemAction) return;
		triggerEl.addEventListener('pointerenter', () => {
			if (this.hoverMenu.isActive(task.operonId)) {
				this.hoverMenu.clearHideTimer();
				return;
			}
			const context = this.resolveHoverContext(task);
			const actions = this.resolveHoverActions(context);
			if (actions.length === 0) return;
			this.scheduleHoverMenuShow(() => {
				this.showHoverMenu(triggerEl, task.operonId, actions, context);
			});
		});
		triggerEl.addEventListener('pointerleave', event => {
			this.clearHoverMenuShowTimer();
			const related = event.relatedTarget;
			if (this.hoverMenu.contains(related)) {
				this.clearHoverMenuHideTimer();
				return;
			}
			this.scheduleHoverMenuHide();
		});
	}

	private resolveHoverContext(task: IndexedTask): ContextualMenuContext {
		return {
			surface: 'kanbanCard',
			taskId: task.operonId,
			task,
			now: localNow(),
			isPinned: this.getPinnedCache()?.isPinned(task.operonId) ?? false,
		};
	}

	private resolveHoverActions(context: ContextualMenuContext): ResolvedContextualMenuAction[] {
		const settings = this.getSettings();
		return resolveContextualMenu(
			context,
			settings.contextualMenuActionAllowlist,
			settings.contextualMenuSurfaceActionMatrix,
		);
	}

	private showHoverMenu(
		anchorEl: HTMLElement,
		taskId: string,
		actions: ResolvedContextualMenuAction[],
		context: ContextualMenuContext,
	): void {
		if (actions.length === 0 || !this.callbacks.onItemAction) return;
		this.hoverMenu.show({
			key: taskId,
			taskId,
			actions,
			anchorRect: anchorEl.getBoundingClientRect(),
			context,
			onAction: this.callbacks.onItemAction,
		});
	}

	private positionHoverMenu(anchorRect: DOMRect, menu: HTMLElement): boolean {
		const host = this.containerEl.children[1] as HTMLElement | undefined;
		if (!host) return false;
		const hostRect = host.getBoundingClientRect();
		const position = resolveContextualHoverMenuPosition(
			anchorRect,
			hostRect,
			menu.getBoundingClientRect(),
		);
		if (!position) return false;
		menu.style.left = `${position.left - hostRect.left}px`;
		menu.style.top = `${position.top - hostRect.top}px`;
		menu.style.width = `${position.width}px`;
		menu.style.maxHeight = `${Math.floor(position.maxHeight)}px`;
		return true;
	}

	private scheduleHoverMenuHide(): void {
		this.hoverMenu.scheduleHide();
	}

	private scheduleHoverMenuShow(callback: () => void): void {
		this.hoverMenu.scheduleShow(callback);
	}

	private clearHoverMenuShowTimer(): void {
		this.hoverMenu.clearShowTimer();
	}

	private clearHoverMenuHideTimer(): void {
		this.hoverMenu.clearHideTimer();
	}

	private hideHoverMenu(immediate = true): void {
		this.hoverMenu.hide(immediate);
	}

	private buildColumnTemplate(columns: KanbanColumn[], collapsedStatusIds: string[]): string {
		return columns.map(column => collapsedStatusIds.includes(column.statusId)
			? 'var(--operon-kanban-collapsed-width)'
			: 'var(--operon-kanban-column-width)')
			.join(' ');
	}

	private renderCornerSummary(container: HTMLElement, totalTasks: number): void {
		container.empty();
		container.createDiv({
			text: String(totalTasks),
			cls: 'operon-kanban-corner-total',
		});
	}

	private renderCollapsedCellSummary(container: HTMLElement, count: number): void {
		container.empty();
		const summary = container.createDiv('operon-kanban-collapsed-cell-summary');
		summary.setText(String(count));
	}

	private scheduleLaneColumnWidthRefresh(boardEl: HTMLElement, laneTitles: HTMLElement[]): void {
		this.clearLaneColumnWidthFrame();
		this.laneColumnWidthFrame = window.requestAnimationFrame(() => {
			this.laneColumnWidthFrame = null;
			this.refreshLaneColumnWidth(boardEl, laneTitles);
		});
	}

	private measureLaneTitleNaturalWidth(title: HTMLElement): number {
		const text = title.textContent ?? '';
		if (!text) return 0;
		const computed = getOwnerWindow(title).getComputedStyle(title);
		const measurer = createOwnerElement(title, 'span');
		measurer.addClass('operon-kanban-lane-measurer');
		measurer.textContent = text;
		measurer.style.font = computed.font;
		measurer.style.fontWeight = computed.fontWeight;
		measurer.style.fontSize = computed.fontSize;
		measurer.style.fontFamily = computed.fontFamily;
		measurer.style.letterSpacing = computed.letterSpacing;
		measurer.style.textTransform = computed.textTransform;
		getOwnerBody(title).appendChild(measurer);
		const width = measurer.getBoundingClientRect().width;
		measurer.remove();
		return width;
	}

	private refreshLaneColumnWidth(boardEl: HTMLElement, laneTitles: HTMLElement[]): void {
		const firstLabel = boardEl.querySelector<HTMLElement>('.operon-kanban-lane-label');
		const countButton = boardEl.querySelector<HTMLElement>('.operon-kanban-lane-count-button');
		if (!firstLabel || !countButton || laneTitles.length === 0) {
			this.lastLaneColumnWidthPx = 96;
			boardEl.setCssProps({ '--operon-kanban-lane-column-width': '96px' });
			return;
		}
		const computed = window.getComputedStyle(firstLabel);
		const gap = Number.parseFloat(computed.columnGap || computed.gap || '0') || 0;
		const paddingInline =
			(Number.parseFloat(computed.paddingLeft || '0') || 0) +
			(Number.parseFloat(computed.paddingRight || '0') || 0);
		const countWidth = countButton.getBoundingClientRect().width;
		let maxTitleWidth = 0;
		for (const title of laneTitles) {
			maxTitleWidth = Math.max(maxTitleWidth, this.measureLaneTitleNaturalWidth(title));
		}
		const widthPx = Math.max(96, Math.ceil(maxTitleWidth + countWidth + gap + paddingInline));
		this.lastLaneColumnWidthPx = widthPx;
		boardEl.style.setProperty('--operon-kanban-lane-column-width', `${widthPx}px`);
	}

	private clearLaneColumnWidthFrame(): void {
		if (this.laneColumnWidthFrame === null) return;
		window.cancelAnimationFrame(this.laneColumnWidthFrame);
		this.laneColumnWidthFrame = null;
	}

	private bindBoardLayoutRefresh(
		boardEl: HTMLElement,
		laneLabels: HTMLElement[],
		gridRows: HTMLElement[],
		laneTitles: HTMLElement[],
		hasSwimlanes: boolean,
	): void {
		const refresh = (): void => {
			if (!boardEl.isConnected || boardEl.getBoundingClientRect().width <= 0) return;
			this.syncRowCellHeights(gridRows);
			if (hasSwimlanes) {
				this.syncLaneHeights(laneLabels, gridRows);
				this.scheduleLaneColumnWidthRefresh(boardEl, laneTitles);
			}
		};
		const scheduleRefresh = (): void => {
			if (this.boardLayoutRefreshFrame !== null) return;
			this.boardLayoutRefreshFrame = window.requestAnimationFrame(() => {
				this.boardLayoutRefreshFrame = null;
				refresh();
			});
		};

		this.clearBoardLayoutRefresh();
		scheduleRefresh();
		window.requestAnimationFrame(scheduleRefresh);
		window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleRefresh));
		window.setTimeout(scheduleRefresh, 0);
		window.setTimeout(scheduleRefresh, 120);

		const observer = new ResizeObserver(() => scheduleRefresh());
		observer.observe(boardEl);
		if (boardEl.parentElement) observer.observe(boardEl.parentElement);
		for (const gridRow of gridRows) {
			observer.observe(gridRow);
		}
		this.boardLayoutRefreshCleanup = () => observer.disconnect();
	}

	private clearBoardLayoutRefresh(): void {
		if (this.boardLayoutRefreshFrame !== null) {
			window.cancelAnimationFrame(this.boardLayoutRefreshFrame);
			this.boardLayoutRefreshFrame = null;
		}
		this.boardLayoutRefreshCleanup?.();
		this.boardLayoutRefreshCleanup = null;
	}

	private scheduleBoardLayoutRefreshFromCell(cell: HTMLElement): void {
		const boardEl = cell.closest<HTMLElement>('.operon-kanban-board');
		if (!boardEl || this.boardLayoutRefreshFrame !== null) return;
		this.boardLayoutRefreshFrame = window.requestAnimationFrame(() => {
			this.boardLayoutRefreshFrame = null;
			if (!boardEl.isConnected) return;
			const laneLabels = Array.from(boardEl.querySelectorAll<HTMLElement>('.operon-kanban-lane-label'));
			const gridRows = Array.from(boardEl.querySelectorAll<HTMLElement>('.operon-kanban-row'));
			const laneTitles = Array.from(boardEl.querySelectorAll<HTMLElement>('.operon-kanban-lane-title'));
			this.syncRowCellHeights(gridRows);
			if (!boardEl.classList.contains('is-no-swimlanes')) {
				this.syncLaneHeights(laneLabels, gridRows);
				this.scheduleLaneColumnWidthRefresh(boardEl, laneTitles);
			}
		});
	}

	private clearKanbanLazyObservers(): void {
		for (const observer of this.kanbanLazyObservers) {
			observer.disconnect();
		}
		this.kanbanLazyObservers = [];
	}

	private renderEmptyState(container: HTMLElement, text: string): void {
		const empty = container.createDiv('operon-kanban-empty-state');
		empty.setText(text);
	}

	private resolveCollapsedStatusIds(board: KanbanBoardData, state: KanbanLeafState, searchActive: boolean): Set<string> {
		if (searchActive) {
			return new Set(
				board.columns
					.filter(column => column.count === 0)
					.map(column => column.statusId),
			);
		}
		const collapsed = new Set(state.collapsedStatusIds);
		if (board.preset.collapseEmptyColumns) {
			for (const column of board.columns) {
				if (column.count === 0 && !this.temporarilyExpandedAutoCollapsedStatusIds.has(column.statusId)) {
					collapsed.add(column.statusId);
				}
			}
		}
		if (board.preset.autoCollapseFinishedColumns) {
			for (const column of board.columns) {
				if (column.isFinished && !this.temporarilyExpandedAutoCollapsedStatusIds.has(column.statusId)) {
					collapsed.add(column.statusId);
				}
			}
		}
		return collapsed;
	}

	private resolveSkippedStatusMaterializationIds(
		pipeline: Pipeline,
		preset: KanbanPreset,
		state: KanbanLeafState,
	): Set<string> {
		const skipped = new Set(
			state.collapsedStatusIds.filter(statusId => pipeline.statuses.some(status => status.id === statusId)),
		);
		if (preset.autoCollapseFinishedColumns) {
			for (const status of pipeline.statuses) {
				if (status.isFinished && !this.temporarilyExpandedAutoCollapsedStatusIds.has(status.id)) {
					skipped.add(status.id);
				}
			}
		}
		return skipped;
	}

	private resolveCollapsedLaneKeys(board: KanbanBoardData, state: KanbanLeafState, searchActive: boolean): Set<string> {
		if (searchActive) {
			return new Set(
				board.lanes
					.filter(lane => lane.count === 0)
					.map(lane => lane.key),
			);
		}
		const collapsed = new Set(state.collapsedLaneKeys);
		if (!board.preset.collapseEmptySwimlanes) return collapsed;
		for (const lane of board.lanes) {
			if (lane.count === 0 && !this.temporarilyExpandedAutoCollapsedLaneKeys.has(lane.key)) {
				collapsed.add(lane.key);
			}
		}
		return collapsed;
	}

	private captureBoardScrollState(container: HTMLElement): void {
		const board = asHTMLElement(container.querySelector('.operon-kanban-grid-viewport'), container);
		if (!board) return;
		this.lastBoardScrollState = {
			left: board.scrollLeft,
			top: board.scrollTop,
		};
	}

	private restoreBoardScrollState(board: HTMLElement): void {
		const { left, top } = this.lastBoardScrollState;
		if (left === 0 && top === 0) return;
		board.scrollLeft = left;
		board.scrollTop = top;
	}

	private bindBoardScrollStateTracking(gridViewport: HTMLElement): void {
		gridViewport.addEventListener('scroll', () => {
			this.lastBoardScrollState = {
				left: gridViewport.scrollLeft,
				top: gridViewport.scrollTop,
			};
		});
	}

	private syncLaneHeights(laneLabels: HTMLElement[], gridRows: HTMLElement[]): void {
		for (let index = 0; index < laneLabels.length; index++) {
			const laneLabel = laneLabels[index];
			const gridRow = gridRows[index];
			if (!laneLabel || !gridRow) continue;
			laneLabel.style.height = `${Math.ceil(gridRow.getBoundingClientRect().height)}px`;
		}
	}

	private syncRowCellHeights(gridRows: HTMLElement[]): void {
		for (const gridRow of gridRows) {
			gridRow.querySelector<HTMLElement>(':scope > .operon-kanban-lane-label')?.style.removeProperty('height');
			const rowHeight = Math.ceil(gridRow.getBoundingClientRect().height);
			if (rowHeight <= 0) continue;
			const cells = Array.from(gridRow.children)
				.map(child => asHTMLElement(child))
				.filter((child): child is HTMLElement => child !== null)
				.filter(child => child.classList.contains('operon-kanban-cell'));
			for (const cell of cells) {
				if (
					cell.classList.contains('is-scroll-limited')
					&& !cell.classList.contains('is-collapsed')
				) {
					cell.style.maxHeight = `${rowHeight}px`;
				}
			}
		}
	}

	private applyCellHeightLimit(cell: HTMLElement, maxVisibleTasks: number, totalTaskCount: number): void {
		cell.classList.remove('is-scroll-limited');
		cell.style.removeProperty('max-height');
		if (!Number.isFinite(maxVisibleTasks) || maxVisibleTasks < 1) return;
		if (totalTaskCount <= maxVisibleTasks) return;

		const topLevelCards = Array.from(cell.children)
			.map(child => asHTMLElement(child))
			.filter((child): child is HTMLElement => child !== null)
			.filter(child => child.classList.contains('operon-kanban-card'));
		if (topLevelCards.length === 0) return;

		const styles = window.getComputedStyle(cell);
		const gap = Number.parseFloat(styles.rowGap || styles.gap || '0') || 0;
		const paddingTop = Number.parseFloat(styles.paddingTop || '0') || 0;
		const paddingBottom = Number.parseFloat(styles.paddingBottom || '0') || 0;
		const borderTop = Number.parseFloat(styles.borderTopWidth || '0') || 0;
		const borderBottom = Number.parseFloat(styles.borderBottomWidth || '0') || 0;

		let maxHeight = paddingTop + paddingBottom + borderTop + borderBottom;
		for (let index = 0; index < maxVisibleTasks; index++) {
			const card = topLevelCards[index];
			if (!card) break;
			maxHeight += card.offsetHeight;
			if (index > 0) {
				maxHeight += gap;
			}
		}

		cell.style.maxHeight = `${Math.ceil(maxHeight)}px`;
		cell.classList.add('is-scroll-limited');
	}

	private ensureState(): KanbanLeafState {
		if (this.state) return this.state;
		const nextState = this.normalizeState(null);
		this.state = nextState;
		return nextState;
	}

	private resolveCurrentPreset(): KanbanPreset {
		const settings = this.getSettings();
		const state = this.ensureState();
		const fallbackPreset = settings.kanbanPresets.find(entry => entry.id === settings.kanbanDefaultPresetId)
			?? settings.kanbanPresets[0];
		return settings.kanbanPresets.find(entry => entry.id === state.presetId)
			?? fallbackPreset;
	}

	private normalizeState(state: Partial<KanbanLeafState> | null | undefined): KanbanLeafState {
		const settings = this.getSettings();
		const availablePresetIds = settings.kanbanPresets.map(entry => entry.id);
		const fallbackPresetId = settings.kanbanDefaultPresetId ?? settings.kanbanPresets[0]?.id ?? null;
		const requestedPresetId = typeof state?.presetId === 'string' && state.presetId.trim()
			? state.presetId
			: fallbackPresetId;
		const preset = settings.kanbanPresets.find(entry => entry.id === requestedPresetId)
			?? settings.kanbanPresets.find(entry => entry.id === fallbackPresetId)
			?? settings.kanbanPresets[0]
			?? null;
		const pipeline = preset?.pipelineId
			? settings.pipelines.find(entry => entry.id === preset.pipelineId) ?? null
			: null;
		return normalizeKanbanLeafState(state, {
			availablePresetIds,
			availableStatusIds: pipeline?.statuses.map(status => status.id) ?? [],
			defaultPresetId: fallbackPresetId,
		});
	}

	private areLeafStatesEqual(left: KanbanLeafState | null, right: KanbanLeafState | null): boolean {
		if (!left || !right) return left === right;
		return left.presetId === right.presetId
			&& left.searchQuery === right.searchQuery
			&& left.collapsedStatusIds.join('||') === right.collapsedStatusIds.join('||')
			&& left.collapsedLaneKeys.join('||') === right.collapsedLaneKeys.join('||')
			&& JSON.stringify(left.collapsedStatusIdsByPreset) === JSON.stringify(right.collapsedStatusIdsByPreset)
			&& JSON.stringify(left.collapsedLaneKeysByPreset) === JSON.stringify(right.collapsedLaneKeysByPreset)
			&& left.expandedPreviewParentIds.join('||') === right.expandedPreviewParentIds.join('||');
	}

	private async updateLeafState(nextState: KanbanLeafState): Promise<void> {
		const normalized = this.normalizeState(this.withCurrentPresetCollapseState(nextState));
		const changed = !this.areLeafStatesEqual(this.state, normalized);
		const presetChanged = this.state?.presetId !== normalized.presetId;
		this.state = normalized;
		if (!changed) return;
		if (presetChanged) {
			this.temporarilyExpandedAutoCollapsedStatusIds.clear();
			this.temporarilyExpandedAutoCollapsedLaneKeys.clear();
			this.clearParentSearchState();
			this.syncLeafTitle();
		}
		this.render();
		this.scheduleLeafStatePersistence();
	}

	private scheduleRender(resetTemporaryExpandedFinishedColumns: boolean): void {
		if (resetTemporaryExpandedFinishedColumns) {
			this.temporarilyExpandedAutoCollapsedStatusIds.clear();
			this.temporarilyExpandedAutoCollapsedLaneKeys.clear();
		}
		if (this.renderFrame !== null) return;
		this.renderFrame = window.requestAnimationFrame(() => {
			this.renderFrame = null;
			this.render();
		});
	}

	private isStatusAutoCollapsed(board: KanbanBoardData, column: KanbanColumn): boolean {
		return (board.preset.collapseEmptyColumns && column.count === 0)
			|| (board.preset.autoCollapseFinishedColumns && column.isFinished);
	}

	private isLaneAutoCollapsed(board: KanbanBoardData, lane: KanbanLane): boolean {
		return board.preset.collapseEmptySwimlanes && lane.count === 0;
	}

	private withCurrentPresetCollapseState(
		nextState: Partial<KanbanLeafState>,
	): KanbanLeafState {
		const current = this.state ?? this.normalizeState(null);
		const merged: KanbanLeafState = {
			...current,
			...nextState,
			collapsedStatusIdsByPreset: {
				...current.collapsedStatusIdsByPreset,
				...(nextState.collapsedStatusIdsByPreset ?? {}),
			},
			collapsedLaneKeysByPreset: {
				...current.collapsedLaneKeysByPreset,
				...(nextState.collapsedLaneKeysByPreset ?? {}),
			},
		};
		if (merged.presetId) {
			merged.collapsedStatusIdsByPreset[merged.presetId] = Array.from(new Set(merged.collapsedStatusIds));
			merged.collapsedLaneKeysByPreset[merged.presetId] = Array.from(new Set(merged.collapsedLaneKeys));
		}
		return merged;
	}

	private buildStateForPresetSwitch(targetPresetId: string): KanbanLeafState {
		const persisted = this.withCurrentPresetCollapseState({});
		return {
			...persisted,
			presetId: targetPresetId,
			collapsedStatusIds: [...(persisted.collapsedStatusIdsByPreset[targetPresetId] ?? [])],
			collapsedLaneKeys: [...(persisted.collapsedLaneKeysByPreset[targetPresetId] ?? [])],
		};
	}

	private getActiveSearchQuery(rawQuery: string, parentSearchUi: KanbanParentSearchUiState | null): string {
		if (parentSearchUi && !parentSearchUi.selectedParentId) return '';
		return resolveTaskSearchBoxTextQuery(rawQuery, KANBAN_SEARCH_MIN_QUERY_LENGTH);
	}

	private buildParentSearchUiState(
		rawQuery: string,
		pipeline: Pipeline,
		filterSet: FilterSet | null,
		settings: OperonSettings,
		scope: TaskSearchBoxScopeState,
	): KanbanParentSearchUiState | null {
		const mode = scope.projectMode;
		if (!mode) return null;
		const scopedTasks = this.getCurrentSearchScopeTasks(filterSet, pipeline, settings, scope);
		const trimmedQuery = rawQuery.trim();
		const queryMeetsThreshold = !trimmedQuery || trimmedQuery.length >= KANBAN_SEARCH_MIN_QUERY_LENGTH;
		const normalizedQuery = queryMeetsThreshold ? trimmedQuery.toLocaleLowerCase() : '';
		const candidates = queryMeetsThreshold
			? this.buildParentSearchCandidates(scopedTasks, normalizedQuery)
			: [];
		const selectedParentId = this.parentSearchSelection?.mode === mode
			&& scopedTasks.some(task => task.operonId === this.parentSearchSelection?.parentId)
			? this.parentSearchSelection.parentId
			: null;
		if (!selectedParentId) {
			this.parentSearchSelection = null;
		}
		this.parentSearchHighlightedIndex = Math.min(
			Math.max(this.parentSearchHighlightedIndex, 0),
			Math.max(0, candidates.length - 1),
		);
		return {
			mode,
			query: normalizedQuery,
			candidates,
			selectedParentId,
			dropdownVisible: !this.parentSearchDismissed && !selectedParentId,
		};
	}

	private getCurrentScopeTasks(
		filterSet: FilterSet | null,
		pipeline: Pipeline,
		settings: OperonSettings,
	): IndexedTask[] {
		return filterTasksForCalendar(
			filterSet,
			this.indexer.getAllTasks(),
			settings.priorities,
			this.getPinnedCache(),
			).filter(task => isTaskInPipeline(task, pipeline));
	}

	private getCurrentSearchScopeTasks(
		filterSet: FilterSet | null,
		pipeline: Pipeline,
		settings: OperonSettings,
		scope: TaskSearchBoxScopeState,
	): IndexedTask[] {
		return this.getCurrentScopeTasks(filterSet, pipeline, settings)
			.filter(task => matchesTaskSearchBoxScope(task, scope));
	}

	private resolveKanbanSearchTaskIdFilter(
		scope: TaskSearchBoxScopeState,
		filterSet: FilterSet | null,
		pipeline: Pipeline,
		settings: OperonSettings,
		parentSearchUi: KanbanParentSearchUiState | null,
	): Set<string> | undefined {
		if (!this.hasKanbanSearchScopeFilters(scope) && !parentSearchUi?.selectedParentId) {
			return undefined;
		}
		const scopedTasks = this.getCurrentSearchScopeTasks(filterSet, pipeline, settings, scope);
		if (parentSearchUi?.selectedParentId) {
			return this.resolveParentSearchVisibleTaskIds(parentSearchUi.selectedParentId, parentSearchUi.mode, scopedTasks);
		}
		return new Set(scopedTasks.map(task => task.operonId));
	}

	private hasKanbanSearchScopeFilters(scope: TaskSearchBoxScopeState): boolean {
		return scope.showOverdue
			|| scope.showHappensToday
			|| !scope.includeInline
			|| !scope.includeFile
			|| !scope.includeCancelled
			|| !scope.includeFinished;
	}

	private resetKanbanSearchScope(): void {
		this.searchScope = cloneTaskSearchBoxScopeState(KANBAN_SEARCH_BOX_DEFAULT_SCOPE);
		this.clearParentSearchState();
	}

	private isKanbanSearchScopeKeyActive(key: TaskFinderDefaultScopeKey): boolean {
		switch (key) {
			case 'projectTasks':
				return this.searchScope.projectMode === 'pc';
			case 'projectTree':
				return this.searchScope.projectMode === 'pt';
			case 'overdue':
				return this.searchScope.showOverdue;
			case 'happensToday':
				return this.searchScope.showHappensToday;
			case 'recentModified':
				return false;
			case 'includeInline':
				return this.searchScope.includeInline;
			case 'includeFile':
				return this.searchScope.includeFile;
			case 'includeCancelled':
				return this.searchScope.includeCancelled;
			case 'includeFinished':
				return this.searchScope.includeFinished;
		}
	}

	private getSearchScopeButtonLabel(key: TaskFinderDefaultScopeKey): string {
		switch (key) {
			case 'projectTasks':
				return t('modals', 'taskFinderProjectTasks');
			case 'projectTree':
				return t('modals', 'taskFinderProjectTree');
			case 'overdue':
				return t('modals', 'taskFinderOverdue');
			case 'happensToday':
				return t('modals', 'taskFinderHappensToday');
			case 'recentModified':
				return t('modals', 'taskFinderRecentModified');
			case 'includeInline':
				return t('modals', 'taskFinderIncludeInline');
			case 'includeFile':
				return t('modals', 'taskFinderIncludeFile');
			case 'includeCancelled':
				return t('modals', 'taskFinderIncludeCancelled');
			case 'includeFinished':
				return t('modals', 'taskFinderIncludeFinished');
		}
	}

	private buildParentSearchCandidates(
		scopedTasks: IndexedTask[],
		normalizedQuery: string,
	): KanbanParentSearchCandidate[] {
		return buildProjectSearchCandidates(scopedTasks, normalizedQuery, {
			getChildIds: parentId => this.indexer.secondary.getChildIds(parentId),
			getAllDescendantIds: parentId => this.indexer.secondary.getAllDescendantIds(parentId),
		});
	}

	private resolveParentSearchVisibleTaskIds(
		selectedParentId: string,
		mode: KanbanParentSearchMode,
		scopedTasks: IndexedTask[],
	): Set<string> {
		return resolveProjectSearchVisibleTaskIds(
			selectedParentId,
			mode,
			scopedTasks,
			{
				getChildIds: parentId => this.indexer.secondary.getChildIds(parentId),
				getAllDescendantIds: parentId => this.indexer.secondary.getAllDescendantIds(parentId),
			},
		);
	}

	private selectParentSearchCandidate(mode: KanbanParentSearchMode, candidate: KanbanParentSearchCandidate): void {
		this.parentSearchSelection = {
			mode,
			parentId: candidate.task.operonId,
			parentName: candidate.task.description,
		};
		this.parentSearchDismissed = true;
		this.parentSearchHighlightedIndex = 0;
		this.state = this.normalizeState({
			...this.ensureState(),
			searchQuery: '',
		});
		this.markDirty();
		this.focusKanbanSearchInput();
	}

	private updateParentSearchHighlight(nextIndex: number): void {
		const root = this.containerEl.children[1] as HTMLElement | undefined;
		const rows = Array.from(root?.querySelectorAll<HTMLElement>('.operon-kanban-parent-search-item') ?? []);
		if (rows.length === 0) {
			this.parentSearchHighlightedIndex = nextIndex;
			return;
		}
		const clampedIndex = Math.max(0, Math.min(nextIndex, rows.length - 1));
		if (clampedIndex === this.parentSearchHighlightedIndex) return;
		const previousRow = rows[this.parentSearchHighlightedIndex];
		const nextRow = rows[clampedIndex];
		this.parentSearchHighlightedIndex = clampedIndex;
		previousRow?.removeClass('is-active');
		nextRow?.addClass('is-active');
		nextRow?.scrollIntoView({ block: 'nearest' });
	}

	private clearParentSearchState(): void {
		this.searchScope = {
			...this.searchScope,
			projectMode: null,
		};
		this.parentSearchSelection = null;
		this.parentSearchHighlightedIndex = 0;
		this.parentSearchDismissed = false;
	}

	private captureSearchFocusState(container: HTMLElement): void {
		const searchInput = container.querySelector<HTMLInputElement>('.operon-kanban-toolbar-search');
		if (!searchInput || getOwnerDocument(container).activeElement !== searchInput) {
			this.pendingSearchFocusState = null;
			return;
		}
		this.pendingSearchFocusState = {
			selectionStart: searchInput.selectionStart,
			selectionEnd: searchInput.selectionEnd,
		};
	}

	private restoreSearchFocus(root: HTMLElement): void {
		const focusState = this.pendingSearchFocusState;
		this.pendingSearchFocusState = null;
		if (!focusState) return;
		const searchInput = root.querySelector<HTMLInputElement>('.operon-kanban-toolbar-search');
		if (!searchInput) return;
		searchInput.focus({ preventScroll: true });
		if (focusState.selectionStart !== null || focusState.selectionEnd !== null) {
			searchInput.setSelectionRange(
				focusState.selectionStart ?? searchInput.value.length,
				focusState.selectionEnd ?? focusState.selectionStart ?? searchInput.value.length,
			);
		}
	}

	private focusKanbanSearchInput(): void {
		window.requestAnimationFrame(() => {
			const root = this.containerEl.children[1] as HTMLElement | undefined;
			const searchInput = root?.querySelector<HTMLInputElement>('.operon-kanban-toolbar-search');
			searchInput?.focus({ preventScroll: true });
		});
	}

	private scheduleLeafStatePersistence(): void {
		this.clearPersistStateTimer();
		this.persistStateTimer = window.setTimeout(() => {
			this.persistStateTimer = null;
			void this.app.workspace.requestSaveLayout();
		}, 80);
	}

	private clearPersistStateTimer(): void {
		if (!this.persistStateTimer) return;
		window.clearTimeout(this.persistStateTimer);
		this.persistStateTimer = null;
	}

	private clearRender(): void {
		if (this.renderFrame === null) return;
		window.cancelAnimationFrame(this.renderFrame);
		this.renderFrame = null;
	}

	private applyKanbanPresetTheme(root: HTMLElement, preset: KanbanPreset): void {
		root.removeClass('is-background-themed');
		root.removeClass('is-background-tinted');
		root.removeClass('is-background-custom');
		root.removeClass('is-appearance-light');
		root.removeClass('is-appearance-dark');
		root.style.removeProperty('color-scheme');
		root.style.removeProperty('--operon-kanban-background-color');
		root.style.removeProperty('--operon-kanban-background-strong');
		root.style.removeProperty('--operon-kanban-background-soft');
		root.style.removeProperty('--background-primary');
		root.style.removeProperty('--background-secondary');
		root.style.removeProperty('--background-modifier-border');
		root.style.removeProperty('--background-modifier-hover');
		root.style.removeProperty('--text-normal');
		root.style.removeProperty('--text-muted');
		root.style.removeProperty('--interactive-normal');

		const obsidianDark = getOwnerBody(root).classList.contains('theme-dark');
		const activeAppearanceMode = obsidianDark ? preset.appearanceModeDark : preset.appearanceModeLight;
		if (activeAppearanceMode !== 'theme') {
			const light = isLightScheme(activeAppearanceMode);
			root.addClass(light ? 'is-appearance-light' : 'is-appearance-dark');
			root.style.setProperty('color-scheme', light ? 'light' : 'dark');
			const palette = getSchemePalette(activeAppearanceMode);
			root.style.setProperty('--background-primary', palette.backgroundPrimary);
			root.style.setProperty('--background-secondary', palette.backgroundSecondary);
			root.style.setProperty('--background-modifier-border', palette.borderColor);
			root.style.setProperty('--background-modifier-hover', palette.hoverColor);
			root.style.setProperty('--text-normal', palette.textNormal);
			root.style.setProperty('--text-muted', palette.textMuted);
			root.style.setProperty('--interactive-normal', palette.interactiveNormal);
		}

	}

}
