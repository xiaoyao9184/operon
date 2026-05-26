import { ItemView, prepareFuzzySearch, setIcon, WorkspaceLeaf } from 'obsidian';
import { getSchemePalette, isLightScheme } from '../appearance-schemes';
import { formatUiTime } from '../../core/ui-time-format';
import { localNow, localToday } from '../../core/local-time';
import { OperonIndexer } from '../../indexer/indexer';
import { buildVisibleCalendarDates, queryCalendarItems, shiftCalendarDateKey } from '../../systems/calendar-query';
import { filterTasksForCalendar, stripFilterViewOnlyOptions } from '../../systems/calendar-filter-materialization';
import {
	buildCalendarSidebarTaskPoolSearchText,
	CALENDAR_SIDEBAR_FINISHED_TASKS_RENDER_LIMIT,
	CALENDAR_SIDEBAR_TASK_POOL_INITIAL_LIMIT,
	CALENDAR_SIDEBAR_TASK_POOL_SEARCH_LIMIT,
	CalendarSidebarTaskPoolMode,
	collectCalendarSidebarTaskPoolCandidates,
	collectFinishedTasksForDate,
} from '../../systems/calendar-sidebar-task-pool';
import {
	buildAllDayCalendarWritebackPlan,
	buildAllDayMoveWritebackPlan,
	buildAllDayResizeRightWritebackPlan,
	buildAllDaySlotSelection,
	buildTimedCalendarWritebackPlan,
	buildTimedCalendarWritebackPlanForExistingCalendarAssignment,
	buildTimedSlotSelection,
	CALENDAR_TIMED_SNAP_MINUTES,
} from '../../systems/calendar-writeback';
import { parseLocalDatetime } from '../../systems/tracker-utils';
import { getConfiguredKeyMappingIcon } from '../../core/key-mapping-icons';
import { t } from '../../core/i18n';
import { getAppLocale } from '../../core/obsidian-app';
import { findStatusDef } from '../../types/pipeline';
import {
	CalendarItem,
	ExternalCalendarTaskSeed,
	CalendarLeafState,
	normalizeCalendarLeafState,
	CalendarPreset,
	CalendarSlotSelection,
} from '../../types/calendar';
import { IndexedTask } from '../../types/fields';
import { FilterSet, INLINE_TASK_COMPACT_FALLBACK_ICONS, OperonSettings, resolveTaskDisplayIcon } from '../../types/settings';
import type { PinnedCache } from '../../storage/pinned-cache';
import type { RepeatSeriesEntry } from '../../storage/repeat-series-store';
import {
	getContextualMenuSurfaceForCalendarItem,
	resolveContextualMenu,
	type ContextualMenuActionHandler,
	type ContextualMenuContext,
	type ResolvedContextualMenuAction,
} from '../../core/contextual-menu-engine';
import {
	CALENDAR_TASK_COLOR_SOURCES,
	getNextTaskColorSource,
	getTaskColorSourceIcon,
	getTaskColorSourceLabel,
	normalizeTaskColorSource,
	resolveTaskColorSource,
} from '../../core/task-color-source';
import { ContextualHoverMenuController } from '../contextual-hover-menu';
import {
	resolveContextualHoverMenuPosition,
	resolveVisibleContextualHoverAnchorRect,
} from '../contextual-hover-menu-position';
import { bindOperonHoverTooltip } from '../operon-hover-tooltip';
import { setAccessibleLabelWithoutTooltip } from '../accessibility-label';
import { bindTaskTitleLinkPreview } from '../compact-chip-link-preview';
import { closeFloatingPanelsForRoot } from '../field-pickers/common';
import { closeIconOnlyChipPreviewsForRoot } from '../icon-only-chip-preview';
import { asHTMLElement, getOwnerBody, getOwnerDocument, getOwnerWindow } from '../../core/dom-compat';
import { enginePerfLog, enginePerfNow } from '../../core/engine-perf';
import {
	applyOptimisticRenderPatch,
	buildOptimisticStatusPatch,
	isOptimisticTaskPatchPersisted,
	normalizeOptimisticFieldValues,
	type OptimisticStatusPatchResult,
	type OptimisticTaskPatchInput,
} from '../../systems/optimistic-status-patch';
import {
	buildTimedGridVisualLayout,
	type TimedGridVisualLayout,
	type TimedGridVisualLayoutPlacement,
} from './timed-grid-visual-layout';
import {
	resolveTimedHorizontalOffsetBounds,
	resolveTimedHorizontalVisibleStartIndex,
} from './timed-horizontal-window';

export const CALENDAR_VIEW_TYPE = 'operon-calendar-view';
const CALENDAR_SIDEBAR_SECTION_ORDER = ['calendars', 'taskPool', 'finishedTasks'] as const;

interface AllDayPlacement {
	item: CalendarItem;
	lane: number;
	laneCount: number;
	startColumn: number;
	endColumn: number;
}

interface TimedSegmentPlacement {
	item: CalendarItem;
	dayIndex: number;
	lane: number;
	laneCount: number;
	startMinutes: number;
	endMinutes: number;
}

type TimedGridVisualPlacement = TimedGridVisualLayoutPlacement<TimedSegmentPlacement>;

interface CalendarResolvedColor {
	r: number;
	g: number;
	b: number;
	a: number;
}

interface CalendarAllDayDropContext {
	body: HTMLElement;
	overlay: HTMLElement;
	visibleDates: string[];
	laneHeight: number;
	previewLane: number;
}

interface CalendarTimedDropContext {
	section: HTMLElement;
	gutter: HTMLElement;
	daysGrid: HTMLElement;
	hoverGuideOverlay: HTMLElement;
	visibleDates: string[];
	metrics: CalendarTimedMetrics;
	preset: CalendarPreset;
	settings: OperonSettings;
}

interface CalendarMultiWeekInDayDropContext {
	body: HTMLElement;
	dayLists: HTMLElement[];
	visibleDates: string[];
	preset: CalendarPreset;
	settings: OperonSettings;
}

interface CalendarMultiWeekGroup {
	visibleDates: string[];
}

interface CalendarHiddenTimeRange {
	enabled: boolean;
	startMinutes: number;
	endMinutes: number;
}

interface CalendarTimedMetrics {
	hiddenRange: CalendarHiddenTimeRange;
	isHiddenExpanded: boolean;
	scale: number;
	collapsedBandHeight: number;
	gridHeight: number;
}

type CalendarWheelAxisLock = 'horizontal' | 'vertical' | null;
type CalendarSidebarSectionId = typeof CALENDAR_SIDEBAR_SECTION_ORDER[number];

interface TimedHorizontalGestureState {
	axisLock: CalendarWheelAxisLock;
	offsetPx: number;
	lastWheelTs: number;
	snapTimer: number | null;
	resetTimer: number | null;
}

interface TimedHorizontalRenderWindow {
	anchorDate: string;
	visibleDates: string[];
	bufferedDates: string[];
	visibleStartBufferIndex: number;
	bufferDaysBefore: number;
	bufferDaysAfter: number;
}

type CalendarDragEndReason = 'commit' | 'cancel' | 'abort';

interface CalendarActiveDragSession {
	pointerId: number;
	finish: (reason: CalendarDragEndReason, event?: PointerEvent | null, flushPendingRender?: boolean) => void;
}

interface CalendarOptimisticTaskPatch {
	fieldValues: Record<string, string>;
	checkbox?: IndexedTask['checkbox'];
	expiresAt: number;
	renderSignature?: string[];
	source?: 'drop' | 'status-sidebar' | 'status-surface';
}

interface CalendarStatusDomPatchResult {
	patchedCount: number;
	fallbackReason: string;
}

interface CalendarStatusCycleTrace {
	traceId?: string;
	taskId: string;
}

export interface CalendarViewCallbacks {
	getExternalCalendarItems?: (rangeStart: string, rangeEnd: string, presetId?: string) => CalendarItem[];
	onTimedSlotSelection?: (selection: CalendarSlotSelection) => void | Promise<void>;
	onTimedItemMove?: (taskId: string, selection: CalendarSlotSelection) => void | Promise<void>;
	onTimedItemResizeStart?: (taskId: string, selection: CalendarSlotSelection) => void | Promise<void>;
	onTimedItemResizeEnd?: (taskId: string, selection: CalendarSlotSelection) => void | Promise<void>;
	onAllDaySlotSelection?: (selection: CalendarSlotSelection) => void | Promise<void>;
	onAllDayScheduledMove?: (taskId: string, selection: CalendarSlotSelection) => void | Promise<void>;
	onAllDayScheduledResizeRight?: (taskId: string, selection: CalendarSlotSelection) => void | Promise<void>;
	onTimedItemDropToAllDay?: (taskId: string, selection: CalendarSlotSelection) => void | Promise<void>;
	onAllDayItemDropToTimed?: (taskId: string, selection: CalendarSlotSelection) => void | Promise<void>;
	onItemAction?: ContextualMenuActionHandler;
	onStatusIconClick?: (taskId: string) => void | Promise<void>;
	onOpenPresetSettings?: (presetId: string) => void | Promise<void>;
	onSidebarTaskDropToTimed?: (taskId: string, selection: CalendarSlotSelection) => void | Promise<void>;
	onSidebarTaskDropToAllDay?: (taskId: string, selection: CalendarSlotSelection) => void | Promise<void>;
	onSidebarWidthChange?: (widthPx: number) => void | Promise<void>;
	onOpenDailyNote?: (dateKey: string) => void | Promise<void>;
	onToggleAllDayLaneVisibility?: (nextValue: boolean) => void | Promise<void>;
	onToggleDueLaneVisibility?: (nextValue: boolean) => void | Promise<void>;
	onToggleProjectedOccurrences?: (presetId: string, nextValue: boolean) => void | Promise<void>;
	onToggleExternalCalendars?: (presetId: string, nextValue: boolean) => void | Promise<void>;
	onCycleTaskColorSource?: (presetId: string, nextSource: CalendarPreset['colorSource']) => void | Promise<void>;
	onSyncExternalCalendars?: () => void | Promise<void>;
	onExternalItemCreateTask?: (seed: ExternalCalendarTaskSeed) => void | Promise<void>;
	onCalendarDragInteractionEnd?: () => void | Promise<void>;
}

export class CalendarView extends ItemView {
	private readonly indexer: OperonIndexer;
	private readonly getSettings: () => OperonSettings;
	private readonly getPinnedCache: () => PinnedCache | null;
	private readonly getRepeatSeriesEntries: () => RepeatSeriesEntry[];
	private readonly getExternalCalendarItems: (rangeStart: string, rangeEnd: string, presetId?: string) => CalendarItem[];
	private readonly callbacks: CalendarViewCallbacks;
	private state: CalendarLeafState | null = null;
	private timedScrollEl: HTMLElement | null = null;
	private surfaceScrollEl: HTMLElement | null = null;
	private lastAppliedScrollSignature: string | null = null;
	private nowIndicatorTimer: number | null = null;
	private nowIndicatorEntries: Array<{
		lineEl: HTMLElement;
		labelEl: HTMLElement;
		metrics: CalendarTimedMetrics;
	}> = [];
	private persistStateTimer: number | null = null;
	private renderFrame: number | null = null;
	private preserveScrollOnNextRender = false;
	private allDayDropContext: CalendarAllDayDropContext | null = null;
	private timedDropContext: CalendarTimedDropContext | null = null;
	private multiWeekAllDayDropContexts: CalendarAllDayDropContext[] = [];
	private multiWeekInDayDropContexts: CalendarMultiWeekInDayDropContext[] = [];
	private expandedHiddenTimeKey: string | null = null;
	private lastRenderPresetKey: string | null = null;
	private taskPoolQuery = '';
	private taskPoolMode: CalendarSidebarTaskPoolMode = 'unscheduled';
	private finishedTasksQuery = '';
	private sidebarOpenSectionOrder: CalendarSidebarSectionId[] = [];
	private sidebarWidthOverridePx: number | null = null;
	private sidebarResizeCleanup: (() => void) | null = null;
	private sidebarSectionsLayoutCleanup: (() => void) | null = null;
	private toolbarLayoutCleanup: (() => void) | null = null;
	private layoutRefreshCleanup: (() => void) | null = null;
	private layoutRefreshFrame: number | null = null;
	private calendarNavigationKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
	private calendarNavigationDocument: Document | null = null;
	private readonly hoverMenu = new ContextualHoverMenuController({
		getDelayMs: () => this.getSettings().contextualMenuOpenDelayMs,
		getHost: () => this.containerEl.children[1] as HTMLElement | null,
		positionMenu: (anchorRect, menu) => this.positionCalendarHoverMenu(anchorRect, menu),
	});
	private restoreScrollOnNextRender = false;
	private restoreSurfaceScrollOnNextRender = false;
	private lastSurfaceScrollTop = 0;
	private timedHorizontalGesture: TimedHorizontalGestureState = {
		axisLock: null,
		offsetPx: 0,
		lastWheelTs: 0,
		snapTimer: null,
		resetTimer: null,
	};
	private timedHorizontalRenderWindow: TimedHorizontalRenderWindow | null = null;
	private timedHorizontalStripEl: HTMLElement | null = null;
	private timedHorizontalClipEl: HTMLElement | null = null;
	private timedHorizontalDayWidthPx = 0;
	private activeCalendarDragSession: CalendarActiveDragSession | null = null;
	private pendingRenderAfterCalendarDrag = false;
	private readonly calendarDragGhosts = new Set<HTMLElement>();
	private readonly optimisticTaskPatches = new Map<string, CalendarOptimisticTaskPatch>();
	private optimisticPatchCleanupTimer: number | null = null;
	private renderGeneration = 0;
	private readonly renderAnimationFrames = new Set<number>();
	private readonly renderTimeouts = new Set<number>();

	constructor(
		leaf: WorkspaceLeaf,
		indexer: OperonIndexer,
		getSettings: () => OperonSettings,
		getPinnedCache: () => PinnedCache | null,
		getRepeatSeriesEntries: () => RepeatSeriesEntry[],
		getExternalCalendarItems: ((rangeStart: string, rangeEnd: string, presetId?: string) => CalendarItem[]) | undefined,
		callbacks: CalendarViewCallbacks = {},
	) {
		super(leaf);
		this.indexer = indexer;
		this.getSettings = getSettings;
		this.getPinnedCache = getPinnedCache;
		this.getRepeatSeriesEntries = getRepeatSeriesEntries;
		this.getExternalCalendarItems = getExternalCalendarItems ?? (() => []);
		this.callbacks = callbacks;
	}

	getViewType(): string {
		return CALENDAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.getCurrentPresetTitle();
	}

	getIcon(): string {
		return 'calendar';
	}

	getState(): Record<string, unknown> {
		return { ...this.ensureState() };
	}

		async setState(state: Partial<CalendarLeafState> | null | undefined, _result: unknown): Promise<void> {
			const nextState = this.syncSidebarOpenSections(this.normalizeState(state));
			const changed = !this.areLeafStatesEqual(this.state, nextState);
			this.state = nextState;
			this.syncLeafTitle();
			if (changed && this.containerEl.isConnected) {
				this.captureActiveMultiWeekSurfaceScroll();
				this.clearScheduledRender();
				this.preserveScrollOnNextRender = false;
				if (this.hasActiveCalendarDragInteraction()) {
					this.pendingRenderAfterCalendarDrag = true;
					return;
				}
				this.render();
			}
		}

	async onOpen(): Promise<void> {
		const persistedLeafState = this.leaf.getViewState().state as Partial<CalendarLeafState> | undefined;
		this.state = this.syncSidebarOpenSections(this.normalizeState({
			...(persistedLeafState ?? {}),
			...(this.state ?? {}),
		}));
		this.taskPoolQuery = '';
		this.taskPoolMode = 'overdue';
		this.finishedTasksQuery = '';
			this.preserveScrollOnNextRender = false;
			this.bindCalendarNavigationKeys();
			this.syncLeafTitle();
			this.registerEvent(this.app.workspace.on('css-change', () => { this.markDirty(); }));
			this.render();
		}

		async onClose(): Promise<void> {
			this.finishActiveCalendarDragSession('abort', null, false);
			await this.flushPendingLeafStatePersistence();
			this.invalidateRenderGeneration();
			this.pendingRenderAfterCalendarDrag = false;
			this.clearCalendarDragGhosts();
			this.clearOptimisticTaskPatches();
			this.clearRenderTimers();
			this.clearScheduledRender();
			this.clearPersistStateTimer();
		this.clearTimedHorizontalGestureTimers();
		this.clearSidebarResizeDrag();
		this.hideCalendarHoverMenu(true);
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (container) {
			closeFloatingPanelsForRoot(container);
			closeIconOnlyChipPreviewsForRoot(container);
		}
		this.expandedHiddenTimeKey = null;
		this.lastRenderPresetKey = null;
		this.taskPoolQuery = '';
		this.taskPoolMode = 'overdue';
		this.finishedTasksQuery = '';
		this.sidebarWidthOverridePx = null;
		this.unbindCalendarNavigationKeys();
		}

		markDirty(): void {
			if (this.hasActiveCalendarDragInteraction()) {
				this.pendingRenderAfterCalendarDrag = true;
				return;
			}
			if (this.renderFrame !== null) return;
			this.captureActiveMultiWeekSurfaceScroll();
			this.preserveScrollOnNextRender = true;
			this.renderFrame = window.requestAnimationFrame(() => {
				this.renderFrame = null;
				this.render();
			});
		}

		markDirtyForStatusCycle(trace: CalendarStatusCycleTrace): boolean {
			const startedAt = enginePerfNow();
			const patch = this.optimisticTaskPatches.get(trace.taskId);
			const logResult = (
				action: 'dom-reconcile' | 'full-render',
				reason: string,
				signatureChanged: boolean,
				patchedCount = 0,
			): void => {
				enginePerfLog(
					'calendar.statusReconcile',
					`traceId=${trace.traceId ?? 'none'}`,
					`taskId=${trace.taskId}`,
					`action=${action}`,
					`reason=${reason}`,
					`signatureChanged=${String(signatureChanged)}`,
					`domPatched=${patchedCount}`,
					`reconcileMs=${Math.round(enginePerfNow() - startedAt)}`,
				);
			};
			if (!patch) {
				logResult('full-render', 'no-optimistic-patch', false);
				return false;
			}
			if (patch.source !== 'status-surface') {
				logResult('full-render', patch.source ? `source-${patch.source}` : 'source-unknown', false);
				return false;
			}
			const task = this.indexer.getTask(trace.taskId);
			if (!task || !isOptimisticTaskPatchPersisted(task, patch)) {
				logResult('full-render', task ? 'not-persisted' : 'task-missing', false);
				return false;
			}
			const nextSignature = this.buildRenderedCalendarTaskSignature(trace.taskId);
			const signatureChanged = !this.areCalendarTaskRenderSignaturesEqual(patch.renderSignature ?? [], nextSignature);
			if (signatureChanged) {
				logResult('full-render', 'signature-changed', true);
				return false;
			}
			const domPatch = this.applyCalendarStatusDomPatch(trace.taskId, patch);
			if (domPatch.patchedCount === 0 && nextSignature.length > 0) {
				logResult('full-render', domPatch.fallbackReason, false);
				return false;
			}
			this.optimisticTaskPatches.delete(trace.taskId);
			this.scheduleOptimisticTaskPatchCleanup();
			logResult('dom-reconcile', domPatch.fallbackReason, false, domPatch.patchedCount);
			return true;
		}

		private beginCalendarDragSession(
			targetEl: HTMLElement,
			pointerId: number,
			onEnd: (reason: CalendarDragEndReason, event: PointerEvent | null) => void,
		): void {
			this.finishActiveCalendarDragSession('abort', null, false);
			if (this.renderFrame !== null) {
				this.clearScheduledRender();
				this.pendingRenderAfterCalendarDrag = true;
			}

			let session: CalendarActiveDragSession;
			const ownerWindow = getOwnerWindow(targetEl);
			const finish = (
				reason: CalendarDragEndReason,
				event: PointerEvent | null = null,
				flushPendingRender = true,
			): void => {
				if (event && event.pointerId !== pointerId) return;
				if (this.activeCalendarDragSession !== session) return;
				ownerWindow.removeEventListener('pointerup', onPointerUp, true);
				ownerWindow.removeEventListener('pointercancel', onPointerCancel, true);
				ownerWindow.removeEventListener('blur', onWindowBlur, true);
				targetEl.removeEventListener('lostpointercapture', onLostPointerCapture);
				this.activeCalendarDragSession = null;
				onEnd(reason, event);
				if (flushPendingRender) {
					this.flushPendingCalendarDragRender();
				}
			};
			const onPointerUp = (event: PointerEvent): void => finish('commit', event);
			const onPointerCancel = (event: PointerEvent): void => finish('cancel', event);
			const onWindowBlur = (): void => finish('abort', null);
			const onLostPointerCapture = (event: PointerEvent): void => finish('abort', event);

			session = { pointerId, finish };
			this.activeCalendarDragSession = session;
			ownerWindow.addEventListener('pointerup', onPointerUp, true);
			ownerWindow.addEventListener('pointercancel', onPointerCancel, true);
			ownerWindow.addEventListener('blur', onWindowBlur, true);
			targetEl.addEventListener('lostpointercapture', onLostPointerCapture);
		}

		private finishActiveCalendarDragSession(
			reason: CalendarDragEndReason,
			event: PointerEvent | null = null,
			flushPendingRender = true,
		): void {
			this.activeCalendarDragSession?.finish(reason, event, flushPendingRender);
		}

		private flushPendingCalendarDragRender(): void {
			if (this.hasActiveCalendarDragInteraction()) return;
			const shouldRender = this.pendingRenderAfterCalendarDrag;
			this.pendingRenderAfterCalendarDrag = false;
			if (shouldRender) {
				this.markDirty();
			}
			void this.callbacks.onCalendarDragInteractionEnd?.();
		}

		private releaseCalendarPointerCapture(targetEl: HTMLElement, pointerId: number): void {
			try {
				if (targetEl.hasPointerCapture?.(pointerId)) {
					targetEl.releasePointerCapture(pointerId);
				}
			} catch {
				// Pointer capture can already be gone after window-level abort paths.
			}
		}

		private getOptimisticCalendarTasksForRender(): IndexedTask[] {
			this.pruneOptimisticTaskPatches();
			const tasks = this.indexer.getAllTasks();
			if (this.optimisticTaskPatches.size === 0) return tasks;
			return tasks.map(task => {
				const patch = this.optimisticTaskPatches.get(task.operonId);
				if (!patch) return task;
				return applyOptimisticRenderPatch(task, patch);
			});
		}

		private applyOptimisticTaskPatch(taskId: string, patchInput: OptimisticTaskPatchInput): boolean {
			const task = this.indexer.getTask(taskId);
			if (!task) return false;
			const normalized = normalizeOptimisticFieldValues(patchInput.fieldValues);
			if (Object.keys(normalized).length === 0 && !patchInput.checkbox) return false;

			this.optimisticTaskPatches.set(taskId, {
				fieldValues: normalized,
				checkbox: patchInput.checkbox,
				expiresAt: Date.now() + 10000,
				source: 'drop',
			});
			this.scheduleOptimisticTaskPatchCleanup();
			this.captureActiveCalendarScrollForRender();
			this.preserveScrollOnNextRender = true;
			this.render();
			return true;
		}

		private applyOptimisticStatusTaskPatch(
			taskId: string,
			patchInput: OptimisticTaskPatchInput,
			source: 'status-sidebar' | 'status-surface',
		): {
			applied: boolean;
			domPatched: number;
			fallbackReason: string;
			renderMode: 'dom' | 'full';
		} {
			const task = this.indexer.getTask(taskId);
			if (!task) {
				return { applied: false, domPatched: 0, fallbackReason: 'task-missing', renderMode: 'dom' };
			}
			const normalized = normalizeOptimisticFieldValues(patchInput.fieldValues);
			if (Object.keys(normalized).length === 0 && !patchInput.checkbox) {
				return { applied: false, domPatched: 0, fallbackReason: 'patch-empty', renderMode: 'dom' };
			}
			const patch: CalendarOptimisticTaskPatch = {
				fieldValues: normalized,
				checkbox: patchInput.checkbox,
				expiresAt: Date.now() + 10000,
				renderSignature: this.buildRenderedCalendarTaskSignature(taskId),
				source,
			};
			this.optimisticTaskPatches.set(taskId, patch);
			this.scheduleOptimisticTaskPatchCleanup();
			const domPatch = this.applyCalendarStatusDomPatch(taskId, patch);
			if (domPatch.patchedCount === 0) {
				this.captureActiveCalendarScrollForRender();
				this.preserveScrollOnNextRender = true;
				this.render();
				return {
					applied: true,
					domPatched: 0,
					fallbackReason: domPatch.fallbackReason,
					renderMode: 'full',
				};
			}
			return {
				applied: true,
				domPatched: domPatch.patchedCount,
				fallbackReason: domPatch.fallbackReason,
				renderMode: 'dom',
			};
		}

		private buildOptimisticStatusPatch(taskId: string): OptimisticStatusPatchResult | null {
			const task = this.indexer.getTask(taskId);
			if (!task) return null;
			return buildOptimisticStatusPatch(task, this.getSettings());
		}

		private applyCalendarStatusDomPatch(
			taskId: string,
			patch: OptimisticTaskPatchInput,
		): CalendarStatusDomPatchResult {
			const task = this.indexer.getTask(taskId);
			if (!task) return { patchedCount: 0, fallbackReason: 'task-missing' };
			const host = this.containerEl.children[1] as HTMLElement | undefined;
			if (!host) return { patchedCount: 0, fallbackReason: 'host-missing' };
			const renderedTask = applyOptimisticRenderPatch(task, patch);
			const settings = this.getSettings();
			const iconName = this.resolveStatusButtonIcon(
				renderedTask.fieldValues,
				renderedTask.checkbox,
				settings,
			);
			const statusColor = this.resolveCalendarStatusColorFromFieldValues(renderedTask.fieldValues, settings);
			const buttons = Array.from(host.querySelectorAll<HTMLElement>('.operon-calendar-status-button'))
				.filter(button => button.dataset.operonId === taskId);
			if (buttons.length === 0) return { patchedCount: 0, fallbackReason: 'dom-miss' };
			const patchedRoots = new Set<HTMLElement>();
			for (const button of buttons) {
				button.empty();
				if (iconName) setIcon(button, iconName);
				if (statusColor) {
					button.style.color = statusColor;
				} else {
					button.style.removeProperty('color');
				}
				const root = button.closest<HTMLElement>(
					'.operon-calendar-timed-item, .operon-calendar-all-day-item, .operon-calendar-sidebar-task-pool-row',
				);
				if (root) patchedRoots.add(root);
			}
			const preset = this.resolveCurrentCalendarPreset(settings);
			for (const root of patchedRoots) {
				this.applyCalendarCheckboxClass(root, renderedTask.checkbox);
				if (
					preset
					&& (
						root.hasClass('operon-calendar-timed-item')
						|| root.hasClass('operon-calendar-all-day-item')
					)
				) {
					this.applyCalendarTaskFieldColor(root, renderedTask.fieldValues, preset, settings);
				}
			}
			return { patchedCount: buttons.length, fallbackReason: 'none' };
		}

		private buildRenderedCalendarTaskSignature(taskId: string): string[] {
			const settings = this.getSettings();
			const state = this.ensureState();
			const preset = this.resolveCurrentCalendarPreset(settings);
			const task = this.indexer.getTask(taskId);
			if (!preset || !task) return [];
			const activeFilter = (() => {
				const raw = settings.filterSets.find(entry => entry.id === preset.filterSetId) ?? null;
				return raw ? stripFilterViewOnlyOptions(raw) : null;
			})();
			const scopedTasks = filterTasksForCalendar(
				activeFilter,
				[task],
				settings.priorities,
				this.getPinnedCache(),
			);
			const queryAnchorDate = preset.surfaceType === 'multiWeek'
				? this.resolveMultiWeekRangeStart(state.anchorDate, preset, settings.calendarWeekStart)
				: state.anchorDate;
			const queryPreset = preset.surfaceType === 'multiWeek'
				? {
					dayCount: this.getMultiWeekVisibleDayCount(preset),
					showWeekends: preset.showWeekends,
					todayPosition: 1,
					showProjectedOccurrences: preset.showProjectedOccurrences,
				}
				: preset;
			const query = queryCalendarItems(
				scopedTasks,
				queryAnchorDate,
				queryPreset,
				this.getRepeatSeriesEntries(),
			);
			const timedRenderWindow = preset.surfaceType === 'timeGrid'
				? this.buildTimedHorizontalRenderWindow(state.anchorDate, preset, query.visibleDates)
				: null;
			const timedQuery = timedRenderWindow
				? queryCalendarItems(
					scopedTasks,
					state.anchorDate,
					{
						dayCount: timedRenderWindow.bufferedDates.length,
						showWeekends: preset.showWeekends,
						todayPosition: timedRenderWindow.bufferDaysBefore + 1,
						showProjectedOccurrences: preset.showProjectedOccurrences,
					},
					this.getRepeatSeriesEntries(),
				)
				: query;
			const signature: string[] = [];
			for (const item of query.items) {
				if (item.taskId === taskId && item.kind !== 'timed') {
					signature.push(this.buildCalendarItemSignature(item));
				}
			}
			for (const item of timedQuery.items) {
				if (item.taskId === taskId && item.kind === 'timed') {
					signature.push(this.buildCalendarItemSignature(item));
				}
			}
			if (state.navigationMode === 'sidebar') {
				const tasks = this.indexer.getAllTasks();
				signature.push(...this.buildSidebarTaskSignature(taskId, tasks, state));
			}
			return signature.sort();
		}

		private buildCalendarItemSignature(item: CalendarItem): string {
			return [
				'surface',
				item.kind,
				item.startDate,
				item.endDate,
				item.startDateTime ?? '',
				item.endDateTime ?? '',
				item.origin,
			].join('|');
		}

		private buildSidebarTaskSignature(
			taskId: string,
			tasks: IndexedTask[],
			state: CalendarLeafState,
		): string[] {
			const signature: string[] = [];
			if (state.taskPoolOpen) {
				const candidates = collectCalendarSidebarTaskPoolCandidates(tasks, this.taskPoolMode);
				const query = this.taskPoolQuery.trim();
				const allMatches = !query
					? candidates
					: this.rankSidebarTaskPoolMatches(candidates, query);
				const visibleMatches = allMatches.slice(0, query
					? CALENDAR_SIDEBAR_TASK_POOL_SEARCH_LIMIT
					: CALENDAR_SIDEBAR_TASK_POOL_INITIAL_LIMIT);
				const index = visibleMatches.findIndex(task => task.operonId === taskId);
				if (index >= 0) signature.push(`sidebar|pool|${this.taskPoolMode}|${index}`);
			}
			if (state.finishedTasksOpen) {
				const candidates = collectFinishedTasksForDate(tasks, state.anchorDate);
				const query = this.finishedTasksQuery.trim();
				const allMatches = !query
					? candidates
					: this.rankSidebarTaskPoolMatches(candidates, query);
				const visibleMatches = allMatches.slice(0, CALENDAR_SIDEBAR_FINISHED_TASKS_RENDER_LIMIT);
				const index = visibleMatches.findIndex(task => task.operonId === taskId);
				if (index >= 0) signature.push(`sidebar|finished|${index}`);
			}
			return signature;
		}

		private areCalendarTaskRenderSignaturesEqual(left: string[], right: string[]): boolean {
			if (left.length !== right.length) return false;
			return left.every((value, index) => value === right[index]);
		}

		private invokeCalendarDropCallback(
			taskId: string,
			fieldValues: Record<string, string | undefined>,
			callback: (() => void | Promise<void>) | undefined,
		): void {
			this.applyOptimisticTaskPatch(taskId, { fieldValues });
			if (!callback) return;
			void Promise.resolve(callback()).catch(error => {
				console.error('Operon: calendar drop writeback failed', error);
				this.optimisticTaskPatches.delete(taskId);
				this.markDirty();
			});
		}

		private invokeCalendarStatusClickCallback(
			taskId: string,
			source: 'status-sidebar' | 'status-surface',
		): void {
			const startedAt = enginePerfNow();
			const optimistic = this.buildOptimisticStatusPatch(taskId);
			let fallbackReason = 'none';
			let applied = false;
			let domPatched = 0;
			let renderMode: 'dom' | 'full' | 'none' = 'none';
			if (optimistic) {
				const result = this.applyOptimisticStatusTaskPatch(taskId, optimistic.patch, source);
				applied = result.applied;
				domPatched = result.domPatched;
				renderMode = result.renderMode;
				if (!applied || result.fallbackReason !== 'none') fallbackReason = result.fallbackReason;
			} else {
				fallbackReason = this.indexer.getTask(taskId) ? 'next-status-unavailable' : 'task-missing';
			}
			enginePerfLog(
				'calendar.optimisticStatus',
				`taskId=${taskId}`,
				`applied=${String(applied)}`,
				`nextStatus=${optimistic?.nextStatus ?? 'none'}`,
				`nextCheckbox=${optimistic?.nextCheckbox ?? 'none'}`,
				`renderMode=${renderMode}`,
				`domPatched=${domPatched}`,
				`renderMs=${Math.round(enginePerfNow() - startedAt)}`,
				`fallbackReason=${fallbackReason}`,
			);
			if (!this.callbacks.onStatusIconClick) return;
			void Promise.resolve(this.callbacks.onStatusIconClick(taskId)).catch(error => {
				console.error('Operon: calendar status click failed', error);
				this.optimisticTaskPatches.delete(taskId);
				this.markDirty();
			});
		}

		private pruneOptimisticTaskPatches(now = Date.now()): void {
			let changed = false;
			for (const [taskId, patch] of this.optimisticTaskPatches.entries()) {
				const task = this.indexer.getTask(taskId);
				const isExpired = now >= patch.expiresAt;
				const isPersisted = !!task && isOptimisticTaskPatchPersisted(task, patch);
				if (!task || isExpired || isPersisted) {
					this.optimisticTaskPatches.delete(taskId);
					changed = true;
				}
			}
			if (changed) {
				this.scheduleOptimisticTaskPatchCleanup();
			}
		}

		private scheduleOptimisticTaskPatchCleanup(): void {
			if (this.optimisticPatchCleanupTimer !== null) {
				window.clearTimeout(this.optimisticPatchCleanupTimer);
				this.optimisticPatchCleanupTimer = null;
			}
			if (this.optimisticTaskPatches.size === 0) return;

			const nextExpiry = Math.min(...Array.from(this.optimisticTaskPatches.values()).map(patch => patch.expiresAt));
			const delay = Math.max(0, nextExpiry - Date.now());
			this.optimisticPatchCleanupTimer = window.setTimeout(() => {
				this.optimisticPatchCleanupTimer = null;
				this.pruneOptimisticTaskPatches();
				this.markDirty();
			}, delay);
		}

		private clearOptimisticTaskPatches(): void {
			this.optimisticTaskPatches.clear();
			if (this.optimisticPatchCleanupTimer !== null) {
				window.clearTimeout(this.optimisticPatchCleanupTimer);
				this.optimisticPatchCleanupTimer = null;
			}
		}

	render(): void {
			this.finishActiveCalendarDragSession('abort', null, false);
			this.invalidateRenderGeneration();
			const renderGeneration = this.renderGeneration;
			this.pendingRenderAfterCalendarDrag = false;
		this.clearCalendarDragGhosts();
		this.clearRenderTimers();
			this.hideCalendarHoverMenu(true);
		const container = this.containerEl.children[1] as HTMLElement;
		closeFloatingPanelsForRoot(container);
		closeIconOnlyChipPreviewsForRoot(container);
		this.surfaceScrollEl = null;
		this.allDayDropContext = null;
		this.timedDropContext = null;
		this.multiWeekAllDayDropContexts = [];
		this.multiWeekInDayDropContexts = [];
		const settings = this.getSettings();
		const state = this.ensureState();
		const preset = settings.calendarPresets.find(entry => entry.id === state.presetId) ?? settings.calendarPresets[0];
		this.syncLeafTitle(preset?.name);
		if (!preset) {
			container.empty();
			container.addClass('operon-calendar-view');
			container.createDiv({ text: t('calendar', 'presetsNotConfigured') });
			return;
		}
		const activeFilter = (() => {
			const raw = settings.filterSets.find(entry => entry.id === preset.filterSetId) ?? null;
			return raw ? stripFilterViewOnlyOptions(raw) : null;
		})();
		const queryAnchorDate = preset.surfaceType === 'multiWeek'
			? this.resolveMultiWeekRangeStart(state.anchorDate, preset, settings.calendarWeekStart)
			: state.anchorDate;
		const renderPresetKey = `${preset.id}|${queryAnchorDate}`;
		const preserveScroll = this.restoreScrollOnNextRender
			|| (this.preserveScrollOnNextRender && this.lastRenderPresetKey === renderPresetKey);
		this.preserveScrollOnNextRender = false;
		this.restoreScrollOnNextRender = false;
		if (this.lastRenderPresetKey && this.lastRenderPresetKey !== renderPresetKey) {
			this.expandedHiddenTimeKey = null;
		}
		this.lastRenderPresetKey = renderPresetKey;
		const renderTasks = this.getOptimisticCalendarTasksForRender();
		const scopedTasks = filterTasksForCalendar(
			activeFilter,
			renderTasks,
			settings.priorities,
			this.getPinnedCache(),
		);
		const queryPreset = preset.surfaceType === 'multiWeek'
			? {
				dayCount: this.getMultiWeekVisibleDayCount(preset),
				showWeekends: preset.showWeekends,
				todayPosition: 1,
				showProjectedOccurrences: preset.showProjectedOccurrences,
			}
			: preset;
		const query = queryCalendarItems(
			scopedTasks,
			queryAnchorDate,
			queryPreset,
			this.getRepeatSeriesEntries(),
		);
		const timedRenderWindow = preset.surfaceType === 'timeGrid'
			? this.buildTimedHorizontalRenderWindow(state.anchorDate, preset, query.visibleDates)
			: null;
		const timedQuery = timedRenderWindow
			? queryCalendarItems(
				scopedTasks,
				state.anchorDate,
				{
					dayCount: timedRenderWindow.bufferedDates.length,
					showWeekends: preset.showWeekends,
					todayPosition: timedRenderWindow.bufferDaysBefore + 1,
					showProjectedOccurrences: preset.showProjectedOccurrences,
				},
				this.getRepeatSeriesEntries(),
			)
			: query;
		let externalItems = this.getExternalCalendarItems(
			query.rangeStart <= timedQuery.rangeStart ? query.rangeStart : timedQuery.rangeStart,
			query.rangeEnd >= timedQuery.rangeEnd ? query.rangeEnd : timedQuery.rangeEnd,
			preset.id,
		);
		if (externalItems.length > 0) {
			const createdTaskKeys = this.buildCreatedExternalEventTaskKeySet(scopedTasks);
			const hiddenSourceIds = new Set(
				this.getSettings().externalCalendars
					.filter((source) => source.hideCreatedEvents)
					.map((source) => source.id),
			);
			externalItems = externalItems.filter(item => {
				if (!item.externalRef || !hiddenSourceIds.has(item.externalRef.sourceId)) return true;
				const key = this.buildExternalEventTaskMatchKey(item.renderSnapshot.description, item.startDate);
				return !key || !createdTaskKeys.has(key);
			});
		}
		const scheduledItems = [
			...query.items.filter(item => item.kind === 'allDayScheduled'),
			...externalItems.filter(item => item.kind === 'allDayScheduled'),
		];
		const dueItems = query.items.filter(item => item.kind === 'dueMarker');
		const finishedItems = query.items.filter(item => item.kind === 'finishedMarker');
		const timedItems = [
			...timedQuery.items.filter(item => item.kind === 'timed'),
			...externalItems.filter(item => item.kind === 'timed'),
		];

		container.empty();
		container.addClass('operon-calendar-view');
		this.timedHorizontalStripEl = null;
		this.timedHorizontalClipEl = null;
		this.timedHorizontalRenderWindow = timedRenderWindow;
		this.timedHorizontalDayWidthPx = 0;

		const root = container.createDiv('operon-calendar-root');
		root.tabIndex = 0;
		root.classList.toggle('is-surface-time-grid', preset.surfaceType === 'timeGrid');
		root.classList.toggle('is-surface-multi-week', preset.surfaceType === 'multiWeek');
		this.applyCalendarPresetTheme(root, preset);
		let contentContainer: HTMLElement;
		if (state.navigationMode === 'sidebar') {
			contentContainer = this.renderSidebarShell(root, state, preset, query.visibleDates);
		} else {
			this.renderToolbar(root, state, preset, query.visibleDates);
			contentContainer = this.renderSurfaceScrollShell(root);
		}
		this.renderFilterEmptyState(contentContainer, activeFilter, scopedTasks.length, query.items.length + externalItems.length);
		if (preset.surfaceType === 'multiWeek') {
			this.renderMultiWeekSurface(
				contentContainer,
				query.visibleDates,
				scheduledItems,
				dueItems,
				finishedItems,
				timedItems,
				preset,
				settings,
				state,
			);
			if (preserveScroll || this.restoreSurfaceScrollOnNextRender) {
				this.restoreMultiWeekSurfaceScroll(renderGeneration);
			}
		} else if (timedRenderWindow) {
			this.renderTimeGridSurface(
				contentContainer,
				query.visibleDates,
				scheduledItems,
				dueItems,
				finishedItems,
				timedItems,
				timedRenderWindow,
				preset,
				settings,
				state,
			);
		}
		this.restoreSurfaceScrollOnNextRender = false;
		this.bindLayoutRefresh(root);
		if (preset.surfaceType === 'timeGrid' && preserveScroll) {
			this.restoreScrollPosition(state, preset);
		} else if (preset.surfaceType === 'timeGrid') {
			this.scheduleInitialScroll(state, preset, renderGeneration);
		}
	}

	private getCurrentPresetTitle(): string {
		const settings = this.getSettings();
		const state = this.ensureState();
		return settings.calendarPresets.find(entry => entry.id === state.presetId)?.name ?? 'Operon Calendar';
	}

	private syncLeafTitle(title = this.getCurrentPresetTitle()): void {
		const leafWithHeader = this.leaf as WorkspaceLeaf & {
			tabHeaderInnerTitleEl?: HTMLElement;
			tabHeaderEl?: HTMLElement;
		};
		leafWithHeader.tabHeaderInnerTitleEl?.setText(title);
		if (leafWithHeader.tabHeaderEl) {
			setAccessibleLabelWithoutTooltip(leafWithHeader.tabHeaderEl, title);
		}
	}

	private renderTimeGridSurface(
		container: HTMLElement,
		visibleDates: string[],
		scheduledItems: CalendarItem[],
		dueItems: CalendarItem[],
		finishedItems: CalendarItem[],
		timedItems: CalendarItem[],
		renderWindow: TimedHorizontalRenderWindow,
		preset: CalendarPreset,
		settings: OperonSettings,
		state: CalendarLeafState,
	): void {
		this.renderDayHeaders(container, visibleDates, state.showAllDayLane, state.showDueMarkers);
		if (state.showAllDayLane || state.showDueMarkers) {
			this.renderAllDaySection(
				container,
				visibleDates,
				scheduledItems,
				dueItems,
				finishedItems,
				preset,
				settings,
				state.showAllDayLane,
				state.showDueMarkers,
				false,
			);
		}
		this.renderTimedSection(container, renderWindow, timedItems, preset, settings);
	}

	private renderMultiWeekSurface(
		container: HTMLElement,
		visibleDates: string[],
		scheduledItems: CalendarItem[],
		dueItems: CalendarItem[],
		finishedItems: CalendarItem[],
		timedItems: CalendarItem[],
		preset: CalendarPreset,
		settings: OperonSettings,
		state: CalendarLeafState,
	): void {
		const groups = this.buildMultiWeekGroups(visibleDates, preset);
		for (const group of groups) {
			const weekGroup = container.createDiv('operon-calendar-multi-week-group');
			this.renderMultiWeekWeekHeader(weekGroup, group.visibleDates, state);
			if (state.showAllDayLane || state.showDueMarkers) {
				this.renderAllDaySection(
					weekGroup,
					group.visibleDates,
					scheduledItems,
					dueItems,
					[],
					preset,
					settings,
					state.showAllDayLane,
					state.showDueMarkers,
					false,
					'multiWeek',
				);
			}
			if (state.showInDayLane) {
				this.renderMultiWeekInDaySection(weekGroup, group.visibleDates, timedItems, preset, settings);
			}
			if (state.showFinishedLane) {
				this.renderAllDaySection(
					weekGroup,
					group.visibleDates,
					[],
					[],
					finishedItems,
					preset,
					settings,
					false,
					false,
					true,
					'multiWeek',
				);
			}
		}
	}

	private renderMultiWeekWeekHeader(
		container: HTMLElement,
		visibleDates: string[],
		state: CalendarLeafState,
	): void {
		const headerRow = container.createDiv('operon-calendar-day-header-row operon-calendar-multi-week-header-row');
		const gutterSpacer = headerRow.createDiv('operon-calendar-gutter-spacer');
			if (!state.showAllDayLane || !state.showDueMarkers || !state.showInDayLane || !state.showFinishedLane) {
			const hiddenStack = gutterSpacer.createDiv('operon-calendar-hidden-lane-toggle-stack');
			if (!state.showAllDayLane) {
					this.renderLaneToggleButton(hiddenStack, t('calendar', 'allDay'), false, () => {
					void this.updateLeafState({
						...this.ensureState(),
						showAllDayLane: true,
					});
				}, true);
			}
			if (!state.showDueMarkers) {
					this.renderLaneToggleButton(hiddenStack, t('calendar', 'due'), false, () => {
					void this.updateLeafState({
						...this.ensureState(),
						showDueMarkers: true,
					});
				}, true);
			}
			if (!state.showInDayLane) {
					this.renderLaneToggleButton(hiddenStack, t('calendar', 'inDay'), false, () => {
					void this.updateLeafState({
						...this.ensureState(),
						showInDayLane: true,
					});
				}, true);
			}
			if (!state.showFinishedLane) {
					this.renderLaneToggleButton(hiddenStack, t('calendar', 'finished'), false, () => {
					void this.updateLeafState({
						...this.ensureState(),
						showFinishedLane: true,
					});
				}, true);
			}
		}

		const daysGrid = headerRow.createDiv('operon-calendar-day-header-grid');
		daysGrid.style.gridTemplateColumns = `repeat(${Math.max(1, visibleDates.length)}, minmax(0, 1fr))`;
		for (const dateKey of visibleDates) {
			const cell = daysGrid.createDiv('operon-calendar-day-header-cell');
			const dayDate = this.parseDateKey(dateKey);
			cell.classList.toggle('is-weekend', dayDate?.getDay() === 0 || dayDate?.getDay() === 6);
			if (dateKey === localToday()) {
				cell.addClass('is-today');
			}
			cell.addClass('is-clickable');
			cell.tabIndex = 0;
			cell.addEventListener('click', () => {
				void this.callbacks.onOpenDailyNote?.(dateKey);
			});
			cell.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				void this.callbacks.onOpenDailyNote?.(dateKey);
			});
			const topLine = cell.createDiv('operon-calendar-day-header-topline');
			topLine.createDiv({
				text: this.formatWeekdayLabel(dateKey),
				cls: 'operon-calendar-day-header-weekday',
			});
			this.renderWeekLabelForDayHeader(topLine, dateKey);
			cell.createDiv({
				text: this.formatDayLabel(dateKey),
				cls: 'operon-calendar-day-header-date',
			});
		}
	}

	private renderMultiWeekInDaySection(
		container: HTMLElement,
		visibleDates: string[],
		timedItems: CalendarItem[],
		preset: CalendarPreset,
		settings: OperonSettings,
	): void {
		const row = container.createDiv('operon-calendar-multi-week-inday-row');
		const labelEl = row.createDiv('operon-calendar-row-label');
		this.renderLaneToggleButton(labelEl, t('calendar', 'inDay'), true, () => {
			void this.updateLeafState({
				...this.ensureState(),
				showInDayLane: false,
			});
		});

		const body = row.createDiv('operon-calendar-multi-week-inday-body');
		const dayLists: HTMLElement[] = [];
		this.multiWeekInDayDropContexts.push({
			body,
			dayLists,
			visibleDates: [...visibleDates],
			preset,
			settings,
		});
		const grid = body.createDiv('operon-calendar-multi-week-inday-grid');
		grid.style.gridTemplateColumns = `repeat(${Math.max(1, visibleDates.length)}, minmax(0, 1fr))`;
		const timedPlacements = this.buildTimedPlacements(timedItems, visibleDates);
		const placementsByDay = new Map<number, TimedSegmentPlacement[]>();
		for (const placement of timedPlacements) {
			const list = placementsByDay.get(placement.dayIndex) ?? [];
			list.push(placement);
			placementsByDay.set(placement.dayIndex, list);
		}

		for (let dayIndex = 0; dayIndex < visibleDates.length; dayIndex++) {
			const dateKey = visibleDates[dayIndex];
			const cell = grid.createDiv('operon-calendar-multi-week-inday-cell');
			const dayDate = this.parseDateKey(dateKey);
			cell.classList.toggle('is-weekend', dayDate?.getDay() === 0 || dayDate?.getDay() === 6);
			if (dateKey === localToday()) {
				cell.addClass('is-today');
			}
			this.bindCalendarCellQuickAdd(cell, dateKey, () => {
				void this.callbacks.onAllDaySlotSelection?.(buildAllDaySlotSelection(dateKey, dateKey));
			});
			const listEl = cell.createDiv('operon-calendar-multi-week-inday-list');
			dayLists.push(listEl);
			const dayPlacements = (placementsByDay.get(dayIndex) ?? []).sort((left, right) => {
				if (left.startMinutes !== right.startMinutes) return left.startMinutes - right.startMinutes;
				if (left.endMinutes !== right.endMinutes) return left.endMinutes - right.endMinutes;
				return (left.item.renderSnapshot.description || left.item.taskId).localeCompare(
					right.item.renderSnapshot.description || right.item.taskId,
				);
			});
			for (const placement of dayPlacements) {
				this.renderMultiWeekInDayItem(listEl, placement, visibleDates, preset, settings);
			}
		}
	}

	private renderMultiWeekInDayItem(
		container: HTMLElement,
		placement: TimedSegmentPlacement,
		visibleDates: string[],
		preset: CalendarPreset,
		settings: OperonSettings,
	): void {
		const itemEl = container.createDiv('operon-calendar-multi-week-inday-item');
		itemEl.addClass(`is-${placement.item.renderSnapshot.checkbox}`);
		if (placement.item.isDashed || placement.item.origin === 'projected') itemEl.addClass('is-dashed');
		if (placement.item.origin === 'projected') itemEl.addClass('is-projected');
		if (placement.item.origin === 'external') itemEl.addClass('is-external');
		this.applyCalendarItemColor(itemEl, placement.item, preset, settings);

		const content = itemEl.createDiv('operon-calendar-multi-week-inday-item-content');
		const mainRow = content.createDiv('operon-calendar-multi-week-inday-main-row');
		const hoverTrigger = this.renderCalendarItemLabel(mainRow, placement.item, settings, true);
		const metaRow = content.createDiv('operon-calendar-multi-week-inday-meta-row');
		const chips = metaRow.createDiv('operon-calendar-multi-week-inday-time-chips');
		const dateKey = visibleDates[placement.dayIndex] ?? placement.item.startDate;
		this.renderMultiWeekTimeChip(chips, 'datetimeStart', dateKey, placement.startMinutes, settings);
		this.renderMultiWeekTimeChip(chips, 'datetimeEnd', dateKey, placement.endMinutes, settings);
		this.bindPrimaryItemClick(itemEl, placement.item);
		if (hoverTrigger) {
			this.bindHoverMenuTarget(hoverTrigger, placement.item);
		}
		if (placement.item.origin !== 'external' && placement.item.startDate === placement.item.endDate) {
			itemEl.addClass('is-draggable');
			this.bindMultiWeekInDayItemInteraction(itemEl, placement, visibleDates, preset, settings);
		} else {
			itemEl.addClass('is-read-only');
		}
	}

	private renderSidebarShell(
		root: HTMLElement,
		state: CalendarLeafState,
		preset: CalendarPreset,
		visibleDates: string[],
	): HTMLElement {
		root.addClass('is-sidebar-mode');
		const layout = root.createDiv('operon-calendar-sidebar-layout');
		layout.style.setProperty('--operon-calendar-sidebar-width', `${this.resolveSidebarWidthPx()}px`);
		const sidebar = layout.createDiv('operon-calendar-sidebar');
		const resizeHandle = layout.createDiv('operon-calendar-sidebar-resize-handle');
		const surfaceScroll = layout.createDiv('operon-calendar-surface-scroll');
		this.surfaceScrollEl = surfaceScroll;
		const surface = surfaceScroll.createDiv('operon-calendar-surface');
		this.renderSidebar(sidebar, state, preset, visibleDates);
		this.bindSidebarResizeHandle(resizeHandle, layout);
		return surface;
	}

	private renderSurfaceScrollShell(container: HTMLElement): HTMLElement {
		const scroll = container.createDiv('operon-calendar-surface-scroll');
		this.surfaceScrollEl = scroll;
		return scroll.createDiv('operon-calendar-surface');
	}

	private renderCalendarQuickActions(
		container: HTMLElement,
		preset: CalendarPreset,
		placement: 'toolbar' | 'sidebar',
	): HTMLElement {
		const actions = container.createDiv(`operon-calendar-quick-actions is-${placement}`);
		const showProjectedOccurrences = preset.showProjectedOccurrences !== false;
		const projectedLabel = showProjectedOccurrences
			? t('calendar', 'hideFutureOccurrences')
			: t('calendar', 'showFutureOccurrences');
		const projectedButton = actions.createEl('button', {
			cls: 'operon-calendar-quick-action-button',
			attr: {
				type: 'button',
				'aria-pressed': String(showProjectedOccurrences),
			},
		});
		projectedButton.classList.toggle('is-on', showProjectedOccurrences);
		projectedButton.classList.toggle('is-off', !showProjectedOccurrences);
		setIcon(projectedButton, showProjectedOccurrences ? 'eye' : 'eye-off');
		setAccessibleLabelWithoutTooltip(projectedButton, projectedLabel);
		bindOperonHoverTooltip(projectedButton, { content: projectedLabel, taskColor: null });
		projectedButton.addEventListener('click', (event) => {
			event.preventDefault();
			void this.callbacks.onToggleProjectedOccurrences?.(preset.id, !showProjectedOccurrences);
		});

			const selectedExternalCalendarCount = this.getSettings().externalCalendars
				.filter(source => source.enabled && preset.externalCalendarVisibility[source.id] === true)
				.length;
		const hasSelectedExternalCalendars = selectedExternalCalendarCount > 0;
		const showExternalCalendars = preset.showExternalCalendars !== false;
		const externalCalendarsLabel = hasSelectedExternalCalendars
			? showExternalCalendars
				? t('calendar', 'hideExternalCalendars')
				: t('calendar', 'showExternalCalendars')
			: t('calendar', 'noExternalCalendarsSelectedForPreset');
		const externalCalendarsButton = actions.createEl('button', {
			cls: 'operon-calendar-quick-action-button',
			attr: {
				type: 'button',
				'aria-pressed': String(showExternalCalendars && hasSelectedExternalCalendars),
				'aria-disabled': String(!hasSelectedExternalCalendars),
			},
		});
		externalCalendarsButton.classList.toggle('is-on', showExternalCalendars && hasSelectedExternalCalendars);
		externalCalendarsButton.classList.toggle('is-off', !showExternalCalendars || !hasSelectedExternalCalendars);
		externalCalendarsButton.classList.toggle('is-disabled', !hasSelectedExternalCalendars);
		setIcon(externalCalendarsButton, showExternalCalendars && hasSelectedExternalCalendars ? 'calendar-check' : 'calendar-off');
		setAccessibleLabelWithoutTooltip(externalCalendarsButton, externalCalendarsLabel);
		bindOperonHoverTooltip(externalCalendarsButton, { content: externalCalendarsLabel, taskColor: null });
		externalCalendarsButton.addEventListener('click', (event) => {
			event.preventDefault();
			if (!hasSelectedExternalCalendars) return;
			void this.callbacks.onToggleExternalCalendars?.(preset.id, !showExternalCalendars);
		});

		const currentColorSource = normalizeTaskColorSource(preset.colorSource, CALENDAR_TASK_COLOR_SOURCES, 'taskColor');
		const nextColorSource = getNextTaskColorSource(currentColorSource, CALENDAR_TASK_COLOR_SOURCES, 'taskColor');
		const colorSourceLabel = t('calendar', 'cycleTaskColorSourceTooltip', {
			current: getTaskColorSourceLabel(currentColorSource),
			next: getTaskColorSourceLabel(nextColorSource),
		});
		const colorSourceButton = actions.createEl('button', {
			cls: 'operon-calendar-quick-action-button',
			attr: { type: 'button' },
		});
		setIcon(colorSourceButton, getTaskColorSourceIcon(currentColorSource));
		setAccessibleLabelWithoutTooltip(colorSourceButton, colorSourceLabel);
		bindOperonHoverTooltip(colorSourceButton, { content: colorSourceLabel, taskColor: null });
		colorSourceButton.addEventListener('click', (event) => {
			event.preventDefault();
			void this.callbacks.onCycleTaskColorSource?.(preset.id, nextColorSource);
		});

		const syncExternalCalendarsLabel = t('commands', 'updateExternalCalendars');
		const syncExternalCalendarsButton = actions.createEl('button', {
			cls: 'operon-calendar-quick-action-button',
			attr: { type: 'button' },
		});
		setIcon(syncExternalCalendarsButton, 'calendar-sync');
		setAccessibleLabelWithoutTooltip(syncExternalCalendarsButton, syncExternalCalendarsLabel);
		bindOperonHoverTooltip(syncExternalCalendarsButton, { content: syncExternalCalendarsLabel, taskColor: null });
		syncExternalCalendarsButton.addEventListener('click', (event) => {
			event.preventDefault();
			void this.callbacks.onSyncExternalCalendars?.();
		});

		const settingsButton = actions.createEl('button', {
			cls: 'operon-calendar-quick-action-button',
			attr: { type: 'button' },
		});
		setIcon(settingsButton, 'settings-2');
		setAccessibleLabelWithoutTooltip(settingsButton, t('calendar', 'editCurrentCalendarPreset'));
		bindOperonHoverTooltip(settingsButton, { content: t('calendar', 'editCurrentCalendarPreset'), taskColor: null });
		settingsButton.addEventListener('click', (event) => {
			event.preventDefault();
			void this.callbacks.onOpenPresetSettings?.(preset.id);
		});
		return actions;
	}

	private renderSidebar(
		container: HTMLElement,
		state: CalendarLeafState,
		preset: CalendarPreset,
		visibleDates: string[],
	): void {
		const header = container.createDiv('operon-calendar-sidebar-header');
		this.createToolbarIconButton(
			header,
			['panel-left'],
			() => {
				void this.updateLeafState({
					...state,
					navigationMode: 'toolbar',
				});
			},
				t('calendar', 'toggleToToolbar'),
				t('calendar', 'toggleToToolbar'),
				'operon-calendar-sidebar-toggle-button',
			);
			header.createDiv({
				text: t('calendar', 'title'),
				cls: 'operon-calendar-sidebar-header-title',
			});

		this.renderMiniMonth(container, state, preset);
		this.renderCalendarQuickActions(container, preset, 'sidebar');

		const sectionsWrapper = container.createDiv('operon-calendar-sidebar-pools-wrapper');
		const presetSection = sectionsWrapper.createDiv('operon-calendar-sidebar-section operon-calendar-sidebar-calendars-section operon-calendar-sidebar-managed-section');
		presetSection.classList.toggle('is-open', state.calendarsOpen);
		const presetToggle = presetSection.createEl('button', {
			cls: 'operon-calendar-sidebar-task-pool-toggle',
			attr: { type: 'button', 'aria-expanded': String(state.calendarsOpen) },
		});
		presetToggle.createSpan({ text: t('calendar', 'calendars') });
		const presetToggleIcon = presetToggle.createSpan('operon-calendar-sidebar-task-pool-toggle-icon');
		setIcon(presetToggleIcon, state.calendarsOpen ? 'chevron-down' : 'chevron-right');
		presetToggle.addEventListener('click', () => {
			void this.toggleSidebarSection('calendars');
		});
		if (state.calendarsOpen) {
			const presetList = presetSection.createDiv('operon-calendar-sidebar-preset-list operon-calendar-sidebar-section-scroll');
			const visiblePresets = this.getSettings().calendarPresets;
			for (const entry of visiblePresets) {
				const row = presetList.createDiv('operon-calendar-sidebar-preset-row');
				row.classList.toggle('is-active', entry.id === preset.id);
				row.tabIndex = 0;

				const button = row.createEl('button', {
					text: entry.name,
					cls: 'operon-calendar-sidebar-preset-button',
					attr: { type: 'button' },
				});
				button.addEventListener('click', () => {
					void this.updateLeafState({
						...state,
						presetId: entry.id,
					});
				});

				button.addEventListener('keydown', (event) => {
					if (event.key !== 'Enter' && event.key !== ' ') return;
					event.preventDefault();
					void this.updateLeafState({
						...state,
						presetId: entry.id,
					});
				});
			}
		}

		this.renderSidebarTaskPool(sectionsWrapper, preset, visibleDates);
		this.renderSidebarFinishedTasks(sectionsWrapper, preset, visibleDates);
		this.bindSidebarSectionLayout(sectionsWrapper);
	}

	private bindSidebarSectionLayout(wrapper: HTMLElement): void {
		this.sidebarSectionsLayoutCleanup?.();
		const generation = this.renderGeneration;
		const schedule = (): void => {
			this.requestRenderAnimationFrame(generation, () => this.adjustSidebarSectionHeights(wrapper));
		};
		schedule();
		const observer = new ResizeObserver(() => schedule());
		observer.observe(wrapper);
		this.sidebarSectionsLayoutCleanup = () => observer.disconnect();
	}

	private adjustSidebarSectionHeights(wrapper: HTMLElement): void {
		const sections = Array.from(wrapper.querySelectorAll<HTMLElement>('.operon-calendar-sidebar-managed-section'));
		if (sections.length === 0) return;

		for (const section of sections) {
			section.style.removeProperty('max-height');
		}

		const wrapperHeight = wrapper.clientHeight;
		if (wrapperHeight <= 0) return;

		const gapValue = Number.parseFloat(getComputedStyle(wrapper).rowGap || getComputedStyle(wrapper).gap || '0') || 0;
		const totalGap = Math.max(0, sections.length - 1) * gapValue;
		const closedHeight = sections
			.filter(section => !section.classList.contains('is-open'))
			.reduce((sum, section) => sum + section.offsetHeight, 0);
		const openSections = sections.filter(section => section.classList.contains('is-open'));
		if (openSections.length === 0) return;

		const availableForOpen = Math.max(0, wrapperHeight - totalGap - closedHeight);
		if (openSections.length === 1) {
			openSections[0].style.maxHeight = `${Math.floor(availableForOpen)}px`;
			return;
		}

		const [first, second] = openSections;
		const half = Math.floor(availableForOpen / 2);
		const firstNatural = first.scrollHeight;
		const secondNatural = second.scrollHeight;

		let firstHeight = half;
		let secondHeight = availableForOpen - half;

		if (firstNatural <= half && secondNatural > half) {
			firstHeight = firstNatural;
			secondHeight = availableForOpen - firstHeight;
		} else if (secondNatural <= half && firstNatural > half) {
			secondHeight = secondNatural;
			firstHeight = availableForOpen - secondHeight;
		} else if (firstNatural <= half && secondNatural <= half) {
			if (firstNatural <= secondNatural) {
				firstHeight = firstNatural;
				secondHeight = availableForOpen - firstHeight;
			} else {
				secondHeight = secondNatural;
				firstHeight = availableForOpen - secondHeight;
			}
		}

		first.style.maxHeight = `${Math.max(0, Math.floor(firstHeight))}px`;
		second.style.maxHeight = `${Math.max(0, Math.floor(secondHeight))}px`;
	}

	private renderMiniMonth(container: HTMLElement, state: CalendarLeafState, preset: CalendarPreset): void {
		const monthCard = container.createDiv('operon-calendar-sidebar-month');
		const anchorDate = state.anchorDate;
		const anchorDateObject = this.parseDateKey(anchorDate) ?? this.parseDateKey(localToday()) ?? new Date();
		monthCard.createDiv({
			text: new Intl.DateTimeFormat(getAppLocale(this.app), {
				month: 'long',
				year: 'numeric',
			}).format(anchorDateObject),
			cls: 'operon-calendar-sidebar-month-title',
		});
		const navRow = monthCard.createDiv('operon-calendar-sidebar-month-nav');
		const shiftAnchorMonth = (delta: number): void => {
			const base = this.parseDateKey(this.ensureState().anchorDate) ?? this.parseDateKey(localToday()) ?? new Date();
			const year = base.getFullYear();
			const month = base.getMonth();
			const day = base.getDate();
			const targetMonthBase = new Date(year, month + delta, 1, 12, 0, 0, 0);
			const targetMonthLastDay = new Date(targetMonthBase.getFullYear(), targetMonthBase.getMonth() + 1, 0).getDate();
			const nextAnchor = new Date(targetMonthBase.getFullYear(), targetMonthBase.getMonth(), Math.min(day, targetMonthLastDay), 12, 0, 0, 0);
			void this.updateLeafState({
				...this.ensureState(),
				anchorDate: this.formatDateKey(nextAnchor),
			});
		};
		this.createToolbarIconButton(
			navRow,
			['step-back'],
			() => shiftAnchorMonth(-1),
			t('calendar', 'previousMonth'),
			t('calendar', 'previousMonth'),
			'operon-calendar-sidebar-month-nav-button',
		);
		this.createToolbarButton(
			navRow,
			this.formatFocusedDateButtonLabel(state.anchorDate),
			() => {
				void this.handleTodayButtonClick(state, preset);
			},
			undefined,
			'operon-calendar-sidebar-month-nav-today',
		);
		this.createToolbarIconButton(
			navRow,
			['step-forward'],
			() => shiftAnchorMonth(1),
			t('calendar', 'nextMonth'),
			t('calendar', 'nextMonth'),
			'operon-calendar-sidebar-month-nav-button',
		);

		const settings = this.getSettings();
		const showWeekNumbers = settings.calendarSidebarShowWeekNumbers;
		const weekdayRow = monthCard.createDiv('operon-calendar-sidebar-month-weekdays');
		weekdayRow.classList.toggle('has-week-numbers', showWeekNumbers);
		if (showWeekNumbers) {
			weekdayRow.createDiv({
				text: 'W',
				cls: 'operon-calendar-sidebar-month-weeknum-header',
			});
		}
		const weekdayFormatter = new Intl.DateTimeFormat(getAppLocale(this.app), { weekday: 'short' });
		const weekdayOrder = settings.calendarWeekStart === 'sunday'
			? [0, 1, 2, 3, 4, 5, 6]
			: [1, 2, 3, 4, 5, 6, 0];
		for (const weekdayIndex of weekdayOrder) {
			const weekdayDate = new Date(2026, 2, 1 + weekdayIndex);
			const weekdayLabel = weekdayFormatter.format(weekdayDate).replace('.', '');
			const normalizedWeekdayLabel = weekdayLabel
				? weekdayLabel.charAt(0).toUpperCase() + weekdayLabel.slice(1).toLowerCase()
				: weekdayLabel;
			const weekdayEl = weekdayRow.createDiv({
				text: normalizedWeekdayLabel,
				cls: 'operon-calendar-sidebar-month-weekday',
			});
			weekdayEl.classList.toggle('is-weekend', weekdayIndex === 0 || weekdayIndex === 6);
		}

		const grid = monthCard.createDiv('operon-calendar-sidebar-month-grid');
		grid.classList.toggle('has-week-numbers', showWeekNumbers);
		const monthStart = new Date(anchorDateObject.getFullYear(), anchorDateObject.getMonth(), 1, 12, 0, 0, 0);
		const monthStartWeekday = monthStart.getDay();
		const weekStartOffset = settings.calendarWeekStart === 'sunday'
			? monthStartWeekday
			: (monthStartWeekday + 6) % 7;
		const gridStart = new Date(monthStart);
		gridStart.setDate(gridStart.getDate() - weekStartOffset);
		const today = localToday();

		for (let weekIndex = 0; weekIndex < 6; weekIndex++) {
				const weekStartDate = new Date(gridStart);
				weekStartDate.setDate(gridStart.getDate() + weekIndex * 7);
				if (showWeekNumbers) {
					grid.createDiv({
						text: String(this.getCalendarWeekNumber(weekStartDate, settings.calendarWeekStart)),
						cls: 'operon-calendar-sidebar-month-weeknum',
					});
			}
			for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
				const current = new Date(weekStartDate);
				current.setDate(weekStartDate.getDate() + dayOffset);
				const dateKey = this.formatDateKey(current);
				const button = grid.createEl('button', {
					text: String(current.getDate()),
					cls: 'operon-calendar-sidebar-month-day',
					attr: { type: 'button' },
				});
				button.classList.toggle('is-weekend', current.getDay() === 0 || current.getDay() === 6);
				button.classList.toggle('is-outside-month', current.getMonth() !== anchorDateObject.getMonth());
				button.classList.toggle('is-anchor', dateKey === anchorDate);
				button.classList.toggle('is-today', dateKey === today);
				button.addEventListener('click', () => {
					void this.updateLeafState({
						...this.ensureState(),
						anchorDate: dateKey,
					});
				});
			}
		}
	}

	private getCalendarWeekNumber(date: Date, weekStart: 'monday' | 'sunday'): number {
		if (weekStart === 'monday') {
			const current = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
			const day = current.getUTCDay() || 7;
			current.setUTCDate(current.getUTCDate() + 4 - day);
			const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
			return Math.ceil((((current.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
		}
		const current = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
		const yearStart = new Date(current.getFullYear(), 0, 1, 12, 0, 0, 0);
		const offset = yearStart.getDay();
		const firstWeekStart = new Date(yearStart);
		firstWeekStart.setDate(yearStart.getDate() - offset);
		return Math.floor((current.getTime() - firstWeekStart.getTime()) / (7 * 86400000)) + 1;
	}

	private renderWeekLabelForDayHeader(container: HTMLElement, dateKey: string): void {
		const settings = this.getSettings();
		if (!settings.calendarShowWeekLabelOnFirstDay) return;
		const date = this.parseDateKey(dateKey);
		if (!date || !this.isCalendarWeekStartDate(date, settings.calendarWeekStart)) return;
		container.createDiv({
			text: `W${this.getCalendarWeekNumber(date, settings.calendarWeekStart)}`,
			cls: 'operon-calendar-day-header-week-label',
		});
	}

	private isCalendarWeekStartDate(date: Date, weekStart: 'monday' | 'sunday'): boolean {
		return weekStart === 'sunday' ? date.getDay() === 0 : date.getDay() === 1;
	}

	private createCalendarDragGhost(sourceEl: HTMLElement, extraClass: string): HTMLElement {
		const ghost = sourceEl.cloneNode(true) as HTMLElement;
		ghost.classList.remove('is-dragging', 'operon-calendar-drag-source-hidden');
		ghost.classList.add('operon-calendar-drag-ghost', extraClass);
		ghost.style.width = `${Math.ceil(sourceEl.getBoundingClientRect().width)}px`;
		getOwnerBody(sourceEl).appendChild(ghost);
		this.calendarDragGhosts.add(ghost);
		return ghost;
	}

		private removeCalendarDragGhost(ghostEl: HTMLElement | null | undefined): void {
			if (!ghostEl) return;
			ghostEl.remove();
			this.calendarDragGhosts.delete(ghostEl);
		}

		private clearCalendarDragGhosts(): void {
			for (const ghostEl of Array.from(this.calendarDragGhosts)) {
				ghostEl.remove();
			}
			this.calendarDragGhosts.clear();
		}

		private updateCalendarDragGhostPosition(ghostEl: HTMLElement | null, clientX: number, clientY: number): void {
			if (!ghostEl) return;
			ghostEl.style.left = `${Math.round(clientX + 14)}px`;
		ghostEl.style.top = `${Math.round(clientY + 14)}px`;
	}

	private bindCalendarCellQuickAdd(
		cell: HTMLElement,
		dateKey: string,
		onChoose: () => void,
	): void {
		if (!this.callbacks.onAllDaySlotSelection) return;
		const overlay = cell.createDiv('operon-calendar-cell-add-overlay');
		const button = overlay.createEl('button', {
				cls: 'operon-calendar-cell-add-button',
					attr: {
						type: 'button',
					},
				});
			setIcon(button, 'list-plus');
			if (!button.querySelector('svg')) {
				setIcon(button, 'list');
			}
			setAccessibleLabelWithoutTooltip(button, t('calendar', 'addTaskToDate', { date: dateKey }));
		button.addEventListener('pointerdown', event => {
			event.preventDefault();
			event.stopPropagation();
		});
		button.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			cell.classList.remove('is-add-hotspot-active');
			overlay.classList.remove('is-visible');
			onChoose();
		});

		let isVisible = false;
		const setVisible = (nextVisible: boolean): void => {
			if (isVisible === nextVisible) return;
			isVisible = nextVisible;
			cell.classList.toggle('is-add-hotspot-active', nextVisible);
			overlay.classList.toggle('is-visible', nextVisible);
		};

		const updateFromPointer = (event: PointerEvent): void => {
			const rect = cell.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				setVisible(false);
				return;
			}
			const xRatio = (event.clientX - rect.left) / rect.width;
			const yRatio = (event.clientY - rect.top) / rect.height;
			const isWithinCenter = xRatio >= 0.34 && xRatio <= 0.66
				&& yRatio >= 0.30 && yRatio <= 0.70;
			setVisible(isWithinCenter);
		};

		cell.addEventListener('pointermove', updateFromPointer);
		cell.addEventListener('pointerleave', () => setVisible(false));
		cell.addEventListener('scroll', () => setVisible(false));
		cell.addEventListener('drop', () => setVisible(false));
		cell.addEventListener('dragstart', () => setVisible(false));
	}

	private renderSidebarTaskPool(
		container: HTMLElement,
		preset: CalendarPreset,
		visibleDates: string[],
	): void {
		const section = container.createDiv('operon-calendar-sidebar-section operon-calendar-sidebar-task-pool-section operon-calendar-sidebar-managed-section');
		section.classList.toggle('is-open', this.ensureState().taskPoolOpen);
		const toggleButton = section.createEl('button', {
			cls: 'operon-calendar-sidebar-task-pool-toggle',
			attr: { type: 'button', 'aria-expanded': String(this.ensureState().taskPoolOpen) },
		});
		toggleButton.createSpan({ text: t('calendar', 'taskPool') });
		const toggleIcon = toggleButton.createSpan('operon-calendar-sidebar-task-pool-toggle-icon');
		setIcon(toggleIcon, this.ensureState().taskPoolOpen ? 'chevron-down' : 'chevron-right');
		toggleButton.addEventListener('click', () => {
			void this.toggleSidebarSection('taskPool');
		});

		if (!this.ensureState().taskPoolOpen) return;

		const modeRow = section.createDiv('operon-calendar-sidebar-task-pool-modes');
		const createModeButton = (
			mode: CalendarSidebarTaskPoolMode,
			label: string,
		): void => {
			const button = modeRow.createEl('button', {
				text: label,
				cls: 'operon-calendar-sidebar-task-pool-mode-button',
				attr: { type: 'button' },
			});
			button.classList.toggle('is-active', this.taskPoolMode === mode);
			button.addEventListener('click', () => {
				if (this.taskPoolMode === mode) return;
				this.taskPoolMode = mode;
				updateSearchPlaceholder();
				updateList();
				for (const sibling of Array.from(modeRow.querySelectorAll<HTMLElement>('.operon-calendar-sidebar-task-pool-mode-button'))) {
					sibling.classList.toggle('is-active', sibling === button);
				}
			});
		};
		createModeButton('overdue', t('calendar', 'overdue'));
		createModeButton('unscheduled', t('calendar', 'unscheduled'));
		createModeButton('all', t('calendar', 'all'));

		const controls = section.createDiv('operon-calendar-sidebar-task-pool-controls');
		const searchInput = controls.createEl('input', {
			cls: 'operon-calendar-sidebar-task-pool-search',
			attr: {
				type: 'search',
				spellcheck: 'false',
			},
		});
		searchInput.value = this.taskPoolQuery;

		const updateSearchPlaceholder = (): void => {
			searchInput.placeholder = this.taskPoolMode === 'overdue'
				? t('calendar', 'searchOverdueTasks')
				: this.taskPoolMode === 'all'
					? t('calendar', 'searchAllTasks')
					: t('calendar', 'searchUnscheduledTasks');
		};

		const list = section.createDiv('operon-calendar-sidebar-task-pool-list operon-calendar-sidebar-section-scroll');
		const summary = section.createDiv('operon-calendar-sidebar-task-pool-summary');
		const updateList = (): void => {
			list.empty();
			const candidates = collectCalendarSidebarTaskPoolCandidates(this.getOptimisticCalendarTasksForRender(), this.taskPoolMode);
			const query = this.taskPoolQuery.trim();
			const allMatches = !query
				? candidates
				: this.rankSidebarTaskPoolMatches(candidates, query);
			const visibleMatches = allMatches.slice(0, query
				? CALENDAR_SIDEBAR_TASK_POOL_SEARCH_LIMIT
				: CALENDAR_SIDEBAR_TASK_POOL_INITIAL_LIMIT);
			const modeLabel = this.taskPoolMode === 'overdue'
				? t('calendar', 'overdue')
				: this.taskPoolMode === 'all'
					? t('calendar', 'open')
					: t('calendar', 'unscheduled');
			summary.setText(t('calendar', 'taskPoolSummary', {
				visible: String(visibleMatches.length),
				total: String(allMatches.length),
				mode: modeLabel,
				taskWord: this.getCalendarTaskWord(allMatches.length),
			}));
			if (visibleMatches.length === 0) {
				list.createDiv({
					text: query
						? t('calendar', 'noSearchMatches')
						: t('calendar', 'noOpenTasksForList'),
					cls: 'operon-calendar-sidebar-task-pool-empty',
				});
				this.adjustSidebarSectionHeights(container);
				return;
			}
			for (const task of visibleMatches) {
				const row = list.createDiv('operon-calendar-sidebar-task-pool-row');
				this.renderSidebarTaskPoolRow(row, task, preset, visibleDates);
			}
			this.adjustSidebarSectionHeights(container);
		};

		searchInput.addEventListener('input', () => {
			this.taskPoolQuery = searchInput.value;
			updateList();
		});

		updateSearchPlaceholder();
		updateList();
	}

	private renderSidebarFinishedTasks(
		container: HTMLElement,
		preset: CalendarPreset,
		visibleDates: string[],
	): void {
		const state = this.ensureState();
		const focusedDate = state.anchorDate;
		const section = container.createDiv('operon-calendar-sidebar-section operon-calendar-sidebar-finished-tasks-section operon-calendar-sidebar-managed-section');
		section.classList.toggle('is-open', state.finishedTasksOpen);
		const toggleButton = section.createEl('button', {
			cls: 'operon-calendar-sidebar-task-pool-toggle',
			attr: { type: 'button', 'aria-expanded': String(state.finishedTasksOpen) },
		});
		const dateLabel = (() => {
			const d = this.parseDateKey(focusedDate);
			if (!d) return focusedDate;
			return new Intl.DateTimeFormat(getAppLocale(this.app), {
				month: 'short',
				day: 'numeric',
			}).format(d);
		})();
		toggleButton.createSpan({ text: t('calendar', 'finishedTasksForDate', { date: dateLabel }) });
		const toggleIcon = toggleButton.createSpan('operon-calendar-sidebar-task-pool-toggle-icon');
		setIcon(toggleIcon, state.finishedTasksOpen ? 'chevron-down' : 'chevron-right');
		toggleButton.addEventListener('click', () => {
			void this.toggleSidebarSection('finishedTasks');
		});

		if (!state.finishedTasksOpen) return;

		const controls = section.createDiv('operon-calendar-sidebar-task-pool-controls');
		const searchInput = controls.createEl('input', {
			cls: 'operon-calendar-sidebar-task-pool-search',
			attr: {
					type: 'search',
					placeholder: t('calendar', 'searchFinishedTasks'),
					spellcheck: 'false',
				},
		});
		searchInput.value = this.finishedTasksQuery;

		const list = section.createDiv('operon-calendar-sidebar-task-pool-list operon-calendar-sidebar-section-scroll');
		const summary = section.createDiv('operon-calendar-sidebar-task-pool-summary');

		const updateList = (): void => {
			list.empty();
			const candidates = collectFinishedTasksForDate(this.indexer.getAllTasks(), focusedDate);
			const query = this.finishedTasksQuery.trim();
			const allMatches = !query
				? candidates
				: this.rankSidebarTaskPoolMatches(candidates, query);
			const visibleMatches = allMatches.slice(0, CALENDAR_SIDEBAR_FINISHED_TASKS_RENDER_LIMIT);
			summary.setText(t('calendar', 'finishedTasksSummary', {
				visible: String(visibleMatches.length),
				total: String(allMatches.length),
				taskWord: this.getCalendarTaskWord(allMatches.length),
			}));
			if (visibleMatches.length === 0) {
				list.createDiv({
					text: query
						? t('calendar', 'noSearchMatches')
						: t('calendar', 'noFinishedTasksForDay'),
					cls: 'operon-calendar-sidebar-task-pool-empty',
				});
				this.adjustSidebarSectionHeights(container);
				return;
			}
			for (const task of visibleMatches) {
				const row = list.createDiv('operon-calendar-sidebar-task-pool-row');
				this.renderSidebarTaskPoolRow(row, task, preset, visibleDates, 'finished');
			}
			this.adjustSidebarSectionHeights(container);
		};

		searchInput.addEventListener('input', () => {
			this.finishedTasksQuery = searchInput.value;
			updateList();
		});

		updateList();
	}

	private rankSidebarTaskPoolMatches(tasks: IndexedTask[], query: string): IndexedTask[] {
		const normalizedQuery = query.trim().toLowerCase();
		const fuzzySearch = prepareFuzzySearch(query.trim());
		return tasks
			.map((task, index) => {
				const containsRank = this.getSidebarTaskPoolContainsRank(task, normalizedQuery);
				const descriptionFuzzyMatch = fuzzySearch(task.description || '');
				const globalFuzzyMatch = fuzzySearch(buildCalendarSidebarTaskPoolSearchText(task));
				if (containsRank === null && !descriptionFuzzyMatch && !globalFuzzyMatch) return null;
				return {
					task,
					containsRank,
					descriptionFuzzyScore: descriptionFuzzyMatch?.score ?? Number.POSITIVE_INFINITY,
					globalFuzzyScore: globalFuzzyMatch?.score ?? Number.POSITIVE_INFINITY,
					sortRank: index,
				};
			})
			.filter((entry): entry is {
				task: IndexedTask;
				containsRank: number | null;
				descriptionFuzzyScore: number;
				globalFuzzyScore: number;
				sortRank: number;
			} => !!entry)
			.sort((left, right) => {
				const leftTier = left.containsRank ?? 100;
				const rightTier = right.containsRank ?? 100;
				if (leftTier !== rightTier) return leftTier - rightTier;
				if (left.descriptionFuzzyScore !== right.descriptionFuzzyScore) {
					return left.descriptionFuzzyScore - right.descriptionFuzzyScore;
				}
				if (left.globalFuzzyScore !== right.globalFuzzyScore) {
					return left.globalFuzzyScore - right.globalFuzzyScore;
				}
				return left.sortRank - right.sortRank;
			})
			.map(entry => entry.task);
	}

	private getCalendarTaskWord(count: number): string {
		return count === 1
			? t('calendar', 'taskSingular')
			: t('calendar', 'taskPlural');
	}

	private getSidebarTaskPoolContainsRank(task: IndexedTask, query: string): number | null {
		if (!query) return 0;
		const description = (task.description || '').toLowerCase();
		if (description.startsWith(query)) return 0;
		if (description.includes(query)) return 1;
		const containsFields = [
			task.tags.join(' ').toLowerCase(),
			(task.fieldValues['contexts'] ?? '').toLowerCase(),
			(task.fieldValues['related'] ?? '').toLowerCase(),
			(task.fieldValues['note'] ?? '').toLowerCase(),
		];
		return containsFields.some(value => value.includes(query)) ? 2 : null;
	}

		private renderSidebarTaskPoolRow(
			container: HTMLElement,
			task: IndexedTask,
			preset: CalendarPreset,
			visibleDates: string[],
			mode: 'pool' | 'finished' = 'pool',
		): void {
			container.dataset.operonId = task.operonId;
			this.applyCalendarCheckboxClass(container, task.checkbox);
			const priorityColor = this.resolveSidebarTaskPoolPriorityColor(task, this.getSettings());
			if (priorityColor) {
				container.style.setProperty('--operon-calendar-accent', priorityColor);
			} else {
			container.style.removeProperty('--operon-calendar-accent');
		}
		container.tabIndex = 0;
		const head = container.createDiv('operon-calendar-sidebar-task-pool-row-head');
		const hoverTrigger = head.createSpan('operon-calendar-hover-menu-trigger');
		this.renderSidebarTaskPoolStatusButton(hoverTrigger, task);

		const title = head.createSpan({
			text: task.description || task.operonId,
			cls: 'operon-calendar-sidebar-task-pool-row-title',
		});
		if (task.primary.format === 'yaml') {
			bindTaskTitleLinkPreview(this.app, title, task.primary.filePath, task.primary.filePath);
		}

		this.renderSidebarTaskPoolDateIndicators(head, task, mode);

		this.bindSidebarTaskPoolHoverMenuTarget(hoverTrigger, task);
		this.bindSidebarTaskPoolRowDrag(container, task, preset, visibleDates);
		container.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			void this.callbacks.onItemAction?.(task.operonId, 'openEditor');
		});
	}

	private resolveSidebarTaskPoolPriorityColor(task: IndexedTask, settings: OperonSettings): string | null {
		const priorityLabel = (task.fieldValues['priority'] ?? '').trim();
		if (!priorityLabel) return null;
		return settings.priorities.find(priority => priority.label === priorityLabel)?.color?.trim() || null;
	}

	private renderSidebarTaskPoolDateIndicators(
		container: HTMLElement,
		task: IndexedTask,
		mode: 'pool' | 'finished' = 'pool',
	): void {
		if (mode === 'finished') {
			const durationSecs = parseInt(task.fieldValues['duration'] ?? '0', 10);
			const totalDurationSecs = parseInt(task.fieldValues['totalDuration'] ?? '0', 10);
			const noteValue = (task.fieldValues['note'] ?? '').trim();
			if (!durationSecs && !totalDurationSecs && !noteValue) return;
			const meta = container.createSpan('operon-calendar-sidebar-task-pool-meta');
			if (durationSecs > 0) {
				this.renderSidebarTaskPoolDurationIndicator(meta, 'duration', durationSecs);
			}
			if (totalDurationSecs > 0) {
				this.renderSidebarTaskPoolDurationIndicator(meta, 'totalDuration', totalDurationSecs);
			}
			if (noteValue) {
				this.renderSidebarTaskPoolNoteIndicator(meta, noteValue);
			}
			return;
		}
		const scheduled = (task.fieldValues['dateScheduled'] ?? '').trim();
		const due = (task.fieldValues['dateDue'] ?? '').trim();
		const noteValue = (task.fieldValues['note'] ?? '').trim();
		if (!scheduled && !due && !noteValue) return;

		const meta = container.createSpan('operon-calendar-sidebar-task-pool-meta');
		if (scheduled) {
			this.renderSidebarTaskPoolDateIndicator(meta, 'dateScheduled', scheduled);
		}
		if (due) {
			this.renderSidebarTaskPoolDateIndicator(meta, 'dateDue', due);
		}
		if (noteValue) {
			this.renderSidebarTaskPoolNoteIndicator(meta, noteValue);
		}
	}

	private renderSidebarTaskPoolDateIndicator(
		container: HTMLElement,
		fieldKey: 'dateScheduled' | 'dateDue' | 'dateCompleted',
		fieldValue: string,
	): void {
		const settings = this.getSettings();
		const label = settings.keyMappings.find(mapping => mapping.canonicalKey === fieldKey)?.visiblePropertyName?.trim() || fieldKey;
		const iconName = getConfiguredKeyMappingIcon(fieldKey, settings.keyMappings) || INLINE_TASK_COMPACT_FALLBACK_ICONS[fieldKey];
		const indicator = container.createSpan('operon-calendar-sidebar-task-pool-date-indicator');
		bindOperonHoverTooltip(indicator, {
			content: `${label} ${fieldValue}`,
			taskColor: null,
		});
		if (iconName) {
			setIcon(indicator, iconName);
		}
		setAccessibleLabelWithoutTooltip(indicator, `${label} ${fieldValue}`);
	}

	private renderSidebarTaskPoolDurationIndicator(
		container: HTMLElement,
		fieldKey: 'duration' | 'totalDuration',
		seconds: number,
	): void {
		const settings = this.getSettings();
		const label = settings.keyMappings.find(mapping => mapping.canonicalKey === fieldKey)?.visiblePropertyName?.trim() || fieldKey;
		const iconName = getConfiguredKeyMappingIcon(fieldKey, settings.keyMappings) || INLINE_TASK_COMPACT_FALLBACK_ICONS[fieldKey];
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const formatted = h > 0 ? `${h}h ${m}m` : `${m}m`;
		const indicator = container.createSpan('operon-calendar-sidebar-task-pool-date-indicator');
		bindOperonHoverTooltip(indicator, {
			content: `${label} ${formatted}`,
			taskColor: null,
		});
		if (iconName) {
			setIcon(indicator, iconName);
		}
		setAccessibleLabelWithoutTooltip(indicator, `${label} ${formatted}`);
	}

	private renderSidebarTaskPoolNoteIndicator(container: HTMLElement, noteValue: string): void {
		const settings = this.getSettings();
		const indicator = container.createSpan('operon-calendar-sidebar-task-pool-date-indicator');
		bindOperonHoverTooltip(indicator, {
			title: t('calendar', 'notes'),
			content: noteValue,
			taskColor: null,
			preferredHorizontal: 'right',
		});
		setIcon(indicator, getConfiguredKeyMappingIcon('note', settings.keyMappings) || 'notebook-pen');
		setAccessibleLabelWithoutTooltip(indicator, t('calendar', 'notes'));
	}

	private bindSidebarTaskPoolHoverMenuTarget(triggerEl: HTMLElement, task: IndexedTask): void {
		if (!this.callbacks.onItemAction) return;
		triggerEl.addEventListener('pointerenter', () => {
			if (this.hoverMenu.isActive(task.operonId)) {
				this.hoverMenu.clearHideTimer();
				return;
			}
			const context: ContextualMenuContext = {
				surface: 'calendarSidebarTaskPoolTask',
				taskId: task.operonId,
				task,
				now: localNow(),
				isPinned: this.getPinnedCache()?.isPinned(task.operonId) ?? false,
			};
			const settings = this.getSettings();
			const actions = resolveContextualMenu(
				context,
				settings.contextualMenuActionAllowlist,
				settings.contextualMenuSurfaceActionMatrix,
			);
			this.scheduleCalendarHoverMenuShow(() => {
				this.showHoverMenuForActions(triggerEl, task.operonId, actions, undefined, context);
			});
		});
		triggerEl.addEventListener('pointerleave', (event: PointerEvent) => {
			this.clearHoverMenuShowTimer();
			const related = event.relatedTarget;
			if (this.hoverMenu.contains(related)) {
				this.clearHoverMenuHideTimer();
				return;
			}
			this.scheduleCalendarHoverMenuHide();
		});
	}

		private renderSidebarTaskPoolStatusButton(container: HTMLElement, task: IndexedTask): void {
			if (!this.callbacks.onStatusIconClick) return;
			const button = container.createEl('button', {
				cls: 'operon-checkbox operon-calendar-status-button is-compact operon-calendar-sidebar-task-pool-status',
					attr: {
						type: 'button',
						},
					});
			button.dataset.operonId = task.operonId;
			const settings = this.getSettings();
			const iconName = this.resolveStatusButtonIcon(task.fieldValues, task.checkbox, settings);
				if (iconName) {
					setIcon(button, iconName);
				}
				setAccessibleLabelWithoutTooltip(button, t('tooltips', 'cycleTaskStatus'));
			const statusColor = this.resolveCalendarStatusColorFromFieldValues(task.fieldValues, settings);
			if (statusColor) {
				button.style.color = statusColor;
			}
		button.addEventListener('pointerdown', event => {
			event.preventDefault();
			event.stopPropagation();
		});
			button.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				this.invokeCalendarStatusClickCallback(task.operonId, 'status-sidebar');
			});
		}

	private bindSidebarTaskPoolRowDrag(
		row: HTMLElement,
		task: IndexedTask,
		preset: CalendarPreset,
		visibleDates: string[],
	): void {
		const dragThresholdPx = 6;
		let dragState: {
			pointerId: number;
			initialClientX: number;
			initialClientY: number;
			activated: boolean;
			dropTarget: 'none' | 'timed' | 'allDay';
			timedSelection: CalendarSlotSelection | null;
			allDaySelection: CalendarSlotSelection | null;
			timedPreviewEl: HTMLElement | null;
			allDayPreviewEl: HTMLElement | null;
			dragGhostEl: HTMLElement | null;
		} | null = null;

		const clearPreviews = (): void => {
			dragState?.timedPreviewEl?.remove();
			dragState?.allDayPreviewEl?.remove();
			if (this.timedDropContext) {
				this.timedDropContext.hoverGuideOverlay.empty();
			}
			if (dragState) {
				dragState.timedPreviewEl = null;
				dragState.allDayPreviewEl = null;
			}
		};

		const clearDragArtifacts = (): void => {
			clearPreviews();
			this.removeCalendarDragGhost(dragState?.dragGhostEl);
			if (dragState) {
				dragState.dragGhostEl = null;
			}
		};

		const hasThreshold = (clientX: number, clientY: number): boolean => {
			if (!dragState) return false;
			return Math.hypot(clientX - dragState.initialClientX, clientY - dragState.initialClientY) >= dragThresholdPx;
		};

		const updateFromPointer = (clientX: number, clientY: number): void => {
			if (!dragState) return;
			if (!dragState.activated) {
				if (!hasThreshold(clientX, clientY)) return;
				dragState.activated = true;
				row.addClass('is-dragging');
				dragState.dragGhostEl = this.createCalendarDragGhost(row, 'operon-calendar-sidebar-task-pool-drag-ghost');
			}
			this.updateCalendarDragGhostPosition(dragState.dragGhostEl, clientX, clientY);

			dragState.dropTarget = 'none';
			dragState.timedSelection = null;
			dragState.allDaySelection = null;
			clearPreviews();

			if (this.allDayDropContext) {
				const allDayRect = this.allDayDropContext.body.getBoundingClientRect();
				const insideAllDay = clientX >= allDayRect.left
					&& clientX <= allDayRect.right
					&& clientY >= allDayRect.top
					&& clientY <= allDayRect.bottom;
					if (insideAllDay) {
					const column = this.resolveAllDayColumnIndex(this.allDayDropContext.body, clientX, this.allDayDropContext.visibleDates.length);
					const dateKey = this.allDayDropContext.visibleDates[column];
					if (dateKey) {
						dragState.dropTarget = 'allDay';
						dragState.allDaySelection = buildAllDaySlotSelection(dateKey, dateKey);
						dragState.allDayPreviewEl = this.allDayDropContext.overlay.createDiv('operon-calendar-all-day-transfer-preview');
						this.applyAllDayPlacementStyle(
							dragState.allDayPreviewEl,
							column,
							column,
							this.allDayDropContext.previewLane,
							this.allDayDropContext.laneHeight,
							this.allDayDropContext.visibleDates.length,
						);
						return;
					}
				}
			}
			const multiWeekAllDayTarget = this.resolveMultiWeekAllDayDropTarget(clientX, clientY);
			if (multiWeekAllDayTarget) {
				dragState.dropTarget = 'allDay';
				dragState.allDaySelection = buildAllDaySlotSelection(multiWeekAllDayTarget.dateKey, multiWeekAllDayTarget.dateKey);
				dragState.allDayPreviewEl = multiWeekAllDayTarget.context.overlay.createDiv('operon-calendar-all-day-transfer-preview');
				this.applyAllDayPlacementStyle(
					dragState.allDayPreviewEl,
					multiWeekAllDayTarget.column,
					multiWeekAllDayTarget.column,
					multiWeekAllDayTarget.context.previewLane,
					multiWeekAllDayTarget.context.laneHeight,
					multiWeekAllDayTarget.context.visibleDates.length,
				);
				return;
			}

			if (this.timedDropContext) {
				const timedRect = this.timedDropContext.daysGrid.getBoundingClientRect();
				const insideTimed = clientX >= timedRect.left
					&& clientX <= timedRect.right
					&& clientY >= timedRect.top
					&& clientY <= timedRect.bottom;
				if (insideTimed) {
					const position = this.resolveTimedGridPosition(
						this.timedDropContext.daysGrid,
						this.timedDropContext.visibleDates,
						this.timedDropContext.metrics,
						clientX,
						clientY,
					);
					const duration = this.resolveIndexedTaskDurationMinutes(task, preset.slotMinutes);
					const dateKey = this.timedDropContext.visibleDates[position.dayIndex] ?? visibleDates[position.dayIndex] ?? localToday();
					const timedSelection = buildTimedSlotSelection(
						dateKey,
						position.minuteOfDay,
						Math.min(24 * 60, position.minuteOfDay + duration),
						CALENDAR_TIMED_SNAP_MINUTES,
					);
					const previewStart = this.extractMinuteOfDay(timedSelection.start);
						const previewEnd = Math.min(24 * 60, previewStart + duration);
					dragState.dropTarget = 'timed';
					dragState.timedSelection = timedSelection;
					dragState.timedPreviewEl = this.timedDropContext.daysGrid.createDiv('operon-calendar-timed-transfer-preview');
					this.applyTimedPlacementStyle(
						dragState.timedPreviewEl,
						position.dayIndex,
						0,
						1,
						previewStart,
						previewEnd,
						this.timedDropContext.visibleDates.length,
						this.timedDropContext.metrics,
					);
					this.renderTimedSelectionGuides(
						this.timedDropContext.section,
						this.timedDropContext.gutter,
						this.timedDropContext.daysGrid,
						this.timedDropContext.hoverGuideOverlay,
						dateKey,
						previewStart,
						previewEnd,
						this.timedDropContext.metrics,
						'var(--interactive-accent)',
						this.timedDropContext.settings,
						position.dayIndex,
						this.timedDropContext.visibleDates.length,
					);
				}
			}
			const multiWeekInDayTarget = this.resolveMultiWeekInDayDropTarget(clientX, clientY);
			if (multiWeekInDayTarget) {
				const duration = this.resolveIndexedTaskDurationMinutes(task, preset.slotMinutes);
				const rawStart = (task.fieldValues['datetimeStart'] ?? '').trim();
				const startMinute = rawStart
					? this.extractMinuteOfDay(rawStart)
					: this.getSettings().calendarDefaultScrollHour * 60;
				const timedSelection = buildTimedSlotSelection(
					multiWeekInDayTarget.dateKey,
					startMinute,
					Math.min(24 * 60, startMinute + duration),
					CALENDAR_TIMED_SNAP_MINUTES,
				);
				dragState.dropTarget = 'timed';
				dragState.timedSelection = timedSelection;
				return;
			}
		};

		row.addEventListener('pointerdown', event => {
			if (event.button !== 0) return;
			const target = asHTMLElement(event.target, row);
			if (target?.closest('.operon-calendar-sidebar-task-pool-status')) return;
			this.hideCalendarHoverMenu(true);
			dragState = {
				pointerId: event.pointerId,
				initialClientX: event.clientX,
				initialClientY: event.clientY,
				activated: false,
				dropTarget: 'none',
				timedSelection: null,
				allDaySelection: null,
				timedPreviewEl: null,
				allDayPreviewEl: null,
				dragGhostEl: null,
			};
			this.beginCalendarDragSession(row, event.pointerId, finishDrag);
			row.setPointerCapture?.(event.pointerId);
		});

		row.addEventListener('pointermove', event => {
			if (!dragState || dragState.pointerId !== event.pointerId) return;
			updateFromPointer(event.clientX, event.clientY);
		});

		const finishDrag = (reason: CalendarDragEndReason, event: PointerEvent | null): void => {
			if (!dragState) return;
			const pointerId = dragState.pointerId;
			if (event && pointerId !== event.pointerId) return;
			if (event) {
				updateFromPointer(event.clientX, event.clientY);
			}
			const wasActivated = dragState.activated;
			const dropTarget = dragState.dropTarget;
			const timedSelection = dragState.timedSelection;
			const allDaySelection = dragState.allDaySelection;
			this.releaseCalendarPointerCapture(row, pointerId);
			row.removeClass('is-dragging');
			clearDragArtifacts();
			dragState = null;
			if (reason !== 'commit') return;
			if (!wasActivated) {
				void this.callbacks.onItemAction?.(task.operonId, 'openEditor');
				return;
			}
			if (dropTarget === 'timed' && timedSelection) {
				const writebackPlan = buildTimedCalendarWritebackPlanForExistingCalendarAssignment(timedSelection, task.fieldValues);
				this.invokeCalendarDropCallback(
					task.operonId,
					writebackPlan.payload,
					() => this.callbacks.onSidebarTaskDropToTimed?.(task.operonId, timedSelection),
				);
				return;
			}
			if (dropTarget === 'allDay' && allDaySelection) {
				this.invokeCalendarDropCallback(
					task.operonId,
					buildAllDayCalendarWritebackPlan(allDaySelection).payload,
					() => this.callbacks.onSidebarTaskDropToAllDay?.(task.operonId, allDaySelection),
				);
			}
		};

		row.addEventListener('pointerup', event => this.finishActiveCalendarDragSession('commit', event));
		row.addEventListener('pointercancel', event => this.finishActiveCalendarDragSession('cancel', event));
	}

	private resolveSidebarWidthPx(): number {
		const base = this.sidebarWidthOverridePx ?? this.getSettings().calendarSidebarWidthPx;
		return Math.max(240, Math.min(720, Math.round(base || 320)));
	}

	private bindSidebarResizeHandle(handle: HTMLElement, layout: HTMLElement): void {
		handle.addEventListener('pointerdown', (event: PointerEvent) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			this.clearSidebarResizeDrag();
			const updateWidth = (clientX: number): number => {
				const rect = layout.getBoundingClientRect();
				const nextWidth = Math.max(240, Math.min(720, Math.round(clientX - rect.left)));
				this.sidebarWidthOverridePx = nextWidth;
				layout.style.setProperty('--operon-calendar-sidebar-width', `${nextWidth}px`);
				return nextWidth;
			};
			let lastWidth = updateWidth(event.clientX);
			const ownerWindow = getOwnerWindow(layout);
			const ownerBody = getOwnerBody(layout);
			ownerBody.classList.add('operon-calendar-sidebar-is-resizing');
			const onPointerMove = (moveEvent: PointerEvent): void => {
				lastWidth = updateWidth(moveEvent.clientX);
			};
			const finalize = (doneEvent?: PointerEvent): void => {
				if (doneEvent) {
					lastWidth = updateWidth(doneEvent.clientX);
				}
				this.clearSidebarResizeDrag();
				const persistedWidth = Math.max(240, Math.min(720, Math.round(lastWidth)));
				this.sidebarWidthOverridePx = null;
				void this.callbacks.onSidebarWidthChange?.(persistedWidth);
			};
			const onPointerUp = (upEvent: PointerEvent): void => finalize(upEvent);
			const onPointerCancel = (): void => finalize();
			ownerWindow.addEventListener('pointermove', onPointerMove);
			ownerWindow.addEventListener('pointerup', onPointerUp, { once: true });
			ownerWindow.addEventListener('pointercancel', onPointerCancel, { once: true });
			this.sidebarResizeCleanup = () => {
				ownerWindow.removeEventListener('pointermove', onPointerMove);
				ownerWindow.removeEventListener('pointerup', onPointerUp);
				ownerWindow.removeEventListener('pointercancel', onPointerCancel);
				ownerBody.classList.remove('operon-calendar-sidebar-is-resizing');
				this.sidebarResizeCleanup = null;
			};
		});
	}

	private clearSidebarResizeDrag(): void {
		this.sidebarResizeCleanup?.();
	}

	private renderToolbar(
		container: HTMLElement,
		state: CalendarLeafState,
		preset: CalendarPreset,
		visibleDates: string[],
	): void {
		const toolbar = container.createDiv('operon-calendar-toolbar');
		const titleGroup = toolbar.createDiv('operon-calendar-toolbar-start');
		const navGroup = toolbar.createDiv('operon-calendar-toolbar-center');
		const controlsGroup = toolbar.createDiv('operon-calendar-toolbar-end');

		this.createToolbarIconButton(
			titleGroup,
			['panel-left'],
			() => {
				void this.updateLeafState({
					...state,
					navigationMode: 'sidebar',
				});
			},
				t('calendar', 'toggleToSidebar'),
				t('calendar', 'toggleToSidebar'),
				'operon-calendar-toolbar-toggle-button',
			);

		const titleBlock = titleGroup.createDiv('operon-calendar-toolbar-title');
		bindOperonHoverTooltip(titleBlock, { content: this.formatRangeLabel(visibleDates), taskColor: null });
			titleBlock.createDiv({
				text: t('calendar', 'title'),
				cls: 'operon-calendar-toolbar-title-main',
			});

		const presetSpanDays = preset.surfaceType === 'multiWeek'
			? Math.max(7, Math.max(1, preset.weekCount || 2) * 7)
			: Math.max(1, preset.dayCount);
			this.createToolbarIconButton(navGroup, ['step-back', 'step-back'], () => {
				void this.shiftCalendarAnchorByDays(-presetSpanDays);
			}, t('calendar', 'previousSpan'), t('calendar', 'previousSpanTooltip'));
			this.createToolbarIconButton(navGroup, ['step-back'], () => {
				void this.shiftCalendarAnchorByDays(-1);
			}, t('calendar', 'previousDay'), t('calendar', 'previousDayTooltip'));
		this.createToolbarButton(navGroup, this.formatFocusedDateButtonLabel(state.anchorDate), () => {
			void this.handleTodayButtonClick(state, preset);
		});
			this.createToolbarIconButton(navGroup, ['step-forward'], () => {
				void this.shiftCalendarAnchorByDays(1);
			}, t('calendar', 'nextDay'), t('calendar', 'nextDayTooltip'));
			this.createToolbarIconButton(navGroup, ['step-forward', 'step-forward'], () => {
				void this.shiftCalendarAnchorByDays(presetSpanDays);
			}, t('calendar', 'nextSpan'), t('calendar', 'nextSpanTooltip'));

		const presetSelect = controlsGroup.createEl('select', { cls: 'operon-calendar-preset-select' });
		for (const entry of this.getSettings().calendarPresets) {
			const option = presetSelect.createEl('option', { text: entry.name });
			option.value = entry.id;
			option.selected = entry.id === preset.id;
		}
		presetSelect.addEventListener('change', () => {
			void this.updateLeafState({
				...state,
				presetId: presetSelect.value,
			});
		});
		this.renderCalendarQuickActions(controlsGroup, preset, 'toolbar');

		this.applyToolbarLayoutMode(toolbar, titleGroup, navGroup, controlsGroup);
	}

	private applyToolbarLayoutMode(
		toolbar: HTMLElement,
		titleGroup: HTMLElement,
		navGroup: HTMLElement,
		controlsGroup: HTMLElement,
	): void {
		const updateLayout = (): void => {
			const width = toolbar.clientWidth;
			if (width <= 0) return;
			const requiredWidth = this.measureToolbarGroupWidth(titleGroup)
				+ this.measureToolbarGroupWidth(navGroup)
				+ this.measureToolbarGroupWidth(controlsGroup)
				+ 20;
			toolbar.classList.toggle('is-compact', requiredWidth > width);
		};

		this.toolbarLayoutCleanup?.();
		this.toolbarLayoutCleanup = null;

		updateLayout();
		const generation = this.renderGeneration;
		this.requestRenderAnimationFrame(generation, updateLayout);
		this.requestRenderAnimationFrame(generation, () => this.requestRenderAnimationFrame(generation, updateLayout));
		this.setRenderTimeout(generation, updateLayout, 0);
		this.setRenderTimeout(generation, updateLayout, 120);

		const observer = new ResizeObserver(() => updateLayout());
		observer.observe(toolbar);
		observer.observe(titleGroup);
		observer.observe(navGroup);
		observer.observe(controlsGroup);
		this.toolbarLayoutCleanup = () => observer.disconnect();
	}

	private measureToolbarGroupWidth(group: HTMLElement): number {
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

	private createToolbarIconButton(
		container: HTMLElement,
		icons: string[],
		onClick: () => void,
		ariaLabel: string,
		title?: string,
		extraClass?: string,
	): HTMLButtonElement {
			const button = container.createEl('button', {
				cls: `operon-calendar-toolbar-button is-icon-only${extraClass ? ` ${extraClass}` : ''}`,
				attr: {
					type: 'button',
				},
			});
		for (const iconName of icons) {
			const iconWrap = button.createSpan({ cls: 'operon-calendar-toolbar-icon' });
				setIcon(iconWrap, iconName);
			}
			setAccessibleLabelWithoutTooltip(button, ariaLabel);
			if (title) bindOperonHoverTooltip(button, { content: title, taskColor: null });
		button.addEventListener('click', onClick);
		return button;
	}

	private renderDayHeaders(
		container: HTMLElement,
		visibleDates: string[],
		showAllDayLane: boolean,
		showDueMarkers: boolean,
	): void {
		const headerRow = container.createDiv('operon-calendar-day-header-row');
		const gutterSpacer = headerRow.createDiv('operon-calendar-gutter-spacer');
		if (!showAllDayLane || !showDueMarkers) {
			const hiddenStack = gutterSpacer.createDiv('operon-calendar-hidden-lane-toggle-stack');
			if (!showAllDayLane) {
				this.renderLaneToggleButton(hiddenStack, t('calendar', 'allDay'), false, () => {
					void this.updateLeafState({
						...this.ensureState(),
						showAllDayLane: true,
					});
				}, true);
			}
			if (!showDueMarkers) {
				this.renderLaneToggleButton(hiddenStack, t('calendar', 'due'), false, () => {
					void this.updateLeafState({
						...this.ensureState(),
						showDueMarkers: true,
					});
				}, true);
			}
		}

		const daysGrid = headerRow.createDiv('operon-calendar-day-header-grid');
		daysGrid.style.gridTemplateColumns = `repeat(${Math.max(1, visibleDates.length)}, minmax(0, 1fr))`;

		for (const dateKey of visibleDates) {
			const cell = daysGrid.createDiv('operon-calendar-day-header-cell');
			const dayDate = this.parseDateKey(dateKey);
			cell.classList.toggle('is-weekend', dayDate?.getDay() === 0 || dayDate?.getDay() === 6);
			if (dateKey === localToday()) {
				cell.addClass('is-today');
			}
			cell.addClass('is-clickable');
			cell.tabIndex = 0;
			cell.addEventListener('click', () => {
				void this.callbacks.onOpenDailyNote?.(dateKey);
			});
			cell.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				void this.callbacks.onOpenDailyNote?.(dateKey);
			});
			const topLine = cell.createDiv('operon-calendar-day-header-topline');
			topLine.createDiv({
				text: this.formatWeekdayLabel(dateKey),
				cls: 'operon-calendar-day-header-weekday',
			});
			this.renderWeekLabelForDayHeader(topLine, dateKey);
			cell.createDiv({
				text: this.formatDayLabel(dateKey),
				cls: 'operon-calendar-day-header-date',
			});
		}
	}

	private renderLaneToggleButton(
		container: HTMLElement,
		label: string,
		isVisible: boolean,
		onClick: () => void,
		compact = false,
	): HTMLButtonElement {
		const button = container.createEl('button', {
			text: label,
			cls: 'operon-calendar-lane-toggle-button',
			attr: { type: 'button' },
		});
		button.classList.toggle('is-compact', compact);
		button.classList.toggle('is-on', isVisible);
		button.classList.toggle('is-off', !isVisible);
		button.addEventListener('click', onClick);
		return button;
	}

	private renderAllDaySection(
		container: HTMLElement,
		visibleDates: string[],
		scheduledItems: CalendarItem[],
		dueItems: CalendarItem[],
		finishedItems: CalendarItem[],
		preset: CalendarPreset,
		settings: OperonSettings,
		showAllDayLane: boolean,
		showDueMarkers: boolean,
		showFinishedLane: boolean,
		dropContextMode: 'timeGrid' | 'multiWeek' = 'timeGrid',
	): void {
		const section = container.createDiv('operon-calendar-all-day-section');
		if (showAllDayLane) {
			this.renderAllDayTrack(section, t('calendar', 'allDay'), 'allDay', visibleDates, scheduledItems, false, preset, settings, dropContextMode);
		}
		if (showDueMarkers) {
			this.renderAllDayTrack(section, t('calendar', 'due'), 'due', visibleDates, dueItems, true, preset, settings, dropContextMode);
		}
		if (showFinishedLane) {
			this.renderAllDayTrack(section, t('calendar', 'finished'), 'finished', visibleDates, finishedItems, true, preset, settings, dropContextMode);
		}
	}

	private renderAllDayTrack(
		container: HTMLElement,
		label: string,
		trackKind: 'allDay' | 'due' | 'finished',
		visibleDates: string[],
		items: CalendarItem[],
		isDueTrack: boolean,
		preset: CalendarPreset,
		settings: OperonSettings,
		dropContextMode: 'timeGrid' | 'multiWeek' = 'timeGrid',
	): void {
		const placements = this.buildAllDayPlacements(items, visibleDates);
		const row = container.createDiv('operon-calendar-all-day-row');
		const labelEl = row.createDiv('operon-calendar-row-label');
		this.renderLaneToggleButton(labelEl, label, true, () => {
			if (trackKind === 'due') {
				void this.updateLeafState({
					...this.ensureState(),
					showDueMarkers: false,
				});
				return;
			}
			if (trackKind === 'finished') {
				void this.updateLeafState({
					...this.ensureState(),
					showFinishedLane: false,
				});
				return;
			}
			void this.updateLeafState({
				...this.ensureState(),
				showAllDayLane: false,
			});
		});

		const body = row.createDiv('operon-calendar-all-day-body');
		const laneHeight = 31;
		const usedLaneCount = Math.max(0, placements[0]?.laneCount ?? 0);
		const totalLaneCount = Math.max(1, usedLaneCount);
		body.style.height = `${totalLaneCount * laneHeight}px`;

		const grid = body.createDiv('operon-calendar-all-day-grid');
		grid.style.gridTemplateColumns = `repeat(${Math.max(1, visibleDates.length)}, minmax(0, 1fr))`;
		for (const dateKey of visibleDates) {
			const cell = grid.createDiv('operon-calendar-all-day-cell');
			const dayDate = this.parseDateKey(dateKey);
			cell.classList.toggle('is-weekend', dayDate?.getDay() === 0 || dayDate?.getDay() === 6);
			if (dateKey === localToday()) {
				cell.addClass('is-today');
			}
			if (!isDueTrack) {
				this.bindCalendarCellQuickAdd(cell, dateKey, () => {
					void this.callbacks.onAllDaySlotSelection?.(buildAllDaySlotSelection(dateKey, dateKey));
				});
			}
		}

		const overlay = body.createDiv('operon-calendar-all-day-overlay');
		if (!isDueTrack) {
			const dropContext = {
				body,
				overlay,
				visibleDates: [...visibleDates],
				laneHeight,
				previewLane: totalLaneCount - 1,
			};
			if (dropContextMode === 'multiWeek') {
				this.multiWeekAllDayDropContexts.push(dropContext);
			} else {
				this.allDayDropContext = dropContext;
			}
		}
				for (const placement of placements) {
					const itemEl = overlay.createDiv('operon-calendar-all-day-item');
					itemEl.dataset.operonId = placement.item.taskId;
					itemEl.addClass(`is-${placement.item.kind}`);
					itemEl.addClass(`is-${placement.item.renderSnapshot.checkbox}`);
				if (placement.item.isDashed || placement.item.origin === 'projected') itemEl.addClass('is-dashed');
				if (placement.item.origin === 'projected') itemEl.addClass('is-projected');
				if (placement.item.origin === 'external') itemEl.addClass('is-external');
				this.applyAllDayPlacementStyle(itemEl, placement.startColumn, placement.endColumn, placement.lane, laneHeight, visibleDates.length);
				this.applyCalendarItemColor(itemEl, placement.item, preset, settings);
				const hoverTrigger = this.renderCalendarItemLabel(itemEl, placement.item, settings, true);
				if (hoverTrigger) {
					this.bindHoverMenuTarget(hoverTrigger, placement.item);
				}
				if (!isDueTrack) {
					if (placement.item.origin === 'external') {
						itemEl.addClass('is-read-only');
						this.bindPrimaryItemClick(itemEl, placement.item);
					} else {
						itemEl.addClass('is-draggable');
						itemEl.createDiv('operon-calendar-all-day-resize-handle');
						this.bindScheduledAllDayItemInteraction(
							itemEl,
							body,
							overlay,
							placement,
							visibleDates,
							laneHeight,
							dropContextMode,
						);
					}
				} else {
					itemEl.addClass('is-read-only');
					this.bindPrimaryItemClick(itemEl, placement.item);
				}
			}
	}

	private renderTimedSection(
		container: HTMLElement,
		renderWindow: TimedHorizontalRenderWindow,
		items: CalendarItem[],
		preset: CalendarPreset,
		settings: OperonSettings,
	): void {
		const visibleDates = renderWindow.bufferedDates;
		const viewport = container.createDiv('operon-calendar-timed-viewport');
		this.timedScrollEl = viewport;
		const hiddenTimeKey = `${preset.id}|${this.ensureState().anchorDate}`;
		const metrics = this.buildTimedMetrics(preset, this.expandedHiddenTimeKey === hiddenTimeKey);
		viewport.addEventListener('scroll', () => {
			this.hideCalendarHoverMenu(true);
			if (!this.state) return;
			this.state = {
				...this.ensureState(),
				scrollMinutes: this.gridOffsetToMinute(Math.max(0, Math.round(viewport.scrollTop)), metrics),
			};
			this.scheduleLeafStatePersistence();
		});
		viewport.addEventListener('wheel', (event: WheelEvent) => {
			this.handleTimedHorizontalWheel(event);
		}, { passive: false });

		const section = viewport.createDiv('operon-calendar-timed-section');
		const gutter = section.createDiv('operon-calendar-time-gutter');
		gutter.style.height = `${metrics.gridHeight}px`;
		const clip = section.createDiv('operon-calendar-timed-clip');
		const strip = clip.createDiv('operon-calendar-timed-strip');
		strip.style.width = `${(visibleDates.length / Math.max(1, renderWindow.visibleDates.length)) * 100}%`;
		const daysGrid = strip.createDiv('operon-calendar-timed-grid');
		daysGrid.style.gridTemplateColumns = `repeat(${Math.max(1, visibleDates.length)}, minmax(0, 1fr))`;
		daysGrid.style.height = `${metrics.gridHeight}px`;
		const hoverGuideOverlay = section.createDiv('operon-calendar-hover-guide-overlay');
		const itemOverlay = daysGrid.createDiv('operon-calendar-timed-overlay');
		itemOverlay.style.height = `${metrics.gridHeight}px`;
		this.timedHorizontalClipEl = clip;
		this.timedHorizontalStripEl = strip;
		this.timedDropContext = {
			section,
			gutter,
			daysGrid,
			hoverGuideOverlay,
			visibleDates: [...visibleDates],
			metrics,
			preset,
			settings,
		};

		for (let hour = 0; hour <= 24; hour++) {
			if (hour < 24 && this.isHiddenMinute(hour * 60, metrics.hiddenRange) && !metrics.isHiddenExpanded) {
				continue;
			}
			const label = gutter.createDiv('operon-calendar-time-label');
			if (hour === 0) label.addClass('is-first');
			if (hour === 24) label.addClass('is-last');
			const offset = this.minuteToGridOffset(hour * 60, metrics);
			label.style.top = `${hour === 24 ? Math.max(0, metrics.gridHeight - 1) : offset}px`;
			label.createSpan({
				text: hour === 24 ? '23:59' : `${String(hour).padStart(2, '0')}:00`,
			});
		}

		if (metrics.hiddenRange.enabled && !metrics.isHiddenExpanded) {
			const bandTop = this.minuteToGridOffset(metrics.hiddenRange.startMinutes, metrics);
			const band = strip.createDiv('operon-calendar-hidden-time-band');
			band.style.top = `${bandTop}px`;
			band.style.height = `${metrics.collapsedBandHeight}px`;
			const button = band.createEl('button', {
				text: t('calendar', 'showHiddenTime'),
				cls: 'operon-calendar-hidden-time-button',
				attr: { type: 'button' },
			});
			button.addEventListener('click', () => {
				this.expandedHiddenTimeKey = hiddenTimeKey;
				this.render();
			});
		}
		this.syncTimedHorizontalPanMetrics();
		this.applyTimedHorizontalPanTransform(false);

		const placements = this.buildTimedGridVisualPlacements(items, visibleDates);
		for (let dayIndex = 0; dayIndex < visibleDates.length; dayIndex++) {
			const column = daysGrid.createDiv('operon-calendar-timed-day');
			const dayDate = this.parseDateKey(visibleDates[dayIndex]);
			column.classList.toggle('is-weekend', dayDate?.getDay() === 0 || dayDate?.getDay() === 6);
			if (visibleDates[dayIndex] === localToday()) {
				column.addClass('is-today');
				this.attachNowIndicator(column, metrics);
			}

			for (let hour = 0; hour <= 24; hour++) {
				if (hour < 24 && this.isHiddenMinute(hour * 60, metrics.hiddenRange) && !metrics.isHiddenExpanded) {
					continue;
				}
				const line = column.createDiv('operon-calendar-hour-line');
				const offset = this.minuteToGridOffset(hour * 60, metrics);
				line.style.top = `${hour === 24 ? Math.max(0, metrics.gridHeight - 1) : offset}px`;
			}

			this.bindTimedSelection(column, visibleDates[dayIndex], preset, metrics, section, gutter, hoverGuideOverlay, settings);
		}

			for (const segment of placements) {
				const block = itemOverlay.createDiv('operon-calendar-timed-item');
				block.dataset.operonId = segment.item.taskId;
				block.addClass(`is-${segment.item.renderSnapshot.checkbox}`);
			if (segment.item.origin === 'projected') block.addClass('is-projected', 'is-dashed');
			if (segment.item.origin === 'external') block.addClass('is-external');
			if (segment.visualOverlapGroupSize > 1) block.addClass('has-overlap');
			if (segment.visualStackIndex > 1) block.addClass('is-overlap-layer');
			if (segment.visualInsetLevel > 0) block.addClass('is-indented-overlap');
			if (segment.visualHoverRaiseEligible) block.addClass('can-hover-raise');
			this.applyTimedPlacementStyle(
				block,
				segment.dayIndex,
				segment.lane,
				segment.laneCount,
				segment.startMinutes,
				segment.endMinutes,
				visibleDates.length,
				metrics,
				segment,
			);
			this.applyCalendarItemColor(block, segment.item, preset, settings);

			const content = block.createDiv('operon-calendar-timed-content');
			const hoverTrigger = this.renderCalendarItemLabel(content, segment.item, settings, true);
			block.createDiv('operon-calendar-timed-drag-label');
			this.bindTimedHoverGuides(
				block,
				hoverGuideOverlay,
				section,
				gutter,
				visibleDates[segment.dayIndex] ?? '',
				segment.startMinutes,
				segment.endMinutes,
				metrics,
				settings,
			);
			this.bindPrimaryItemClick(block, segment.item);
			if (hoverTrigger) {
				this.bindHoverMenuTarget(hoverTrigger, segment.item);
			}
			if (segment.item.origin !== 'external' && segment.item.startDate === segment.item.endDate) {
				block.addClass('is-draggable');
				block.createDiv('operon-calendar-timed-resize-handle is-start');
				block.createDiv('operon-calendar-timed-resize-handle is-end');
				this.bindTimedItemInteraction(block, daysGrid, segment, visibleDates, metrics, settings, section, gutter, hoverGuideOverlay);
			} else {
				block.addClass('is-read-only');
			}
		}
		this.updateNowIndicators();
		if (this.nowIndicatorEntries.length > 0) {
			this.nowIndicatorTimer = window.setInterval(() => this.updateNowIndicators(), 30000);
		}
	}

	private bindTimedSelection(
		column: HTMLElement,
		dateKey: string,
		preset: CalendarPreset,
		metrics: CalendarTimedMetrics,
		section: HTMLElement,
		gutter: HTMLElement,
		hoverGuideOverlay: HTMLElement,
		settings: OperonSettings,
	): void {
		let dragState: {
			pointerId: number;
			anchorMinute: number;
			currentMinute: number;
			selectionEl: HTMLElement;
		} | null = null;

		const clearDragState = (): void => {
			if (!dragState) return;
			dragState.selectionEl.remove();
			hoverGuideOverlay.empty();
			dragState = null;
			column.removeClass('is-selecting');
		};

		const renderSelectionGuides = (startMinutes: number, endMinutes: number): void => {
			this.renderTimedSelectionGuides(
				section,
				gutter,
				column,
				hoverGuideOverlay,
				dateKey,
				startMinutes,
				endMinutes,
				metrics,
				'var(--interactive-accent)',
				settings,
			);
		};

		const renderSelection = (): CalendarSlotSelection | null => {
			if (!dragState) return null;
			const selection = buildTimedSlotSelection(
				dateKey,
				dragState.anchorMinute,
				dragState.currentMinute,
				preset.slotMinutes,
			);
			const startMinutes = this.extractMinuteOfDay(selection.start);
			const endMinutes = this.extractMinuteOfDay(selection.end);
			const top = this.minuteToGridOffset(startMinutes, metrics);
			const height = Math.max(1, this.minuteToGridOffset(endMinutes, metrics) - top);
			dragState.selectionEl.style.top = `${Math.max(0, top)}px`;
			dragState.selectionEl.style.height = `${height}px`;
			renderSelectionGuides(startMinutes, endMinutes);
			return selection;
		};

		const updateCurrentMinute = (clientY: number): CalendarSlotSelection | null => {
			if (!dragState) return null;
			dragState.currentMinute = this.resolveTimedMinuteOffset(column, clientY, metrics);
			return renderSelection();
		};

		column.addEventListener('pointerdown', (event: PointerEvent) => {
			if (event.button !== 0) return;
			const target = asHTMLElement(event.target, column);
			if (target?.closest('.operon-calendar-timed-item')) return;

			event.preventDefault();
			column.addClass('is-selecting');
			const anchorMinute = this.resolveTimedMinuteOffset(column, event.clientY, metrics);
			const selectionEl = column.createDiv('operon-calendar-timed-selection');
			dragState = {
				pointerId: event.pointerId,
				anchorMinute,
				currentMinute: anchorMinute,
				selectionEl,
			};
			this.beginCalendarDragSession(column, event.pointerId, finishDrag);
			column.setPointerCapture?.(event.pointerId);
			renderSelection();
		});

		column.addEventListener('pointermove', (event: PointerEvent) => {
			if (!dragState || dragState.pointerId !== event.pointerId) return;
			updateCurrentMinute(event.clientY);
		});

		const finishDrag = (reason: CalendarDragEndReason, event: PointerEvent | null): void => {
			if (!dragState) return;
			const pointerId = dragState.pointerId;
			if (event && pointerId !== event.pointerId) return;
			const selection = event ? updateCurrentMinute(event.clientY) : null;
			this.releaseCalendarPointerCapture(column, pointerId);
			clearDragState();
			if (reason !== 'commit' || !selection || !this.callbacks.onTimedSlotSelection) return;
			void this.callbacks.onTimedSlotSelection(selection);
		};

		column.addEventListener('pointerup', (event: PointerEvent) => this.finishActiveCalendarDragSession('commit', event));
		column.addEventListener('pointercancel', (event: PointerEvent) => this.finishActiveCalendarDragSession('cancel', event));
	}

	private bindTimedItemInteraction(
		block: HTMLElement,
		daysGrid: HTMLElement,
		segment: TimedGridVisualPlacement,
		visibleDates: string[],
		metrics: CalendarTimedMetrics,
		settings: OperonSettings,
		section: HTMLElement,
		gutter: HTMLElement,
		hoverGuideOverlay: HTMLElement,
	): void {
		let dragState: {
			pointerId: number;
			mode: 'move' | 'resize-start' | 'resize-end';
			anchorOffsetMinutes: number;
			currentDayIndex: number;
			currentStartMinutes: number;
			currentEndMinutes: number;
			dropTarget: 'timed' | 'allDay';
			allDayDate: string | null;
			allDayPreviewEl: HTMLElement | null;
		} | null = null;
		const dragLabel = block.querySelector<HTMLElement>('.operon-calendar-timed-drag-label');

		const renderEditGuides = (dayIndex: number, startMinutes: number, endMinutes: number): void => {
			const dateKey = visibleDates[dayIndex] ?? visibleDates[segment.dayIndex] ?? '';
			const sectionRect = section.getBoundingClientRect();
			const gutterRect = gutter.getBoundingClientRect();
			const gridRect = daysGrid.getBoundingClientRect();
			const left = Math.max(0, gutterRect.right - sectionRect.left);
			const dayWidth = gridRect.width / Math.max(1, visibleDates.length);
			const blockLeft = (gridRect.left - sectionRect.left) + (dayIndex * dayWidth);
			const right = Math.max(left, blockLeft);
			const width = Math.max(0, right - left);
			const accent = this.resolveCalendarHoverGuideAccent(block);

			hoverGuideOverlay.empty();
			const createGuide = (minuteOfDay: number, labelSide: 'start' | 'end'): void => {
				const guide = hoverGuideOverlay.createDiv('operon-calendar-hover-guide');
				const top = (gridRect.top - sectionRect.top) + this.minuteToGridOffset(minuteOfDay, metrics);
				const currentBlockRect = block.getBoundingClientRect();
				const labelCenter = Math.max(0, (currentBlockRect.left - sectionRect.left) + (currentBlockRect.width / 2) - left);
				guide.style.top = `${Math.max(0, top)}px`;
				guide.style.left = `${left}px`;
				guide.style.width = `${width}px`;
				guide.style.setProperty('--operon-calendar-guide-color', accent);
				const labelEl = guide.createSpan({
					text: this.formatTimedGuideLabel(dateKey, minuteOfDay, settings),
					cls: `operon-calendar-hover-guide-label is-${labelSide}`,
				});
				labelEl.style.left = `${labelCenter}px`;
			};

			createGuide(startMinutes, 'start');
			createGuide(endMinutes, 'end');
		};

		const renderPlacement = (): void => {
			const nextDayIndex = dragState?.currentDayIndex ?? segment.dayIndex;
			const nextStart = dragState?.currentStartMinutes ?? segment.startMinutes;
			const nextEnd = dragState?.currentEndMinutes ?? segment.endMinutes;
				this.applyTimedPlacementStyle(
					block,
					nextDayIndex,
					segment.lane,
					segment.laneCount,
					nextStart,
					nextEnd,
					visibleDates.length,
					metrics,
					segment,
				);
			if (dragLabel) {
				const dateKey = visibleDates[nextDayIndex] ?? visibleDates[segment.dayIndex] ?? '';
				dragLabel.setText(this.formatTimedDragLabel(dateKey, nextStart, nextEnd, settings));
			}
			if (dragState) {
				renderEditGuides(nextDayIndex, nextStart, nextEnd);
			}
		};

		const buildSelection = (): CalendarSlotSelection | null => {
			if (!dragState) return null;
			if (dragState.dropTarget === 'allDay' && dragState.allDayDate) {
				return buildAllDaySlotSelection(dragState.allDayDate, dragState.allDayDate);
			}
			const dateKey = visibleDates[dragState.currentDayIndex];
			if (!dateKey) return null;
			return buildTimedSlotSelection(
				dateKey,
				dragState.currentStartMinutes,
				dragState.currentEndMinutes,
				CALENDAR_TIMED_SNAP_MINUTES,
			);
		};

		const resolveGridPosition = (clientX: number, clientY: number): { dayIndex: number; minuteOfDay: number } => {
			const rect = daysGrid.getBoundingClientRect();
			const width = Math.max(1, rect.width);
			const relativeX = Math.max(0, Math.min(width - 1, clientX - rect.left));
			const relativeY = Math.max(0, Math.min(metrics.gridHeight, clientY - rect.top));
			const minuteOfDay = this.gridOffsetToMinute(relativeY, metrics);
			return {
				dayIndex: Math.max(0, Math.min(
					visibleDates.length - 1,
					Math.floor((relativeX / width) * visibleDates.length),
				)),
				minuteOfDay: Math.max(0, Math.min(24 * 60, minuteOfDay)),
			};
		};

		const updateFromPointer = (clientX: number, clientY: number): void => {
			if (!dragState) return;
			if (dragState.mode === 'move' && this.allDayDropContext) {
				const allDayRect = this.allDayDropContext.body.getBoundingClientRect();
				const insideAllDay = clientX >= allDayRect.left
					&& clientX <= allDayRect.right
					&& clientY >= allDayRect.top
					&& clientY <= allDayRect.bottom;
				if (insideAllDay) {
					const nextColumn = this.resolveAllDayColumnIndex(this.allDayDropContext.body, clientX, this.allDayDropContext.visibleDates.length);
					const nextDate = this.allDayDropContext.visibleDates[nextColumn] ?? null;
					dragState.dropTarget = 'allDay';
					dragState.allDayDate = nextDate;
						block.addClass('operon-calendar-drag-source-hidden');
					hoverGuideOverlay.empty();
					if (!dragState.allDayPreviewEl) {
						dragState.allDayPreviewEl = this.allDayDropContext.overlay.createDiv('operon-calendar-all-day-transfer-preview');
					}
					if (nextDate) {
						this.applyAllDayPlacementStyle(
							dragState.allDayPreviewEl,
							nextColumn,
							nextColumn,
							this.allDayDropContext.previewLane,
							this.allDayDropContext.laneHeight,
							this.allDayDropContext.visibleDates.length,
						);
					}
					return;
				}
			}
			dragState.dropTarget = 'timed';
			dragState.allDayDate = null;
			if (dragState.allDayPreviewEl) {
				dragState.allDayPreviewEl.remove();
				dragState.allDayPreviewEl = null;
			}
				block.removeClass('operon-calendar-drag-source-hidden');
			const position = resolveGridPosition(clientX, clientY);
			const duration = Math.max(CALENDAR_TIMED_SNAP_MINUTES, segment.endMinutes - segment.startMinutes);

			if (dragState.mode === 'move') {
				let nextStart = position.minuteOfDay - dragState.anchorOffsetMinutes;
				nextStart = Math.round(nextStart / CALENDAR_TIMED_SNAP_MINUTES) * CALENDAR_TIMED_SNAP_MINUTES;
				nextStart = Math.max(0, Math.min(24 * 60 - duration, nextStart));
				dragState.currentDayIndex = position.dayIndex;
				dragState.currentStartMinutes = nextStart;
				dragState.currentEndMinutes = Math.min(24 * 60, nextStart + duration);
			} else if (dragState.mode === 'resize-start') {
				let nextStart = Math.round(position.minuteOfDay / CALENDAR_TIMED_SNAP_MINUTES) * CALENDAR_TIMED_SNAP_MINUTES;
				nextStart = Math.max(0, Math.min(dragState.currentEndMinutes - CALENDAR_TIMED_SNAP_MINUTES, nextStart));
				dragState.currentStartMinutes = nextStart;
			} else {
				let nextEnd = Math.round(position.minuteOfDay / CALENDAR_TIMED_SNAP_MINUTES) * CALENDAR_TIMED_SNAP_MINUTES;
				nextEnd = Math.max(dragState.currentStartMinutes + CALENDAR_TIMED_SNAP_MINUTES, Math.min(24 * 60, nextEnd));
				dragState.currentEndMinutes = nextEnd;
			}
			renderPlacement();
		};

		const startDrag = (event: PointerEvent, mode: 'move' | 'resize-start' | 'resize-end'): void => {
			event.preventDefault();
			event.stopPropagation();
			this.hideCalendarHoverMenu(true);
			const position = resolveGridPosition(event.clientX, event.clientY);
			block.addClass('is-dragging');
			dragState = {
				pointerId: event.pointerId,
				mode,
				anchorOffsetMinutes: Math.max(0, position.minuteOfDay - segment.startMinutes),
				currentDayIndex: segment.dayIndex,
				currentStartMinutes: segment.startMinutes,
				currentEndMinutes: segment.endMinutes,
				dropTarget: 'timed',
				allDayDate: null,
				allDayPreviewEl: null,
			};
			this.beginCalendarDragSession(block, event.pointerId, finishDrag);
			block.setPointerCapture?.(event.pointerId);
			block.classList.add('is-live-editing');
			renderPlacement();
		};

		block.addEventListener('pointerdown', (event: PointerEvent) => {
			if (event.button !== 0) return;
			const target = asHTMLElement(event.target, block);
			if (target?.closest('.operon-calendar-item-action-button')) return;
			const mode = target?.closest('.operon-calendar-timed-resize-handle.is-start')
				? 'resize-start'
				: target?.closest('.operon-calendar-timed-resize-handle.is-end')
					? 'resize-end'
					: 'move';
			startDrag(event, mode);
		});

		block.addEventListener('pointermove', (event: PointerEvent) => {
			if (!dragState || dragState.pointerId !== event.pointerId) return;
			updateFromPointer(event.clientX, event.clientY);
		});

		const finishDrag = (reason: CalendarDragEndReason, event: PointerEvent | null): void => {
			if (!dragState) return;
			const pointerId = dragState.pointerId;
			if (event && pointerId !== event.pointerId) return;
			if (event) {
				updateFromPointer(event.clientX, event.clientY);
			}
			const selection = buildSelection();
			const changed = dragState.currentDayIndex !== segment.dayIndex
				|| dragState.currentStartMinutes !== segment.startMinutes
				|| dragState.currentEndMinutes !== segment.endMinutes
				|| dragState.dropTarget === 'allDay';
			const mode = dragState.mode;
			this.releaseCalendarPointerCapture(block, pointerId);
			block.removeClass('is-dragging');
			block.classList.remove('is-live-editing');
			block.removeClass('operon-calendar-drag-source-hidden');
			dragState.allDayPreviewEl?.remove();
			hoverGuideOverlay.empty();
			const dropTarget = dragState.dropTarget;
			dragState = null;
			if (reason !== 'commit' || !changed || !selection) {
				renderPlacement();
				return;
			}
			block.dataset.suppressCalendarClick = 'true';
			if (dropTarget === 'allDay') {
				this.invokeCalendarDropCallback(
					segment.item.taskId,
					buildAllDayCalendarWritebackPlan(selection).payload,
					() => this.callbacks.onTimedItemDropToAllDay?.(segment.item.taskId, selection),
				);
				return;
			}
			const writebackPlan = mode === 'move'
				? buildTimedCalendarWritebackPlanForExistingCalendarAssignment(
					selection,
					segment.item.renderSnapshot.fieldValues,
					{ preserveExistingDuration: true },
				)
				: buildTimedCalendarWritebackPlan(selection);
			if (mode !== 'move') writebackPlan.payload.dateStarted = '';
			if (mode === 'move') {
				this.invokeCalendarDropCallback(
					segment.item.taskId,
					writebackPlan.payload,
					() => this.callbacks.onTimedItemMove?.(segment.item.taskId, selection),
				);
				return;
			}
			if (mode === 'resize-start') {
				this.invokeCalendarDropCallback(
					segment.item.taskId,
					writebackPlan.payload,
					() => this.callbacks.onTimedItemResizeStart?.(segment.item.taskId, selection),
				);
				return;
			}
			this.invokeCalendarDropCallback(
				segment.item.taskId,
				writebackPlan.payload,
				() => this.callbacks.onTimedItemResizeEnd?.(segment.item.taskId, selection),
			);
		};

		block.addEventListener('pointerup', (event: PointerEvent) => this.finishActiveCalendarDragSession('commit', event));
		block.addEventListener('pointercancel', (event: PointerEvent) => this.finishActiveCalendarDragSession('cancel', event));
	}

	private bindMultiWeekInDayItemInteraction(
		itemEl: HTMLElement,
		placement: TimedSegmentPlacement,
		visibleDates: string[],
		_preset: CalendarPreset,
		_settings: OperonSettings,
	): void {
		const dragThresholdPx = 6;
		let dragState: {
			pointerId: number;
			activated: boolean;
			initialClientX: number;
			initialClientY: number;
			currentDayIndex: number;
			dropTarget: 'inDay' | 'allDay' | 'none';
			allDayDate: string | null;
			allDayPreviewEl: HTMLElement | null;
			inDayPreviewEl: HTMLElement | null;
			dragGhostEl: HTMLElement | null;
		} | null = null;

		const clearDropPreview = (): void => {
			dragState?.allDayPreviewEl?.remove();
			dragState?.inDayPreviewEl?.remove();
			if (dragState) {
				dragState.allDayPreviewEl = null;
				dragState.inDayPreviewEl = null;
			}
		};

		const clearDragArtifacts = (): void => {
			clearDropPreview();
			this.removeCalendarDragGhost(dragState?.dragGhostEl);
			if (dragState) {
				dragState.dragGhostEl = null;
			}
		};

		const updateDragGhostPosition = (clientX: number, clientY: number): void => {
			this.updateCalendarDragGhostPosition(dragState?.dragGhostEl ?? null, clientX, clientY);
		};

		const ensureDragGhost = (clientX: number, clientY: number): void => {
			if (!dragState || dragState.dragGhostEl) return;
			dragState.dragGhostEl = this.createCalendarDragGhost(itemEl, 'operon-calendar-multi-week-inday-drag-ghost');
			updateDragGhostPosition(clientX, clientY);
		};

		const renderInDayPreview = (context: CalendarMultiWeekInDayDropContext, dayIndex: number): void => {
			if (!dragState) return;
			const targetList = context.dayLists[dayIndex];
			if (!targetList) return;
			const preview = itemEl.cloneNode(true) as HTMLElement;
			preview.classList.remove('is-dragging', 'is-draggable', 'is-read-only', 'operon-calendar-drag-source-hidden');
			preview.classList.add('operon-calendar-multi-week-inday-transfer-preview');
			targetList.appendChild(preview);
			dragState.inDayPreviewEl = preview;
		};

		const buildSelection = (): CalendarSlotSelection | null => {
			if (!dragState) return null;
			if (dragState.dropTarget === 'allDay' && dragState.allDayDate) {
				return buildAllDaySlotSelection(dragState.allDayDate, dragState.allDayDate);
			}
			const dateKey = visibleDates[dragState.currentDayIndex];
			if (!dateKey) return null;
			return buildTimedSlotSelection(
				dateKey,
				placement.startMinutes,
				placement.endMinutes,
				CALENDAR_TIMED_SNAP_MINUTES,
			);
		};

		const hasReachedThreshold = (clientX: number, clientY: number): boolean => {
			if (!dragState) return false;
			return Math.hypot(clientX - dragState.initialClientX, clientY - dragState.initialClientY) >= dragThresholdPx;
		};

		const updateFromPointer = (clientX: number, clientY: number): void => {
			if (!dragState) return;
				if (!dragState.activated) {
					if (!hasReachedThreshold(clientX, clientY)) return;
					dragState.activated = true;
					itemEl.addClass('is-dragging');
					itemEl.addClass('operon-calendar-drag-source-hidden');
					ensureDragGhost(clientX, clientY);
				}
			updateDragGhostPosition(clientX, clientY);

			const allDayTarget = this.resolveMultiWeekAllDayDropTarget(clientX, clientY);
			if (allDayTarget) {
				dragState.dropTarget = 'allDay';
				dragState.allDayDate = allDayTarget.dateKey;
				if (!dragState.allDayPreviewEl) {
					dragState.allDayPreviewEl = allDayTarget.context.overlay.createDiv('operon-calendar-all-day-transfer-preview');
				}
				this.applyAllDayPlacementStyle(
					dragState.allDayPreviewEl,
					allDayTarget.column,
					allDayTarget.column,
					allDayTarget.context.previewLane,
					allDayTarget.context.laneHeight,
					allDayTarget.context.visibleDates.length,
				);
				return;
			}

			dragState.dropTarget = 'none';
			dragState.allDayDate = null;
			clearDropPreview();
			ensureDragGhost(clientX, clientY);

			const inDayTarget = this.resolveMultiWeekInDayDropTarget(clientX, clientY);
			if (!inDayTarget) return;
			dragState.dropTarget = 'inDay';
			dragState.currentDayIndex = inDayTarget.dayIndex;
			renderInDayPreview(inDayTarget.context, inDayTarget.dayIndex);
		};

		itemEl.addEventListener('pointerdown', (event: PointerEvent) => {
			if (event.button !== 0) return;
			const target = asHTMLElement(event.target, itemEl);
			if (target?.closest('.operon-calendar-item-action-button, .operon-calendar-status-button, .operon-calendar-multi-week-time-chip')) return;
			dragState = {
				pointerId: event.pointerId,
				activated: false,
				initialClientX: event.clientX,
				initialClientY: event.clientY,
				currentDayIndex: placement.dayIndex,
				dropTarget: 'none',
				allDayDate: null,
				allDayPreviewEl: null,
				inDayPreviewEl: null,
				dragGhostEl: null,
			};
			this.beginCalendarDragSession(itemEl, event.pointerId, finishDrag);
			itemEl.setPointerCapture?.(event.pointerId);
		});

		itemEl.addEventListener('pointermove', (event: PointerEvent) => {
			if (!dragState || dragState.pointerId !== event.pointerId) return;
			updateFromPointer(event.clientX, event.clientY);
		});

		const finishDrag = (reason: CalendarDragEndReason, event: PointerEvent | null): void => {
			if (!dragState) return;
			const pointerId = dragState.pointerId;
			if (event && pointerId !== event.pointerId) return;
			if (event) {
				updateFromPointer(event.clientX, event.clientY);
			}
			const selection = buildSelection();
			const changed = dragState.currentDayIndex !== placement.dayIndex || dragState.dropTarget === 'allDay';
			const dropTarget = dragState.dropTarget;
				this.releaseCalendarPointerCapture(itemEl, pointerId);
				itemEl.removeClass('is-dragging');
				itemEl.removeClass('operon-calendar-drag-source-hidden');
				clearDragArtifacts();
			dragState = null;
			if (reason !== 'commit' || !selection || !changed) return;
			itemEl.dataset.suppressCalendarClick = 'true';
			if (dropTarget === 'allDay') {
				this.invokeCalendarDropCallback(
					placement.item.taskId,
					buildAllDayCalendarWritebackPlan(selection).payload,
					() => this.callbacks.onTimedItemDropToAllDay?.(placement.item.taskId, selection),
				);
				return;
			}
			const writebackPlan = buildTimedCalendarWritebackPlanForExistingCalendarAssignment(
				selection,
				placement.item.renderSnapshot.fieldValues,
				{ preserveExistingDuration: true },
			);
			this.invokeCalendarDropCallback(
				placement.item.taskId,
				writebackPlan.payload,
				() => this.callbacks.onTimedItemMove?.(placement.item.taskId, selection),
			);
		};

		itemEl.addEventListener('pointerup', (event: PointerEvent) => this.finishActiveCalendarDragSession('commit', event));
		itemEl.addEventListener('pointercancel', (event: PointerEvent) => this.finishActiveCalendarDragSession('cancel', event));
	}

	private applyTimedPlacementStyle(
		element: HTMLElement,
		dayIndex: number,
		lane: number,
		laneCount: number,
		startMinutes: number,
		endMinutes: number,
		totalDays: number,
		metrics: CalendarTimedMetrics,
		visualLayout?: TimedGridVisualLayout,
	): void {
		const safeLaneCount = Math.max(1, laneCount);
		const leftRatio = visualLayout?.visualLeftRatio ?? (lane / safeLaneCount);
		const widthRatio = visualLayout?.visualWidthRatio ?? (1 / safeLaneCount);
		const top = this.minuteToGridOffset(startMinutes, metrics);
		const height = Math.max(1, this.minuteToGridOffset(endMinutes, metrics) - top);
		const slotHeight = Math.max(1, CALENDAR_TIMED_SNAP_MINUTES * metrics.scale);
		const visibleLineCount = Math.max(1, Math.floor(height / slotHeight));
		element.style.top = `${Math.max(0, top)}px`;
		element.style.height = `${height}px`;
		element.style.left = `${((dayIndex + leftRatio) / Math.max(1, totalDays)) * 100}%`;
		element.style.width = `${(widthRatio / Math.max(1, totalDays)) * 100}%`;
		if (visualLayout) {
			element.style.setProperty('--operon-calendar-stack-index', String(Math.max(1, visualLayout.visualStackIndex)));
		} else {
			element.style.removeProperty('--operon-calendar-stack-index');
		}
		element.style.setProperty('--operon-calendar-slot-height', `${slotHeight}px`);
		element.style.setProperty('--operon-calendar-visible-lines', String(visibleLineCount));
		element.classList.toggle('is-compact-height', height < 42);
		element.classList.toggle('is-micro-height', height < 30);
	}

	private bindScheduledAllDayItemInteraction(
		itemEl: HTMLElement,
		body: HTMLElement,
		_overlay: HTMLElement,
		placement: AllDayPlacement,
		visibleDates: string[],
		laneHeight: number,
		dropContextMode: 'timeGrid' | 'multiWeek' = 'timeGrid',
	): void {
		const dragThresholdPx = 6;
		let dragState: {
			pointerId: number;
			mode: 'move' | 'resize-right';
			activated: boolean;
			anchorColumn: number;
			anchorDate: string;
			initialClientX: number;
			initialClientY: number;
			currentStartColumn: number;
			currentEndColumn: number;
			currentStartDate: string;
			currentEndDate: string;
			dropTarget: 'allDay' | 'timed';
			timedSelection: CalendarSlotSelection | null;
			timedPreviewEl: HTMLElement | null;
			dragGhostEl: HTMLElement | null;
		} | null = null;

		const commitSelection = (): CalendarSlotSelection => {
			if (dragState?.dropTarget === 'timed' && dragState.timedSelection) {
				return dragState.timedSelection;
			}
			const startDate = dragState?.currentStartDate ?? placement.item.startDate;
			const endDate = dragState?.currentEndDate ?? placement.item.endDate;
			return buildAllDaySlotSelection(startDate, endDate);
		};

		const renderPlacement = (): void => {
			this.applyAllDayPlacementStyle(
				itemEl,
				dragState?.currentStartColumn ?? placement.startColumn,
				dragState?.currentEndColumn ?? placement.endColumn,
				placement.lane,
				laneHeight,
				visibleDates.length,
			);
		};

		const hasDragThresholdBeenReached = (clientX: number, clientY: number): boolean => {
			if (!dragState) return false;
			const deltaX = clientX - dragState.initialClientX;
			const deltaY = clientY - dragState.initialClientY;
			return Math.hypot(deltaX, deltaY) >= dragThresholdPx;
		};

		const updateFromClient = (clientX: number, clientY: number): void => {
			if (!dragState) return;
			if (!dragState.activated) {
				if (!hasDragThresholdBeenReached(clientX, clientY)) return;
				dragState.activated = true;
				itemEl.addClass('is-dragging');
					if (dragState.mode === 'move') {
						dragState.dragGhostEl = this.createCalendarDragGhost(itemEl, 'operon-calendar-all-day-drag-ghost');
						itemEl.addClass('operon-calendar-drag-source-hidden');
					}
			}
			if (dragState.mode === 'move') {
				this.updateCalendarDragGhostPosition(dragState.dragGhostEl, clientX, clientY);
			}
			if (dragState.mode === 'move') {
				if (this.timedDropContext) {
					const allDayRect = body.getBoundingClientRect();
					const timedRect = this.timedDropContext.daysGrid.getBoundingClientRect();
					const insideTimed = clientX >= timedRect.left && clientX <= timedRect.right;
					const minTimedTransferY = Math.max(timedRect.top + 8, allDayRect.bottom + 8);
					if (insideTimed && clientY >= minTimedTransferY && clientY <= timedRect.bottom) {
						const position = this.resolveTimedGridPosition(
							this.timedDropContext.daysGrid,
							this.timedDropContext.visibleDates,
							this.timedDropContext.metrics,
							clientX,
							clientY,
						);
						const duration = this.resolveCalendarTaskDurationMinutes(
							placement.item,
							this.timedDropContext.preset.slotMinutes,
						);
						const endMinute = Math.min(24 * 60, position.minuteOfDay + duration);
						const selection = buildTimedSlotSelection(
							this.timedDropContext.visibleDates[position.dayIndex] ?? visibleDates[placement.startColumn],
							position.minuteOfDay,
							endMinute,
							CALENDAR_TIMED_SNAP_MINUTES,
						);
						dragState.dropTarget = 'timed';
						dragState.timedSelection = selection;
						if (!dragState.timedPreviewEl) {
							dragState.timedPreviewEl = this.timedDropContext.daysGrid.createDiv('operon-calendar-timed-transfer-preview');
						}
						const previewStart = this.extractMinuteOfDay(selection.start);
						const previewEnd = Math.min(24 * 60, previewStart + duration);
						this.applyTimedPlacementStyle(
							dragState.timedPreviewEl,
							position.dayIndex,
							0,
							1,
							previewStart,
							previewEnd,
							this.timedDropContext.visibleDates.length,
							this.timedDropContext.metrics,
						);
						this.timedDropContext.hoverGuideOverlay.empty();
						this.renderTimedSelectionGuides(
							this.timedDropContext.section,
							this.timedDropContext.gutter,
							this.timedDropContext.daysGrid,
							this.timedDropContext.hoverGuideOverlay,
							this.timedDropContext.visibleDates[position.dayIndex] ?? '',
							previewStart,
							previewEnd,
							this.timedDropContext.metrics,
							'var(--interactive-accent)',
							this.timedDropContext.settings,
							position.dayIndex,
							this.timedDropContext.visibleDates.length,
						);
						return;
					}
				}
				dragState.dropTarget = 'allDay';
				dragState.timedSelection = null;
				dragState.timedPreviewEl?.remove();
				dragState.timedPreviewEl = null;
				this.timedDropContext?.hoverGuideOverlay.empty();
				if (dropContextMode === 'multiWeek') {
					const allDayTarget = this.resolveMultiWeekAllDayDropTarget(clientX, clientY);
					if (allDayTarget?.dateKey) {
						const deltaDays = this.diffCalendarDateKeys(dragState.anchorDate, allDayTarget.dateKey);
						dragState.currentStartDate = shiftCalendarDateKey(placement.item.startDate, deltaDays);
						dragState.currentEndDate = shiftCalendarDateKey(placement.item.endDate, deltaDays);
					}
				} else {
					const column = this.resolveAllDayColumnIndex(body, clientX, visibleDates.length);
					const span = placement.endColumn - placement.startColumn;
					const delta = column - dragState.anchorColumn;
					const maxStart = Math.max(0, visibleDates.length - span - 1);
					const nextStart = Math.max(0, Math.min(maxStart, placement.startColumn + delta));
					dragState.currentStartColumn = nextStart;
					dragState.currentEndColumn = nextStart + span;
					dragState.currentStartDate = visibleDates[nextStart] ?? placement.item.startDate;
					dragState.currentEndDate = visibleDates[nextStart + span] ?? placement.item.endDate;
				}
			} else {
				if (dropContextMode === 'multiWeek') {
					const allDayTarget = this.resolveMultiWeekAllDayDropTarget(clientX, clientY);
					if (allDayTarget?.dateKey) {
						dragState.currentStartDate = placement.item.startDate;
						dragState.currentEndDate = allDayTarget.dateKey < placement.item.startDate
							? placement.item.startDate
							: allDayTarget.dateKey;
					}
				} else {
					const column = this.resolveAllDayColumnIndex(body, clientX, visibleDates.length);
					dragState.currentStartColumn = placement.startColumn;
					dragState.currentEndColumn = Math.max(placement.startColumn, column);
					dragState.currentStartDate = visibleDates[placement.startColumn] ?? placement.item.startDate;
					dragState.currentEndDate = visibleDates[Math.max(placement.startColumn, column)] ?? placement.item.endDate;
				}
			}
			renderPlacement();
		};

		const startDrag = (event: PointerEvent, mode: 'move' | 'resize-right'): void => {
			event.stopPropagation();
			this.hideCalendarHoverMenu(true);
			dragState = {
				pointerId: event.pointerId,
				mode,
				activated: false,
				anchorColumn: this.resolveAllDayColumnIndex(body, event.clientX, visibleDates.length),
				anchorDate: visibleDates[this.resolveAllDayColumnIndex(body, event.clientX, visibleDates.length)] ?? placement.item.startDate,
				initialClientX: event.clientX,
				initialClientY: event.clientY,
				currentStartColumn: placement.startColumn,
				currentEndColumn: placement.endColumn,
				currentStartDate: placement.item.startDate,
				currentEndDate: placement.item.endDate,
				dropTarget: 'allDay',
				timedSelection: null,
				timedPreviewEl: null,
				dragGhostEl: null,
			};
			this.beginCalendarDragSession(itemEl, event.pointerId, finishDrag);
			itemEl.setPointerCapture?.(event.pointerId);
		};

		itemEl.addEventListener('pointerdown', (event: PointerEvent) => {
			if (event.button !== 0) return;
			const target = asHTMLElement(event.target, itemEl);
			const mode = target?.closest('.operon-calendar-all-day-resize-handle')
				? 'resize-right'
				: 'move';
			startDrag(event, mode);
		});

		itemEl.addEventListener('pointermove', (event: PointerEvent) => {
			if (!dragState || dragState.pointerId !== event.pointerId) return;
			updateFromClient(event.clientX, event.clientY);
		});

		const finishDrag = (reason: CalendarDragEndReason, event: PointerEvent | null): void => {
			if (!dragState) return;
			const pointerId = dragState.pointerId;
			if (event && pointerId !== event.pointerId) return;
			if (event) {
				updateFromClient(event.clientX, event.clientY);
			}
			const wasActivated = dragState.activated;
			const wasMove = dragState.mode === 'move';
			const selection = commitSelection();
			const changed = dragState.currentStartDate !== placement.item.startDate
				|| dragState.currentEndDate !== placement.item.endDate
				|| dragState.dropTarget === 'timed';
				this.releaseCalendarPointerCapture(itemEl, pointerId);
				itemEl.removeClass('is-dragging');
				this.removeCalendarDragGhost(dragState.dragGhostEl);
				itemEl.removeClass('operon-calendar-drag-source-hidden');
			dragState.timedPreviewEl?.remove();
			this.timedDropContext?.hoverGuideOverlay.empty();
			const dropTarget = dragState.dropTarget;
			dragState = null;
			if (reason !== 'commit') {
				renderPlacement();
				return;
			}
			if (!wasActivated) {
				void this.callbacks.onItemAction?.(placement.item.taskId, 'openEditor');
				return;
			}
			if (!changed) {
				renderPlacement();
				return;
			}
			itemEl.dataset.suppressCalendarClick = 'true';
			if (dropTarget === 'timed') {
				const writebackPlan = buildTimedCalendarWritebackPlanForExistingCalendarAssignment(
					selection,
					placement.item.renderSnapshot.fieldValues,
					{ preserveExistingDuration: true },
				);
				this.invokeCalendarDropCallback(
					placement.item.taskId,
					writebackPlan.payload,
					() => this.callbacks.onAllDayItemDropToTimed?.(placement.item.taskId, selection),
				);
				return;
			}
			if (wasMove) {
				this.invokeCalendarDropCallback(
					placement.item.taskId,
					buildAllDayMoveWritebackPlan(placement.item.renderSnapshot.fieldValues, selection.startDate).payload,
					() => this.callbacks.onAllDayScheduledMove?.(placement.item.taskId, selection),
				);
				return;
			}
			this.invokeCalendarDropCallback(
				placement.item.taskId,
				buildAllDayResizeRightWritebackPlan(placement.item.renderSnapshot.fieldValues, selection.endDate).payload,
				() => this.callbacks.onAllDayScheduledResizeRight?.(placement.item.taskId, selection),
			);
		};

		itemEl.addEventListener('pointerup', (event: PointerEvent) => this.finishActiveCalendarDragSession('commit', event));
		itemEl.addEventListener('pointercancel', (event: PointerEvent) => this.finishActiveCalendarDragSession('cancel', event));
	}

	private buildAllDayPlacements(items: CalendarItem[], visibleDates: string[]): AllDayPlacement[] {
		const ranges = items
			.map(item => {
				const indices = this.resolveVisibleRangeIndices(item.startDate, item.endDate, visibleDates);
				if (!indices) return null;
				return {
					item,
					startColumn: indices.startColumn,
					endColumn: indices.endColumn,
				};
			})
			.filter((entry): entry is { item: CalendarItem; startColumn: number; endColumn: number } => !!entry)
			.sort((left, right) => {
				if (left.startColumn !== right.startColumn) return left.startColumn - right.startColumn;
				return right.endColumn - left.endColumn;
			});

		const laneEndColumns: number[] = [];
		const placements: Array<AllDayPlacement & { laneCount: number }> = [];

		for (const range of ranges) {
			let lane = 0;
			while (lane < laneEndColumns.length && laneEndColumns[lane] >= range.startColumn) {
				lane += 1;
			}
			if (lane === laneEndColumns.length) {
				laneEndColumns.push(range.endColumn);
			} else {
				laneEndColumns[lane] = range.endColumn;
			}
			placements.push({
				...range,
				lane,
				laneCount: 1,
			});
		}

		const laneCount = Math.max(1, laneEndColumns.length);
		return placements.map(placement => ({
			...placement,
			laneCount,
		}));
	}

	private buildTimedPlacements(items: CalendarItem[], visibleDates: string[]): TimedSegmentPlacement[] {
		const perDay = new Map<number, TimedSegmentPlacement[]>();

		for (const item of items) {
			if (!item.startDateTime || !item.endDateTime) continue;
			const start = parseLocalDatetime(item.startDateTime);
			const end = parseLocalDatetime(item.endDateTime);
			if (!start || !end || end.getTime() <= start.getTime()) continue;

			for (let dayIndex = 0; dayIndex < visibleDates.length; dayIndex++) {
				const dayKey = visibleDates[dayIndex];
				if (dayKey < item.startDate || dayKey > item.endDate) continue;

				const startMinutes = dayKey === item.startDate
					? this.extractMinuteOfDay(item.startDateTime)
					: 0;
				const endMinutes = dayKey === item.endDate
					? this.extractMinuteOfDay(item.endDateTime)
					: 24 * 60;
				if (endMinutes <= startMinutes) continue;

				const list = perDay.get(dayIndex) ?? [];
				list.push({
					item,
					dayIndex,
					lane: 0,
					laneCount: 1,
					startMinutes,
					endMinutes,
				});
				perDay.set(dayIndex, list);
			}
		}

		const placements: TimedSegmentPlacement[] = [];
		for (const [dayIndex, segments] of perDay.entries()) {
			placements.push(...this.layoutTimedDay(dayIndex, segments));
		}

		return placements;
	}

	private buildTimedGridVisualPlacements(items: CalendarItem[], visibleDates: string[]): TimedGridVisualPlacement[] {
		return buildTimedGridVisualLayout(this.buildTimedPlacements(items, visibleDates));
	}

	private layoutTimedDay(dayIndex: number, segments: TimedSegmentPlacement[]): TimedSegmentPlacement[] {
		const sorted = [...segments].sort((left, right) => {
			if (left.startMinutes !== right.startMinutes) return left.startMinutes - right.startMinutes;
			return left.endMinutes - right.endMinutes;
		});

		const laidOut: TimedSegmentPlacement[] = [];
		let cluster: TimedSegmentPlacement[] = [];
		let clusterMaxEnd = -1;

		const flushCluster = () => {
			if (cluster.length === 0) return;
			const laneEnds: number[] = [];
			const clusterPlacements: TimedSegmentPlacement[] = [];
			for (const segment of cluster) {
				let lane = 0;
				while (lane < laneEnds.length && laneEnds[lane] > segment.startMinutes) {
					lane += 1;
				}
				if (lane === laneEnds.length) {
					laneEnds.push(segment.endMinutes);
				} else {
					laneEnds[lane] = segment.endMinutes;
				}
				clusterPlacements.push({
					...segment,
					dayIndex,
					lane,
					laneCount: 1,
				});
			}

			const laneCount = Math.max(1, laneEnds.length);
			for (const placement of clusterPlacements) {
				laidOut.push({
					...placement,
					laneCount,
				});
			}
			cluster = [];
			clusterMaxEnd = -1;
		};

		for (const segment of sorted) {
			if (cluster.length > 0 && segment.startMinutes >= clusterMaxEnd) {
				flushCluster();
			}
			cluster.push(segment);
			clusterMaxEnd = Math.max(clusterMaxEnd, segment.endMinutes);
		}
		flushCluster();
		return laidOut;
	}

	private resolveVisibleRangeIndices(
		startDate: string,
		endDate: string,
		visibleDates: string[],
	): { startColumn: number; endColumn: number } | null {
		let startColumn = -1;
		let endColumn = -1;
		for (let index = 0; index < visibleDates.length; index++) {
			if (visibleDates[index] < startDate || visibleDates[index] > endDate) continue;
			if (startColumn === -1) startColumn = index;
			endColumn = index;
		}
		return startColumn === -1 || endColumn === -1
			? null
			: { startColumn, endColumn };
	}

	private bindHoverMenuTarget(triggerEl: HTMLElement, item: CalendarItem): void {
		if (!this.callbacks.onItemAction) return;
		triggerEl.addEventListener('pointerenter', () => {
			if (this.hoverMenu.isActive(item.taskId)) {
				this.hoverMenu.clearHideTimer();
				return;
			}
			this.scheduleCalendarHoverMenuShow(() => {
				void this.showCalendarHoverMenu(triggerEl, item);
			});
		});
		triggerEl.addEventListener('pointerleave', (event: PointerEvent) => {
			this.clearHoverMenuShowTimer();
			const related = event.relatedTarget;
			if (this.hoverMenu.contains(related)) {
				this.clearHoverMenuHideTimer();
				return;
			}
			this.scheduleCalendarHoverMenuHide();
		});
	}

	private async showCalendarHoverMenu(
		anchorEl: HTMLElement,
		item: CalendarItem,
	): Promise<void> {
		if (this.timedHorizontalGesture.axisLock === 'horizontal' || Math.abs(this.timedHorizontalGesture.offsetPx) > 0.5) {
			return;
		}
		const context: ContextualMenuContext = {
			surface: getContextualMenuSurfaceForCalendarItem(item),
			taskId: item.taskId,
			task: item.sourceTask ?? item.renderSnapshot,
			now: localNow(),
			isPinned: this.getPinnedCache()?.isPinned(item.taskId) ?? false,
			calendarItem: item,
			projectedRef: item.origin === 'projected' && item.repeatRef
				? {
					seriesId: item.repeatRef.seriesId,
					occurrenceDate: item.repeatRef.occurrenceDate,
				}
				: null,
		};
		const actions = resolveContextualMenu(
			context,
			this.getSettings().contextualMenuActionAllowlist,
			this.getSettings().contextualMenuSurfaceActionMatrix,
		);
		if (actions.length === 0 || !this.callbacks.onItemAction) {
			if (this.hoverMenu.isActive(item.taskId)) {
				this.hideCalendarHoverMenu(true);
			}
			return;
		}
		this.showHoverMenuForActions(
			anchorEl,
			item.taskId,
			actions,
			this.resolveCalendarHoverMenuAnchorRect(anchorEl, item),
			context,
		);
	}

	private showHoverMenuForActions(
		anchorEl: HTMLElement,
		taskId: string,
		actions: ResolvedContextualMenuAction[],
		anchorRect = anchorEl.getBoundingClientRect(),
		context?: ContextualMenuContext,
	): void {
		if (actions.length === 0 || !this.callbacks.onItemAction) {
			if (this.hoverMenu.isActive(taskId)) {
				this.hideCalendarHoverMenu(true);
			}
			return;
		}
		this.hoverMenu.show({
			key: taskId,
			taskId,
			actions,
			anchorRect,
			context,
			onAction: this.callbacks.onItemAction,
		});
	}

	private resolveCalendarHoverMenuAnchorRect(
		anchorEl: HTMLElement,
		item: CalendarItem | null,
	): DOMRect {
		const anchorTarget = anchorEl.querySelector<HTMLElement>('.operon-calendar-status-button') ?? anchorEl;
		const baseRect = anchorTarget.getBoundingClientRect();
		if (item?.kind !== 'timed' || !this.timedScrollEl) {
			return baseRect;
		}

		const visibleRect = resolveVisibleContextualHoverAnchorRect(
			baseRect,
			baseRect,
			this.timedScrollEl.getBoundingClientRect(),
		);
		return new DOMRect(visibleRect.left, visibleRect.top, visibleRect.width, visibleRect.height);
	}

	private positionCalendarHoverMenu(anchorRect: DOMRect, menu: HTMLElement): boolean {
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

	private scheduleCalendarHoverMenuHide(): void {
		this.hoverMenu.scheduleHide();
	}

	private scheduleCalendarHoverMenuShow(callback: () => void): void {
		this.hoverMenu.scheduleShow(callback);
	}

	private clearHoverMenuShowTimer(): void {
		this.hoverMenu.clearShowTimer();
	}

	private clearHoverMenuHideTimer(): void {
		this.hoverMenu.clearHideTimer();
	}

	private hideCalendarHoverMenu(immediate = true): void {
		this.hoverMenu.hide(immediate);
	}

	private bindCalendarNavigationKeys(): void {
		if (this.calendarNavigationKeydownHandler) return;
		this.calendarNavigationKeydownHandler = (event: KeyboardEvent) => {
			if (this.app.workspace.getMostRecentLeaf()?.view !== this) return;
			if (this.shouldIgnoreCalendarArrowNavigation(event.target)) return;
			const delta = event.key === 'ArrowLeft'
				? -1
				: event.key === 'ArrowRight'
					? 1
					: event.key === 'ArrowUp'
						? -7
						: event.key === 'ArrowDown'
							? 7
							: null;
			if (delta === null) return;
			event.preventDefault();
			event.stopPropagation();
			this.hideCalendarHoverMenu(true);
			void this.shiftCalendarAnchorByDays(delta, true);
		};
		this.calendarNavigationDocument = getOwnerDocument(this.containerEl);
		this.calendarNavigationDocument.addEventListener('keydown', this.calendarNavigationKeydownHandler, true);
	}

	private unbindCalendarNavigationKeys(): void {
		if (!this.calendarNavigationKeydownHandler) return;
		this.calendarNavigationDocument?.removeEventListener('keydown', this.calendarNavigationKeydownHandler, true);
		this.calendarNavigationKeydownHandler = null;
		this.calendarNavigationDocument = null;
	}

	private shouldIgnoreCalendarArrowNavigation(target: EventTarget | null): boolean {
		const targetEl = asHTMLElement(target, this.containerEl);
		if (!targetEl) return false;
		if (targetEl.closest('input, textarea, select')) return true;
		if (targetEl.isContentEditable) return true;
		return !!targetEl.closest('[contenteditable="true"]');
	}

	private renderCalendarItemLabel(
		container: HTMLElement,
		item: CalendarItem,
		settings: OperonSettings,
		compact: boolean,
	): HTMLElement | null {
		const wrapper = container.createDiv(compact ? 'operon-calendar-item-label is-compact' : 'operon-calendar-item-label');
		if (item.origin === 'external') {
			wrapper.addClass('is-external');
			wrapper.createSpan({
				text: item.renderSnapshot.description || item.taskId,
				cls: compact ? 'operon-calendar-all-day-text' : 'operon-calendar-timed-title',
			});
			return null;
		}
		const hoverTrigger = wrapper.createSpan('operon-calendar-hover-menu-trigger');
		this.renderCalendarStatusButton(hoverTrigger, item, settings, compact);
		const titleEl = wrapper.createSpan({
			text: item.renderSnapshot.description || item.taskId,
			cls: compact ? 'operon-calendar-all-day-text' : 'operon-calendar-timed-title',
		});
		if (item.sourceTask?.primary.format === 'yaml') {
			bindTaskTitleLinkPreview(
				this.app,
				titleEl,
				item.sourceTask.primary.filePath,
				item.sourceTask.primary.filePath,
			);
		}
		return hoverTrigger;
	}

		private renderCalendarStatusButton(
			container: HTMLElement,
			item: CalendarItem,
			settings: OperonSettings,
			compact: boolean,
		): void {
			const button = container.createEl('button', {
				cls: compact
					? 'operon-checkbox operon-calendar-status-button is-compact'
					: 'operon-checkbox operon-calendar-status-button',
				attr: {
					type: 'button',
						},
					});
			button.dataset.operonId = item.taskId;
			const iconName = this.resolveStatusButtonIcon(
				item.renderSnapshot.fieldValues,
				item.renderSnapshot.checkbox,
				settings,
			);
			if (iconName) {
				setIcon(button, iconName);
		}
		setAccessibleLabelWithoutTooltip(button, t('tooltips', 'cycleTaskStatus'));

		const statusColor = this.resolveCalendarStatusColor(item, settings);
		if (statusColor) button.style.color = statusColor;
		if (item.origin === 'projected' || !this.callbacks.onStatusIconClick) {
			button.disabled = true;
			return;
		}

		button.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.invokeCalendarStatusClickCallback(item.taskId, 'status-surface');
			});
		}

	private applyCalendarItemColor(
		element: HTMLElement,
		item: CalendarItem,
		preset: CalendarPreset,
		settings: OperonSettings,
		): void {
			if (preset.colorSource === 'noColor') {
				element.setCssProps({ '--operon-calendar-accent': 'transparent' });
				return;
			}
		const resolvedColor = resolveTaskColorSource(
			item.renderSnapshot.fieldValues,
			preset.colorSource,
			settings,
			{ externalColor: item.origin === 'external' ? item.externalRef?.sourceColor : null },
			);
			if (!resolvedColor) {
				element.setCssProps({ '--operon-calendar-accent': 'transparent' });
				return;
			}
			element.setCssProps({ '--operon-calendar-accent': resolvedColor });
	}

	private resolveCalendarHoverGuideAccent(element: HTMLElement): string {
		const accent = element.style.getPropertyValue('--operon-calendar-accent').trim();
		return accent && accent !== 'transparent'
			? accent
			: 'var(--interactive-accent)';
	}

		private resolveCalendarStatusColor(item: CalendarItem, settings: OperonSettings): string | null {
			return this.resolveCalendarStatusColorFromFieldValues(item.renderSnapshot.fieldValues, settings);
		}

		private resolveCalendarStatusColorFromFieldValues(
			fieldValues: Record<string, string>,
			settings: OperonSettings,
		): string | null {
			const statusDef = findStatusDef(settings.pipelines, fieldValues['status'] ?? '');
			return statusDef?.color?.trim() || null;
		}

		private resolveStatusButtonIcon(
		fieldValues: Record<string, string>,
		checkbox: IndexedTask['checkbox'],
		settings: OperonSettings,
	): string {
		return resolveTaskDisplayIcon(settings, fieldValues, checkbox);
	}

		private resolveCurrentCalendarPreset(settings = this.getSettings()): CalendarPreset | null {
			const state = this.ensureState();
			return settings.calendarPresets.find(entry => entry.id === state.presetId)
				?? settings.calendarPresets[0]
				?? null;
		}

		private applyCalendarCheckboxClass(element: HTMLElement, checkbox: IndexedTask['checkbox']): void {
			element.removeClass('is-open', 'is-done', 'is-cancelled');
			element.addClass(`is-${checkbox}`);
		}

		private applyCalendarTaskFieldColor(
			element: HTMLElement,
			fieldValues: Record<string, string>,
			preset: CalendarPreset,
			settings: OperonSettings,
		): void {
			if (preset.colorSource === 'noColor') {
				element.setCssProps({ '--operon-calendar-accent': 'transparent' });
				return;
			}
			const resolvedColor = resolveTaskColorSource(
				fieldValues,
				preset.colorSource,
				settings,
				{ externalColor: null },
			);
			element.setCssProps({ '--operon-calendar-accent': resolvedColor || 'transparent' });
		}

		private bindTimedHoverGuides(
		block: HTMLElement,
		overlay: HTMLElement,
		section: HTMLElement,
		gutter: HTMLElement,
		dateKey: string,
		startMinutes: number,
		endMinutes: number,
		_metrics: CalendarTimedMetrics,
		settings: OperonSettings,
	): void {
		let visible = false;

		const hideGuides = (): void => {
			if (!visible) return;
			overlay.empty();
			visible = false;
		};

		const createGuide = (top: number, label: string, accent: string, labelSide: 'start' | 'end'): void => {
			const sectionRect = section.getBoundingClientRect();
			const gutterRect = gutter.getBoundingClientRect();
			const blockRect = block.getBoundingClientRect();
			const left = Math.max(0, gutterRect.right - sectionRect.left);
			const right = Math.max(left, blockRect.left - sectionRect.left);
			const width = Math.max(0, right - left);
			const labelCenter = Math.max(0, (blockRect.left - sectionRect.left) + (blockRect.width / 2) - left);
			const guide = overlay.createDiv('operon-calendar-hover-guide');
			guide.style.top = `${top}px`;
			guide.style.left = `${left}px`;
			guide.style.width = `${width}px`;
			guide.style.setProperty('--operon-calendar-guide-color', accent);
			const labelEl = guide.createSpan({
				text: label,
				cls: `operon-calendar-hover-guide-label is-${labelSide}`,
			});
			labelEl.style.left = `${labelCenter}px`;
		};

		const showGuides = (): void => {
			const accent = this.resolveCalendarHoverGuideAccent(block);
			const sectionRect = section.getBoundingClientRect();
			const blockRect = block.getBoundingClientRect();
			const top = Math.max(0, blockRect.top - sectionRect.top);
			const bottom = Math.max(0, blockRect.bottom - sectionRect.top);
			overlay.empty();
			createGuide(
				top,
				this.formatTimedGuideLabel(dateKey, startMinutes, settings),
				accent,
				'start',
			);
			createGuide(
				bottom,
				this.formatTimedGuideLabel(dateKey, endMinutes, settings),
				accent,
				'end',
			);
			visible = true;
		};

		block.addEventListener('mouseenter', showGuides);
		block.addEventListener('mouseleave', () => {
			if (block.matches(':focus-within')) return;
			hideGuides();
		});
		block.addEventListener('focusin', showGuides);
		block.addEventListener('focusout', () => {
			if (block.matches(':hover')) return;
			hideGuides();
		});
		block.addEventListener('pointerdown', hideGuides);
	}

	private applyCalendarPresetTheme(root: HTMLElement, preset: CalendarPreset): void {
		root.removeClass('is-background-themed');
		root.removeClass('is-background-tinted');
		root.removeClass('is-background-custom');
		root.removeClass('is-appearance-light');
		root.removeClass('is-appearance-dark');
		root.style.removeProperty('color-scheme');
		root.style.removeProperty('--operon-calendar-background-color');
		root.style.removeProperty('--operon-calendar-background-strong');
		root.style.removeProperty('--operon-calendar-background-soft');
		root.style.removeProperty('--operon-calendar-background-gutter');
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


	private resolveCalendarThemeColor(styles: CSSStyleDeclaration, variable: string, fallback: string): CalendarResolvedColor {
		return this.parseCalendarColor(styles.getPropertyValue(variable)) ?? this.parseCalendarColor(fallback) ?? { r: 0, g: 0, b: 0, a: 1 };
	}

	private parseCalendarColor(raw: string | null | undefined): CalendarResolvedColor | null {
		const value = (raw ?? '').trim();
		if (!value) return null;

		const hex = value.replace(/^#/, '');
		if (/^[0-9a-fA-F]{3}$/.test(hex)) {
			return {
				r: Number.parseInt(hex[0] + hex[0], 16),
				g: Number.parseInt(hex[1] + hex[1], 16),
				b: Number.parseInt(hex[2] + hex[2], 16),
				a: 1,
			};
		}
		if (/^[0-9a-fA-F]{6}$/.test(hex)) {
			return {
				r: Number.parseInt(hex.slice(0, 2), 16),
				g: Number.parseInt(hex.slice(2, 4), 16),
				b: Number.parseInt(hex.slice(4, 6), 16),
				a: 1,
			};
		}
		const rgbMatch = value.match(/^rgba?\((.+)\)$/i);
		if (!rgbMatch) return null;
		const parts = rgbMatch[1].split(',').map(part => part.trim());
		if (parts.length < 3) return null;
		const r = Number.parseFloat(parts[0]);
		const g = Number.parseFloat(parts[1]);
		const b = Number.parseFloat(parts[2]);
		const a = parts.length > 3 ? Number.parseFloat(parts[3]) : 1;
		if (![r, g, b, a].every(Number.isFinite)) return null;
		return {
			r: Math.max(0, Math.min(255, Math.round(r))),
			g: Math.max(0, Math.min(255, Math.round(g))),
			b: Math.max(0, Math.min(255, Math.round(b))),
			a: Math.max(0, Math.min(1, a)),
		};
	}

	private mixCalendarColors(from: CalendarResolvedColor, to: CalendarResolvedColor, amount: number): CalendarResolvedColor {
		const weight = Math.max(0, Math.min(1, amount));
		return {
			r: Math.round(from.r + (to.r - from.r) * weight),
			g: Math.round(from.g + (to.g - from.g) * weight),
			b: Math.round(from.b + (to.b - from.b) * weight),
			a: from.a + (to.a - from.a) * weight,
		};
	}

	private withCalendarAlpha(color: CalendarResolvedColor, alpha: number): CalendarResolvedColor {
		return {
			...color,
			a: Math.max(0, Math.min(1, alpha)),
		};
	}

	private serializeCalendarColor(color: CalendarResolvedColor): string {
		if (Math.abs(color.a - 1) < 0.001) {
			return `rgb(${color.r}, ${color.g}, ${color.b})`;
		}
		return `rgba(${color.r}, ${color.g}, ${color.b}, ${Number(color.a.toFixed(3))})`;
	}

	private getCalendarColorLuminance(color: CalendarResolvedColor): number {
		const convert = (value: number): number => {
			const normalized = value / 255;
			return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
		};
		return (0.2126 * convert(color.r)) + (0.7152 * convert(color.g)) + (0.0722 * convert(color.b));
	}

	private formatTimedRange(item: CalendarItem, settings: OperonSettings): string {
		if (!item.startDateTime || !item.endDateTime) return '';
		return `${formatUiTime(this.app, settings, item.startDateTime)} - ${formatUiTime(this.app, settings, item.endDateTime)}`;
	}

	private formatTimedGuideLabel(dateKey: string, minuteOfDay: number, settings: OperonSettings): string {
		return formatUiTime(this.app, settings, this.buildDateMinuteValue(dateKey, minuteOfDay));
	}

	private formatTimedDragLabel(
		dateKey: string,
		startMinutes: number,
		endMinutes: number,
		settings: OperonSettings,
	): string {
		const startValue = this.buildDateMinuteValue(dateKey, startMinutes);
		const endValue = this.buildDateMinuteValue(dateKey, endMinutes);
		const dayLabel = this.formatDayLabel(dateKey);
		return `${dayLabel} ${formatUiTime(this.app, settings, startValue)} - ${formatUiTime(this.app, settings, endValue)}`;
	}

	private formatRangeLabel(visibleDates: string[]): string {
		if (visibleDates.length === 0) return '';
		const start = this.parseDateKey(visibleDates[0]);
		const end = this.parseDateKey(visibleDates[visibleDates.length - 1]);
		if (!start || !end) return visibleDates[0];

		const locale = getAppLocale(this.app);
		const sameYear = start.getFullYear() === end.getFullYear();
		const sameMonth = sameYear && start.getMonth() === end.getMonth();
		const startFormatter = new Intl.DateTimeFormat(locale, {
			month: 'short',
			day: 'numeric',
		});
		const endFormatter = new Intl.DateTimeFormat(locale, {
			month: sameMonth ? undefined : 'short',
			day: 'numeric',
			year: sameYear ? undefined : 'numeric',
		});
		return visibleDates.length === 1
			? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(start)
			: `${startFormatter.format(start)} - ${endFormatter.format(end)}`;
	}

	private getMultiWeekVisibleDaySpan(preset: CalendarPreset): number {
		return preset.showWeekends ? 7 : 5;
	}

	private getMultiWeekVisibleDayCount(preset: CalendarPreset): number {
		return this.getMultiWeekVisibleDaySpan(preset) * Math.max(1, preset.weekCount || 2);
	}

	private buildMultiWeekGroups(visibleDates: string[], preset: CalendarPreset): CalendarMultiWeekGroup[] {
		const groupSize = Math.max(1, this.getMultiWeekVisibleDaySpan(preset));
		const groups: CalendarMultiWeekGroup[] = [];
		for (let index = 0; index < visibleDates.length; index += groupSize) {
			groups.push({
				visibleDates: visibleDates.slice(index, index + groupSize),
			});
		}
		return groups;
	}

	private getMultiWeekFocusedWeekNumber(preset: CalendarPreset): 1 | 2 | 3 | 4 | 5 | 6 {
		const safeWeekCount = Math.max(1, Math.min(6, preset.weekCount || 2)) as 1 | 2 | 3 | 4 | 5 | 6;
		const focused = preset.focusedWeekNumber ?? 1;
		return Math.max(1, Math.min(safeWeekCount, focused)) as 1 | 2 | 3 | 4 | 5 | 6;
	}

	private alignCalendarDateToWeekStart(dateKey: string, weekStart: 'monday' | 'sunday'): string {
		const parsed = this.parseDateKey(dateKey);
		if (!parsed) return dateKey;
		const currentDay = parsed.getDay();
		const offset = weekStart === 'sunday'
			? currentDay
			: (currentDay + 6) % 7;
		const aligned = new Date(parsed);
		aligned.setDate(aligned.getDate() - offset);
		return this.formatDateKey(aligned);
	}

	private resolveMultiWeekRangeStart(
		anchorDate: string,
		preset: CalendarPreset,
		weekStart: 'monday' | 'sunday',
	): string {
		const focusedWeekStart = this.alignCalendarDateToWeekStart(anchorDate, weekStart);
		const weeksBefore = this.getMultiWeekFocusedWeekNumber(preset) - 1;
		return shiftCalendarDateKey(focusedWeekStart, -(weeksBefore * 7));
	}

	private resolveCalendarFieldLabel(fieldKey: string): string {
		return this.getSettings().keyMappings.find(mapping => mapping.canonicalKey === fieldKey)?.visiblePropertyName?.trim() || fieldKey;
	}

	private renderMultiWeekTimeChip(
		container: HTMLElement,
		fieldKey: 'datetimeStart' | 'datetimeEnd',
		dateKey: string,
		minuteOfDay: number,
		settings: OperonSettings,
	): void {
		const chip = container.createSpan('operon-calendar-multi-week-time-chip');
		const iconName = getConfiguredKeyMappingIcon(fieldKey, settings.keyMappings);
		if (iconName) {
			const iconWrap = chip.createSpan('operon-calendar-multi-week-time-chip-icon');
			setIcon(iconWrap, iconName);
		}
		const label = this.resolveCalendarFieldLabel(fieldKey);
		const value = formatUiTime(this.app, settings, this.buildDateMinuteValue(dateKey, minuteOfDay));
		bindOperonHoverTooltip(chip, {
			content: `${label} ${value}`,
			taskColor: null,
		});
		setAccessibleLabelWithoutTooltip(chip, `${label} ${value}`);
		chip.createSpan({
			text: value,
			cls: 'operon-calendar-multi-week-time-chip-label',
		});
	}

	private resolveMultiWeekAllDayDropTarget(
		clientX: number,
		clientY: number,
	): { context: CalendarAllDayDropContext; column: number; dateKey: string } | null {
		for (const context of this.multiWeekAllDayDropContexts) {
			const rect = context.body.getBoundingClientRect();
			const inside = clientX >= rect.left
				&& clientX <= rect.right
				&& clientY >= rect.top
				&& clientY <= rect.bottom;
			if (!inside) continue;
			const column = this.resolveAllDayColumnIndex(context.body, clientX, context.visibleDates.length);
			const dateKey = context.visibleDates[column];
			if (!dateKey) continue;
			return { context, column, dateKey };
		}
		return null;
	}

	private resolveMultiWeekInDayDropTarget(
		clientX: number,
		clientY: number,
	): { context: CalendarMultiWeekInDayDropContext; dayIndex: number; dateKey: string } | null {
		for (const context of this.multiWeekInDayDropContexts) {
			const rect = context.body.getBoundingClientRect();
			const inside = clientX >= rect.left
				&& clientX <= rect.right
				&& clientY >= rect.top
				&& clientY <= rect.bottom;
			if (!inside) continue;
			const dayIndex = this.resolveAllDayColumnIndex(context.body, clientX, context.visibleDates.length);
			const dateKey = context.visibleDates[dayIndex];
			if (!dateKey) continue;
			return { context, dayIndex, dateKey };
		}
		return null;
	}

	private formatFocusedDateButtonLabel(dateKey: string): string {
		const date = this.parseDateKey(dateKey) ?? this.parseDateKey(localToday()) ?? new Date();
		return new Intl.DateTimeFormat(undefined, {
			day: 'numeric',
			month: 'long',
		}).format(date);
	}

	private formatWeekdayLabel(dateKey: string): string {
		const date = this.parseDateKey(dateKey);
		if (!date) return dateKey;
		return new Intl.DateTimeFormat(getAppLocale(this.app), {
			weekday: 'short',
		}).format(date);
	}

	private formatDayLabel(dateKey: string): string {
		const date = this.parseDateKey(dateKey);
		if (!date) return dateKey;
		return new Intl.DateTimeFormat(getAppLocale(this.app), {
			month: 'short',
			day: 'numeric',
		}).format(date);
	}

	private buildTimedMetrics(preset: CalendarPreset, isHiddenExpanded: boolean): CalendarTimedMetrics {
		const hiddenRange = this.resolveHiddenTimeRange(preset);
		const scale = Math.max(0.5, Math.min(4, this.getSettings().calendarTimeGridScale || 2));
		const collapsedBandHeight = hiddenRange.enabled && !isHiddenExpanded
			? Math.max(16, Math.round(32 * scale))
			: 0;
		const hiddenMinutes = hiddenRange.enabled && !isHiddenExpanded
			? hiddenRange.endMinutes - hiddenRange.startMinutes
			: 0;
		return {
			hiddenRange,
			isHiddenExpanded,
			scale,
			collapsedBandHeight,
			gridHeight: Math.max(240, Math.round(((24 * 60) - hiddenMinutes) * scale) + collapsedBandHeight),
		};
	}

	private resolveHiddenTimeRange(preset: CalendarPreset): CalendarHiddenTimeRange {
		const startMinutes = this.parseClockMinutes(preset.hiddenTimeStart);
		const endMinutes = this.parseClockMinutes(preset.hiddenTimeEnd);
		if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
			return { enabled: false, startMinutes: 0, endMinutes: 0 };
		}
		return { enabled: true, startMinutes, endMinutes };
	}

	private parseClockMinutes(value: string | null | undefined): number | null {
		const match = /^(\d{2}):(\d{2})$/.exec((value ?? '').trim());
		if (!match) return null;
		const hour = Number.parseInt(match[1], 10);
		const minute = Number.parseInt(match[2], 10);
		if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
			return null;
		}
		return (hour * 60) + minute;
	}

	private isHiddenMinute(minuteOfDay: number, range: CalendarHiddenTimeRange): boolean {
		return range.enabled && minuteOfDay > range.startMinutes && minuteOfDay < range.endMinutes;
	}

	private minuteToGridOffset(minuteOfDay: number, metrics: CalendarTimedMetrics): number {
		const clamped = Math.max(0, Math.min(24 * 60, Math.round(minuteOfDay)));
		if (!metrics.hiddenRange.enabled || metrics.isHiddenExpanded) return clamped * metrics.scale;
		if (clamped <= metrics.hiddenRange.startMinutes) return clamped * metrics.scale;
		if (clamped >= metrics.hiddenRange.endMinutes) {
			return (metrics.hiddenRange.startMinutes * metrics.scale) + metrics.collapsedBandHeight + ((clamped - metrics.hiddenRange.endMinutes) * metrics.scale);
		}
		const hiddenDuration = Math.max(1, metrics.hiddenRange.endMinutes - metrics.hiddenRange.startMinutes);
		const ratio = (clamped - metrics.hiddenRange.startMinutes) / hiddenDuration;
		return (metrics.hiddenRange.startMinutes * metrics.scale) + (metrics.collapsedBandHeight * ratio);
	}

	private gridOffsetToMinute(offset: number, metrics: CalendarTimedMetrics): number {
		const clamped = Math.max(0, Math.min(metrics.gridHeight, Math.round(offset)));
		if (!metrics.hiddenRange.enabled || metrics.isHiddenExpanded) {
			return Math.round(clamped / metrics.scale);
		}
		const bandStart = metrics.hiddenRange.startMinutes * metrics.scale;
		const bandEnd = bandStart + metrics.collapsedBandHeight;
		if (clamped <= bandStart) return Math.round(clamped / metrics.scale);
		if (clamped >= bandEnd) {
			return Math.round(metrics.hiddenRange.endMinutes + ((clamped - bandEnd) / metrics.scale));
		}
		return clamped - bandStart <= bandEnd - clamped
			? metrics.hiddenRange.startMinutes
			: metrics.hiddenRange.endMinutes;
	}

	private parseDateKey(dateKey: string): Date | null {
		const [year, month, day] = dateKey.split('-').map(part => Number.parseInt(part, 10));
		if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
		return new Date(year, month - 1, day, 12, 0, 0, 0);
	}

	private diffCalendarDateKeys(fromDate: string, toDate: string): number {
		const from = this.parseDateKey(fromDate);
		const to = this.parseDateKey(toDate);
		if (!from || !to) return 0;
		return Math.round((to.getTime() - from.getTime()) / 86400000);
	}

	private formatDateKey(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	private resolveTimedMinuteOffset(column: HTMLElement, clientY: number, metrics: CalendarTimedMetrics): number {
		const rect = column.getBoundingClientRect();
		if (rect.height <= 0) return 0;
		const relativeY = Math.max(0, Math.min(metrics.gridHeight, clientY - rect.top));
		return this.gridOffsetToMinute(relativeY, metrics);
	}

	private resolveTimedGridPosition(
		daysGrid: HTMLElement,
		visibleDates: string[],
		metrics: CalendarTimedMetrics,
		clientX: number,
		clientY: number,
	): { dayIndex: number; minuteOfDay: number } {
		const rect = daysGrid.getBoundingClientRect();
		const width = Math.max(1, rect.width);
		const relativeX = Math.max(0, Math.min(width - 1, clientX - rect.left));
		const relativeY = Math.max(0, Math.min(metrics.gridHeight, clientY - rect.top));
		return {
			dayIndex: Math.max(0, Math.min(
				visibleDates.length - 1,
				Math.floor((relativeX / width) * visibleDates.length),
			)),
			minuteOfDay: Math.max(0, Math.min(24 * 60, this.gridOffsetToMinute(relativeY, metrics))),
		};
	}

	private renderTimedSelectionGuides(
		section: HTMLElement,
		gutter: HTMLElement,
		targetGrid: HTMLElement,
		overlay: HTMLElement,
		dateKey: string,
		startMinutes: number,
		endMinutes: number,
		metrics: CalendarTimedMetrics,
		accent: string,
		settings: OperonSettings,
		dayIndex = 0,
		totalDays = 1,
	): void {
		const sectionRect = section.getBoundingClientRect();
		const gutterRect = gutter.getBoundingClientRect();
		const gridRect = targetGrid.getBoundingClientRect();
		const left = Math.max(0, gutterRect.right - sectionRect.left);
		const dayWidth = gridRect.width / Math.max(1, totalDays);
		const blockLeft = (gridRect.left - sectionRect.left) + (dayIndex * dayWidth);
		const right = Math.max(left, blockLeft);
		const width = Math.max(0, right - left);
		overlay.empty();

		const createGuide = (minuteOfDay: number, labelSide: 'start' | 'end'): void => {
			const guide = overlay.createDiv('operon-calendar-hover-guide');
			const top = (gridRect.top - sectionRect.top) + this.minuteToGridOffset(minuteOfDay, metrics);
			const labelCenter = Math.max(0, blockLeft + (dayWidth / 2) - left);
			guide.style.top = `${Math.max(0, top)}px`;
			guide.style.left = `${left}px`;
			guide.style.width = `${width}px`;
			guide.style.setProperty('--operon-calendar-guide-color', accent);
			const labelEl = guide.createSpan({
				text: this.formatTimedGuideLabel(dateKey, minuteOfDay, settings),
				cls: `operon-calendar-hover-guide-label is-${labelSide}`,
			});
			labelEl.style.left = `${labelCenter}px`;
		};

		createGuide(startMinutes, 'start');
		createGuide(endMinutes, 'end');
	}

	private resolveCalendarTaskDurationMinutes(item: CalendarItem, fallbackSlotMinutes: number): number {
		const timedDuration = item.startDateTime && item.endDateTime
			? Math.max(CALENDAR_TIMED_SNAP_MINUTES, this.extractMinuteOfDay(item.endDateTime) - this.extractMinuteOfDay(item.startDateTime))
			: 0;
		if (timedDuration > 0) return timedDuration;
		const estimateRaw = Number.parseInt((item.renderSnapshot.fieldValues['estimate'] ?? '').trim(), 10);
		if (Number.isFinite(estimateRaw) && estimateRaw > 0) {
			return Math.max(CALENDAR_TIMED_SNAP_MINUTES, estimateRaw / 60);
		}
		return Math.max(CALENDAR_TIMED_SNAP_MINUTES, fallbackSlotMinutes);
	}

	private resolveIndexedTaskDurationMinutes(task: IndexedTask, fallbackSlotMinutes: number): number {
		const datetimeStart = (task.fieldValues['datetimeStart'] ?? '').trim();
		const datetimeEnd = (task.fieldValues['datetimeEnd'] ?? '').trim();
		if (datetimeStart && datetimeEnd) {
			return Math.max(
				CALENDAR_TIMED_SNAP_MINUTES,
				this.extractMinuteOfDay(datetimeEnd) - this.extractMinuteOfDay(datetimeStart),
			);
		}
		const estimateRaw = Number.parseInt((task.fieldValues['estimate'] ?? '').trim(), 10);
		if (Number.isFinite(estimateRaw) && estimateRaw > 0) {
			return Math.max(CALENDAR_TIMED_SNAP_MINUTES, estimateRaw / 60);
		}
		return Math.max(CALENDAR_TIMED_SNAP_MINUTES, fallbackSlotMinutes);
	}

	private resolveAllDayColumnIndex(container: HTMLElement, clientX: number, columnCount: number): number {
		const rect = container.getBoundingClientRect();
		if (rect.width <= 0 || columnCount <= 1) return 0;
		const relativeX = Math.max(0, Math.min(rect.width - 1, clientX - rect.left));
		return Math.max(0, Math.min(columnCount - 1, Math.floor((relativeX / rect.width) * columnCount)));
	}

	private applyAllDayPlacementStyle(
		element: HTMLElement,
		startColumn: number,
		endColumn: number,
		lane: number,
		laneHeight: number,
		totalColumns: number,
	): void {
		element.style.top = `${lane * laneHeight + 2}px`;
		element.style.left = `${(startColumn / totalColumns) * 100}%`;
		element.style.width = `${((endColumn - startColumn + 1) / totalColumns) * 100}%`;
		element.style.height = `${laneHeight - 4}px`;
	}

	private attachNowIndicator(column: HTMLElement, metrics: CalendarTimedMetrics): void {
		const lineEl = column.createDiv('operon-calendar-now-line');
		const labelEl = lineEl.createDiv('operon-calendar-now-label');
		this.nowIndicatorEntries.push({
			lineEl,
			labelEl,
			metrics,
		});
	}

	private updateNowIndicators(): void {
		if (this.nowIndicatorEntries.length === 0) return;
		const now = new Date();
		const minuteOfDay = now.getHours() * 60 + now.getMinutes();
		const label = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

		for (const entry of this.nowIndicatorEntries) {
			entry.lineEl.style.top = `${this.minuteToGridOffset(minuteOfDay, entry.metrics)}px`;
			entry.labelEl.setText(label);
		}
	}

	private extractMinuteOfDay(datetimeValue: string): number {
		const hour = Number.parseInt(datetimeValue.slice(11, 13), 10);
		const minute = Number.parseInt(datetimeValue.slice(14, 16), 10);
		if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
		return Math.max(0, Math.min(24 * 60, hour * 60 + minute));
	}

	private buildDateMinuteValue(dateKey: string, minuteOfDay: number): string {
		const clamped = Math.max(0, Math.min(24 * 60, Math.round(minuteOfDay)));
		if (clamped >= 24 * 60) {
			return `${dateKey}T23:59:00`;
		}
		const hours = String(Math.floor(clamped / 60)).padStart(2, '0');
		const minutes = String(clamped % 60).padStart(2, '0');
		return `${dateKey}T${hours}:${minutes}:00`;
	}

	private bindPrimaryItemClick(container: HTMLElement, item: CalendarItem): void {
		if (item.origin !== 'external' && !this.callbacks.onItemAction) return;
		if (item.origin === 'external' && !this.callbacks.onExternalItemCreateTask) return;
		container.tabIndex = 0;
		container.addClass('is-clickable');
		container.addEventListener('click', (event) => {
			const target = asHTMLElement(event.target, container);
			if (target?.closest('.operon-calendar-hover-menu')) return;
			if (container.dataset.suppressCalendarClick === 'true') {
				delete container.dataset.suppressCalendarClick;
				return;
			}
			if (item.origin === 'external') {
				const seed = this.buildExternalItemCreateSeed(item);
				if (!seed) return;
				void this.callbacks.onExternalItemCreateTask?.(seed);
				return;
			}
			void this.callbacks.onItemAction?.(item.taskId, 'openEditor');
		});
		container.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			if (item.origin === 'external') {
				const seed = this.buildExternalItemCreateSeed(item);
				if (!seed) return;
				void this.callbacks.onExternalItemCreateTask?.(seed);
				return;
			}
			void this.callbacks.onItemAction?.(item.taskId, 'openEditor');
		});
	}

	private buildExternalItemCreateSeed(item: CalendarItem): ExternalCalendarTaskSeed | null {
		if (item.origin !== 'external' || !item.externalRef) return null;
		const title = item.renderSnapshot.description || item.taskId;
		if (item.kind === 'timed' && item.startDateTime && item.endDateTime) {
			return {
				itemId: item.taskId,
				title,
				externalRef: item.externalRef,
				selection: {
					mode: 'timed',
					start: item.startDateTime,
					end: item.endDateTime,
					startDate: item.startDate,
					endDate: item.endDate,
					isAllDay: false,
					slotMinutes: undefined,
				},
			};
		}
		return {
			itemId: item.taskId,
			title,
			externalRef: item.externalRef,
			selection: buildAllDaySlotSelection(item.startDate, item.endDate),
		};
	}

	private buildCreatedExternalEventTaskKeySet(tasks: IndexedTask[]): Set<string> {
		const keys = new Set<string>();
		for (const task of tasks) {
			const key = this.buildExternalEventTaskMatchKey(task.description, task.fieldValues['dateScheduled'] ?? '');
			if (key) keys.add(key);
		}
		return keys;
	}

	private buildExternalEventTaskMatchKey(description: string, dateKey: string): string | null {
		const normalizedDate = dateKey.trim();
		if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalizedDate)) return null;
		const normalizedDescription = description
			.trim()
			.toLocaleLowerCase()
			.replace(/\s+/gu, ' ');
		if (!normalizedDescription) return null;
		return `${normalizedDate}::${normalizedDescription}`;
	}

	private createToolbarButton(
		container: HTMLElement,
		label: string,
		onClick: () => void,
		title?: string,
		extraClass?: string,
	): void {
		const button = container.createEl('button', {
			text: label,
			cls: `operon-calendar-toolbar-button${extraClass ? ` ${extraClass}` : ''}`,
		});
		if (title) bindOperonHoverTooltip(button, { content: title, taskColor: null });
		button.addEventListener('click', onClick);
	}

	private async handleTodayButtonClick(state: CalendarLeafState, preset: CalendarPreset): Promise<void> {
		const today = localToday();
		if (state.anchorDate !== today) {
			await this.updateLeafState({ ...state, anchorDate: today });
			return;
		}
		if (preset.surfaceType !== 'timeGrid') {
			return;
		}

		this.lastAppliedScrollSignature = null;
		this.scheduleInitialScroll({ ...state, anchorDate: today }, preset, this.renderGeneration);
	}

	private buildTimedHorizontalRenderWindow(
		anchorDate: string,
		preset: Pick<CalendarPreset, 'dayCount' | 'showWeekends' | 'todayPosition'>,
		visibleDates: string[],
	): TimedHorizontalRenderWindow {
		const visibleDayCount = Math.max(1, visibleDates.length || preset.dayCount || 1);
		const bufferDaysPerSide = Math.max(visibleDayCount, 3);
		const bufferedDates = buildVisibleCalendarDates(
			anchorDate,
			visibleDayCount + (bufferDaysPerSide * 2),
			preset.showWeekends,
			bufferDaysPerSide + 1,
		);
		const visibleStartBufferIndex = resolveTimedHorizontalVisibleStartIndex(
			bufferedDates,
			visibleDates,
			anchorDate,
			bufferDaysPerSide,
		);
		return {
			anchorDate,
			visibleDates: [...visibleDates],
			bufferedDates,
			visibleStartBufferIndex,
			bufferDaysBefore: bufferDaysPerSide,
			bufferDaysAfter: bufferDaysPerSide,
		};
	}

	private handleTimedHorizontalWheel(event: WheelEvent): void {
		if (!this.timedHorizontalRenderWindow || !this.timedHorizontalStripEl || !this.timedHorizontalClipEl) return;
		if (this.hasActiveTimedHorizontalEditInteraction()) return;
		const horizontal = Math.abs(event.deltaX);
		const vertical = Math.abs(event.deltaY);
		if (horizontal < 1 && vertical < 1) return;
		const dominanceRatio = 1.2;
		const nowTs = Date.now();
		this.timedHorizontalGesture.lastWheelTs = nowTs;
		if (!this.timedHorizontalGesture.axisLock) {
			if (horizontal >= 4 && horizontal >= vertical * dominanceRatio) {
				this.timedHorizontalGesture.axisLock = 'horizontal';
			} else if (vertical >= horizontal * dominanceRatio) {
				this.timedHorizontalGesture.axisLock = 'vertical';
			} else {
				return;
			}
		}
		this.scheduleTimedHorizontalGestureReset();
		if (this.timedHorizontalGesture.axisLock !== 'horizontal') {
			return;
		}

		event.preventDefault();
		this.hideCalendarHoverMenu(true);
		this.timedDropContext?.hoverGuideOverlay.empty();
		this.clearTimedHorizontalSnapTimer();
		this.syncTimedHorizontalPanMetrics();
		const dampingFactor = 0.55;
		this.timedHorizontalGesture.offsetPx = this.clampTimedHorizontalOffset(
			this.timedHorizontalGesture.offsetPx + (event.deltaX * dampingFactor),
		);
		this.applyTimedHorizontalPanTransform(false);
		this.scheduleTimedHorizontalSnapFinalize();
	}

	private async shiftCalendarAnchorByDays(dayDelta: number, preserveScroll = false): Promise<void> {
		if (!dayDelta) return;
		const state = this.ensureState();
		const nextState: Partial<CalendarLeafState> = {
			...state,
			anchorDate: shiftCalendarDateKey(state.anchorDate, dayDelta),
		};
		if (preserveScroll && this.timedScrollEl) {
			const preset = this.getSettings().calendarPresets.find(entry => entry.id === state.presetId) ?? this.getSettings().calendarPresets[0];
			if (preset) {
				const hiddenTimeKey = `${preset.id}|${state.anchorDate}`;
				const metrics = this.buildTimedMetrics(preset, this.expandedHiddenTimeKey === hiddenTimeKey);
				nextState.scrollMinutes = this.gridOffsetToMinute(Math.max(0, Math.round(this.timedScrollEl.scrollTop)), metrics);
				this.restoreScrollOnNextRender = true;
			}
		}
		await this.updateLeafState(nextState);
	}

		private hasActiveTimedHorizontalEditInteraction(): boolean {
			const section = this.timedDropContext?.section;
			if (!section) return false;
			return !!section.querySelector('.operon-calendar-timed-item.is-live-editing, .operon-calendar-timed-day.is-selecting');
		}

		hasActiveCalendarDragInteraction(): boolean {
			return !!this.activeCalendarDragSession || this.hasActiveTimedHorizontalEditInteraction();
		}

		private scheduleTimedHorizontalGestureReset(): void {
			if (this.timedHorizontalGesture.resetTimer) {
				window.clearTimeout(this.timedHorizontalGesture.resetTimer);
		}
		this.timedHorizontalGesture.resetTimer = window.setTimeout(() => {
			this.timedHorizontalGesture.resetTimer = null;
			this.timedHorizontalGesture.axisLock = null;
		}, 120);
	}

	private scheduleTimedHorizontalSnapFinalize(): void {
		this.clearTimedHorizontalSnapTimer();
		this.timedHorizontalGesture.snapTimer = window.setTimeout(() => {
			this.timedHorizontalGesture.snapTimer = null;
			void this.finalizeTimedHorizontalSnap();
		}, 140);
	}

	private clearTimedHorizontalSnapTimer(): void {
		if (!this.timedHorizontalGesture.snapTimer) return;
		window.clearTimeout(this.timedHorizontalGesture.snapTimer);
		this.timedHorizontalGesture.snapTimer = null;
	}

	private clearTimedHorizontalGestureTimers(): void {
		this.clearTimedHorizontalSnapTimer();
		if (this.timedHorizontalGesture.resetTimer) {
			window.clearTimeout(this.timedHorizontalGesture.resetTimer);
			this.timedHorizontalGesture.resetTimer = null;
		}
	}

	private bindLayoutRefresh(root: HTMLElement): void {
		const generation = this.renderGeneration;
		const refresh = (): void => {
			const clipWidth = this.timedHorizontalClipEl?.getBoundingClientRect().width ?? 0;
			if (!root.isConnected || clipWidth <= 0) return;
			this.syncTimedHorizontalPanMetrics();
			this.applyTimedHorizontalPanTransform(false);
		};
		const scheduleRefresh = (): void => {
			if (this.layoutRefreshFrame !== null) return;
			this.layoutRefreshFrame = this.requestRenderAnimationFrame(generation, () => {
				this.layoutRefreshFrame = null;
				refresh();
			});
		};

		this.layoutRefreshCleanup?.();
		this.layoutRefreshCleanup = null;
		scheduleRefresh();
		this.requestRenderAnimationFrame(generation, scheduleRefresh);
		this.requestRenderAnimationFrame(generation, () => this.requestRenderAnimationFrame(generation, scheduleRefresh));
		this.setRenderTimeout(generation, scheduleRefresh, 0);
		this.setRenderTimeout(generation, scheduleRefresh, 120);

		const observer = new ResizeObserver(() => scheduleRefresh());
		observer.observe(root);
		if (this.timedHorizontalClipEl) observer.observe(this.timedHorizontalClipEl);
		this.layoutRefreshCleanup = () => observer.disconnect();
	}

	private syncTimedHorizontalPanMetrics(): void {
		if (!this.timedHorizontalRenderWindow || !this.timedHorizontalClipEl) return;
		const visibleDayCount = Math.max(1, this.timedHorizontalRenderWindow.visibleDates.length);
		const clipWidth = this.timedHorizontalClipEl.getBoundingClientRect().width;
		this.timedHorizontalDayWidthPx = clipWidth > 0
			? clipWidth / visibleDayCount
			: 0;
	}

	private clampTimedHorizontalOffset(offsetPx: number): number {
		if (!this.timedHorizontalRenderWindow || this.timedHorizontalDayWidthPx <= 0) return offsetPx;
		const { minOffset, maxOffset } = resolveTimedHorizontalOffsetBounds(
			this.timedHorizontalRenderWindow.bufferedDates.length,
			this.timedHorizontalRenderWindow.visibleDates.length,
			this.timedHorizontalRenderWindow.visibleStartBufferIndex,
			this.timedHorizontalDayWidthPx,
		);
		return Math.max(minOffset, Math.min(maxOffset, offsetPx));
	}

	private applyTimedHorizontalPanTransform(withSnapAnimation: boolean): void {
		if (!this.timedHorizontalRenderWindow || !this.timedHorizontalStripEl) return;
		this.syncTimedHorizontalPanMetrics();
		const baseOffsetPx = this.timedHorizontalRenderWindow.visibleStartBufferIndex * this.timedHorizontalDayWidthPx;
		const translatePx = -(baseOffsetPx + this.timedHorizontalGesture.offsetPx);
		this.timedHorizontalStripEl.classList.toggle('is-horizontal-snapping', withSnapAnimation);
		this.timedHorizontalStripEl.style.transform = `translate3d(${translatePx}px, 0, 0)`;
	}

	private async finalizeTimedHorizontalSnap(): Promise<void> {
		if (!this.timedHorizontalRenderWindow || !this.timedHorizontalStripEl) return;
		this.syncTimedHorizontalPanMetrics();
		if (this.timedHorizontalDayWidthPx <= 0) {
			this.timedHorizontalGesture.axisLock = null;
			this.timedHorizontalGesture.offsetPx = 0;
			return;
		}
		const snappedDayDelta = Math.round(this.timedHorizontalGesture.offsetPx / this.timedHorizontalDayWidthPx);
		this.timedHorizontalGesture.offsetPx = snappedDayDelta * this.timedHorizontalDayWidthPx;
		this.applyTimedHorizontalPanTransform(true);
		await new Promise(resolve => window.setTimeout(resolve, 140));
		this.timedHorizontalGesture.axisLock = null;
		this.timedHorizontalGesture.offsetPx = 0;
		if (snappedDayDelta === 0) {
			this.applyTimedHorizontalPanTransform(false);
			return;
		}
		await this.shiftCalendarAnchorByDays(snappedDayDelta, true);
	}

	private scheduleInitialScroll(state: CalendarLeafState, preset: CalendarPreset, generation: number): void {
		this.lastAppliedScrollSignature = null;
		this.requestRenderAnimationFrame(generation, () => {
			this.requestRenderAnimationFrame(generation, () => {
				this.setRenderTimeout(generation, () => this.applyInitialScroll(state, preset, generation), 0);
			});
		});
	}

	private applyInitialScroll(state: CalendarLeafState, preset: CalendarPreset, generation: number, attempt = 0): void {
		if (!this.isRenderGenerationActive(generation)) return;
		if (!this.timedScrollEl) return;
		const settings = this.getSettings();
		const viewportHeight = Math.max(0, Math.round(this.timedScrollEl.clientHeight));
		const hiddenTimeKey = `${preset.id}|${state.anchorDate}`;
		const metrics = this.buildTimedMetrics(preset, this.expandedHiddenTimeKey === hiddenTimeKey);
		const shouldAutoScroll = settings.calendarInitialScrollMode === 'autoNow';
		const signature = shouldAutoScroll
			? [
				state.presetId ?? 'none',
				state.anchorDate,
				'autoNow',
				settings.calendarAutoScrollPastRatio,
				settings.calendarTimeGridScale,
				viewportHeight,
				this.expandedHiddenTimeKey === hiddenTimeKey ? 'expanded' : 'collapsed',
			].join('|')
			: [
				state.presetId ?? 'none',
				state.anchorDate,
				'fixedHour',
				settings.calendarDefaultScrollHour,
				settings.calendarTimeGridScale,
				viewportHeight,
				this.expandedHiddenTimeKey === hiddenTimeKey ? 'expanded' : 'collapsed',
			].join('|');
		const nextScrollTop = shouldAutoScroll
			? this.computeAutoScrollTopFromBottom(metrics, settings.calendarAutoScrollPastRatio)
			: this.minuteToGridOffset(Math.max(0, Math.min(24 * 60, Math.round(settings.calendarDefaultScrollHour) * 60)), metrics);
		const maxScrollTop = Math.max(0, this.timedScrollEl.scrollHeight - this.timedScrollEl.clientHeight);
		const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
		const layoutNotReady = viewportHeight <= 0 || (maxScrollTop <= 0 && clampedScrollTop > 0);
		if (layoutNotReady) {
			if (attempt < 8) {
				this.requestRenderAnimationFrame(generation, () => this.applyInitialScroll(state, preset, generation, attempt + 1));
			}
			return;
		}
		const currentScrollTop = Math.max(0, Math.round(this.timedScrollEl.scrollTop));
		if (this.lastAppliedScrollSignature === signature && Math.abs(currentScrollTop - clampedScrollTop) <= 2) return;
		this.timedScrollEl.scrollTop = clampedScrollTop;
		this.lastAppliedScrollSignature = signature;
	}

	private restoreScrollPosition(state: CalendarLeafState, preset: CalendarPreset): void {
		if (!this.timedScrollEl) return;
		const hiddenTimeKey = `${preset.id}|${state.anchorDate}`;
		const metrics = this.buildTimedMetrics(preset, this.expandedHiddenTimeKey === hiddenTimeKey);
		const nextScrollTop = this.minuteToGridOffset(
			Math.max(0, Math.min(24 * 60, Math.round(state.scrollMinutes))),
			metrics,
		);
		const maxScrollTop = Math.max(0, this.timedScrollEl.scrollHeight - this.timedScrollEl.clientHeight);
		this.timedScrollEl.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
	}

	private captureMultiWeekSurfaceScroll(): void {
		if (!this.surfaceScrollEl) return;
		this.lastSurfaceScrollTop = Math.max(0, Math.round(this.surfaceScrollEl.scrollTop));
		this.restoreSurfaceScrollOnNextRender = true;
	}

	private captureActiveMultiWeekSurfaceScroll(): void {
		const state = this.state;
		if (!state) return;
		const preset = this.getSettings().calendarPresets.find(entry => entry.id === state.presetId) ?? this.getSettings().calendarPresets[0];
		if (preset?.surfaceType !== 'multiWeek') return;
		this.captureMultiWeekSurfaceScroll();
	}

	private captureActiveCalendarScrollForRender(): void {
		const state = this.state;
		if (!state) return;
		const preset = this.getSettings().calendarPresets.find(entry => entry.id === state.presetId) ?? this.getSettings().calendarPresets[0];
		if (preset?.surfaceType === 'multiWeek') {
			this.captureMultiWeekSurfaceScroll();
			return;
		}
		if (preset?.surfaceType !== 'timeGrid' || !this.timedScrollEl) return;
		const hiddenTimeKey = `${preset.id}|${state.anchorDate}`;
		const metrics = this.buildTimedMetrics(preset, this.expandedHiddenTimeKey === hiddenTimeKey);
		this.state = {
			...this.ensureState(),
			scrollMinutes: this.gridOffsetToMinute(Math.max(0, Math.round(this.timedScrollEl.scrollTop)), metrics),
		};
	}

	private restoreMultiWeekSurfaceScroll(generation: number): void {
		if (!this.surfaceScrollEl) return;
		const applyScroll = (): void => {
			if (!this.isRenderGenerationActive(generation)) return;
			if (!this.surfaceScrollEl) return;
			const maxScrollTop = Math.max(0, this.surfaceScrollEl.scrollHeight - this.surfaceScrollEl.clientHeight);
			this.surfaceScrollEl.scrollTop = Math.max(0, Math.min(maxScrollTop, this.lastSurfaceScrollTop));
		};
		applyScroll();
		this.requestRenderAnimationFrame(generation, () => {
			applyScroll();
			this.requestRenderAnimationFrame(generation, applyScroll);
		});
	}

	private computeAutoScrollTopFromBottom(metrics: CalendarTimedMetrics, pastRatio: number): number {
		if (!this.timedScrollEl) return 0;
		const clampedRatio = Math.max(0, Math.min(1, pastRatio));
		const futureRatio = 1 - clampedRatio;
		const now = new Date();
		const minuteOfDay = now.getHours() * 60 + now.getMinutes();
		const nowOffset = this.minuteToGridOffset(minuteOfDay, metrics);
		const viewportHeight = Math.max(0, this.timedScrollEl.clientHeight);
		const bottomVisibleMinutesHeight = viewportHeight * futureRatio;
		return nowOffset - (viewportHeight - bottomVisibleMinutesHeight);
	}

	private ensureState(): CalendarLeafState {
		this.state = this.syncSidebarOpenSections(this.normalizeState(this.state));
		return this.state;
	}

	private scheduleLeafStatePersistence(): void {
		this.clearPersistStateTimer();
		this.persistStateTimer = window.setTimeout(() => {
			this.persistStateTimer = null;
			void this.persistLeafState();
		}, 240);
	}

	private async updateLeafState(state: Partial<CalendarLeafState>): Promise<void> {
		const previousState = this.state;
		const nextState = this.syncSidebarOpenSections(this.normalizeState({
			...(previousState ?? {}),
			...state,
		}));
		const changed = !this.areLeafStatesEqual(previousState, nextState);
		const activePreset = this.getSettings().calendarPresets.find(entry => entry.id === nextState.presetId) ?? this.getSettings().calendarPresets[0];
		if (changed && activePreset?.surfaceType === 'multiWeek') {
			this.captureMultiWeekSurfaceScroll();
		}
		this.state = nextState;
		this.syncLeafTitle();
		await this.leaf.setViewState({
			type: CALENDAR_VIEW_TYPE,
			active: true,
			state: nextState as unknown as Record<string, unknown>,
		});
		if (changed) {
			this.clearScheduledRender();
			this.preserveScrollOnNextRender = false;
			if (this.hasActiveCalendarDragInteraction()) {
				this.pendingRenderAfterCalendarDrag = true;
				return;
			}
			this.render();
		}
	}

	private async persistLeafState(): Promise<void> {
		const nextState = this.ensureState();
		this.syncLeafTitle();
		await this.leaf.setViewState({
			type: CALENDAR_VIEW_TYPE,
			active: true,
			state: nextState as unknown as Record<string, unknown>,
		});
	}

	private async flushPendingLeafStatePersistence(): Promise<void> {
		this.clearPersistStateTimer();
		this.captureActiveCalendarScrollForRender();
		if (!this.state) return;
		await this.persistLeafState();
	}

	private normalizeState(state: Partial<CalendarLeafState> | null | undefined): CalendarLeafState {
		const settings = this.getSettings();
		return normalizeCalendarLeafState(state, {
			availablePresetIds: settings.calendarPresets.map(entry => entry.id),
			availableFilterSetIds: settings.filterSets.map(entry => entry.id),
			defaultPresetId: settings.calendarDefaultPresetId ?? settings.calendarPresets[0]?.id ?? null,
			defaultScrollHour: settings.calendarDefaultScrollHour,
			fallbackAnchorDate: localToday(),
			defaultCalendarsOpen: settings.calendarSidebarCalendarsDefaultExpanded,
			defaultTaskPoolOpen: settings.calendarSidebarTaskPoolDefaultExpanded,
			defaultFinishedTasksOpen: settings.calendarSidebarFinishedTasksDefaultExpanded,
			defaultShowAllDayLane: settings.calendarShowAllDayLane,
			defaultShowDueMarkers: settings.calendarShowDueMarkers,
			defaultShowInDayLane: true,
			defaultShowFinishedLane: true,
		});
	}

	private isSidebarSectionOpen(state: CalendarLeafState, sectionId: CalendarSidebarSectionId): boolean {
		if (sectionId === 'calendars') return state.calendarsOpen;
		if (sectionId === 'taskPool') return state.taskPoolOpen;
		return state.finishedTasksOpen;
	}

	private deriveSidebarOpenSectionOrder(
		state: Partial<CalendarLeafState> | null | undefined,
		preferredOrder: CalendarSidebarSectionId[] = this.sidebarOpenSectionOrder,
	): CalendarSidebarSectionId[] {
		const openSections = new Set<CalendarSidebarSectionId>();
		if (state?.calendarsOpen) openSections.add('calendars');
		if (state?.taskPoolOpen) openSections.add('taskPool');
		if (state?.finishedTasksOpen) openSections.add('finishedTasks');

		const order: CalendarSidebarSectionId[] = [];
		for (const sectionId of preferredOrder) {
			if (!CALENDAR_SIDEBAR_SECTION_ORDER.includes(sectionId)) continue;
			if (!openSections.has(sectionId) || order.includes(sectionId)) continue;
			order.push(sectionId);
		}
		for (const sectionId of CALENDAR_SIDEBAR_SECTION_ORDER) {
			if (!openSections.has(sectionId) || order.includes(sectionId)) continue;
			order.push(sectionId);
		}
		return order.slice(-2);
	}

	private applySidebarOpenSectionOrder(
		state: CalendarLeafState,
		order: CalendarSidebarSectionId[],
	): CalendarLeafState {
		const normalizedOrder = order
			.filter((sectionId, index) => CALENDAR_SIDEBAR_SECTION_ORDER.includes(sectionId) && order.indexOf(sectionId) === index)
			.slice(-2);
		return {
			...state,
			calendarsOpen: normalizedOrder.includes('calendars'),
			taskPoolOpen: normalizedOrder.includes('taskPool'),
			finishedTasksOpen: normalizedOrder.includes('finishedTasks'),
		};
	}

	private syncSidebarOpenSections(state: CalendarLeafState): CalendarLeafState {
		const normalizedOrder = this.deriveSidebarOpenSectionOrder(state);
		this.sidebarOpenSectionOrder = normalizedOrder;
		return this.applySidebarOpenSectionOrder(state, normalizedOrder);
	}

	private async toggleSidebarSection(sectionId: CalendarSidebarSectionId): Promise<void> {
		const state = this.ensureState();
		let nextOrder = this.deriveSidebarOpenSectionOrder(state);
		if (this.isSidebarSectionOpen(state, sectionId)) {
			nextOrder = nextOrder.filter(id => id !== sectionId);
		} else {
			nextOrder = nextOrder.filter(id => id !== sectionId);
			nextOrder.push(sectionId);
			nextOrder = nextOrder.slice(-2);
		}
		this.sidebarOpenSectionOrder = nextOrder;
		await this.updateLeafState(this.applySidebarOpenSectionOrder(state, nextOrder));
	}

	private areLeafStatesEqual(left: CalendarLeafState | null, right: CalendarLeafState | null): boolean {
		if (!left || !right) return left === right;
		return left.presetId === right.presetId
			&& left.anchorDate === right.anchorDate
			&& left.scrollMinutes === right.scrollMinutes
			&& left.filterSetId === right.filterSetId
			&& left.navigationMode === right.navigationMode
			&& left.calendarsOpen === right.calendarsOpen
			&& left.taskPoolOpen === right.taskPoolOpen
			&& left.finishedTasksOpen === right.finishedTasksOpen
			&& left.showAllDayLane === right.showAllDayLane
			&& left.showDueMarkers === right.showDueMarkers
			&& left.showInDayLane === right.showInDayLane
			&& left.showFinishedLane === right.showFinishedLane;
	}

	private renderFilterEmptyState(
		container: HTMLElement,
		activeFilter: FilterSet | null,
		filteredTaskCount: number,
		visibleItemCount: number,
	): void {
		if (!activeFilter || visibleItemCount > 0) return;
			container.createDiv({
				cls: 'operon-calendar-filter-empty-state',
				text: filteredTaskCount === 0
					? t('calendar', 'noCalendarFilterMatches')
					: t('calendar', 'noFilteredTasksVisible'),
			});
	}

	private clearPersistStateTimer(): void {
		if (!this.persistStateTimer) return;
		window.clearTimeout(this.persistStateTimer);
		this.persistStateTimer = null;
	}

	private invalidateRenderGeneration(): void {
		this.renderGeneration += 1;
	}

	private isRenderGenerationActive(generation: number): boolean {
		return generation === this.renderGeneration && this.containerEl.isConnected;
	}

	private requestRenderAnimationFrame(generation: number, callback: () => void): number {
		const frame = window.requestAnimationFrame(() => {
			this.renderAnimationFrames.delete(frame);
			if (!this.isRenderGenerationActive(generation)) return;
			callback();
		});
		this.renderAnimationFrames.add(frame);
		return frame;
	}

	private setRenderTimeout(generation: number, callback: () => void, delay: number): number {
		const timer = window.setTimeout(() => {
			this.renderTimeouts.delete(timer);
			if (!this.isRenderGenerationActive(generation)) return;
			callback();
		}, delay);
		this.renderTimeouts.add(timer);
		return timer;
	}

	private clearRenderTimers(): void {
		this.hideCalendarHoverMenu(true);
		this.sidebarSectionsLayoutCleanup?.();
		this.sidebarSectionsLayoutCleanup = null;
		this.toolbarLayoutCleanup?.();
		this.toolbarLayoutCleanup = null;
		if (this.layoutRefreshFrame !== null) {
			window.cancelAnimationFrame(this.layoutRefreshFrame);
			this.renderAnimationFrames.delete(this.layoutRefreshFrame);
			this.layoutRefreshFrame = null;
		}
		for (const frame of Array.from(this.renderAnimationFrames)) {
			window.cancelAnimationFrame(frame);
		}
		this.renderAnimationFrames.clear();
		for (const timer of Array.from(this.renderTimeouts)) {
			window.clearTimeout(timer);
		}
		this.renderTimeouts.clear();
		this.layoutRefreshCleanup?.();
		this.layoutRefreshCleanup = null;
		if (this.nowIndicatorTimer) {
			window.clearInterval(this.nowIndicatorTimer);
			this.nowIndicatorTimer = null;
		}
		this.nowIndicatorEntries = [];
	}

	private clearScheduledRender(): void {
		if (this.renderFrame !== null) {
			window.cancelAnimationFrame(this.renderFrame);
			this.renderFrame = null;
		}
	}
}
