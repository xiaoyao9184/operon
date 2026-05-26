import { setIcon } from 'obsidian';
import {
	getTaskColorSourceIcon,
	getTaskColorSourceLabel,
	type TaskColorSource,
} from '../core/task-color-source';

const MENU_CLEANUPS = new WeakMap<HTMLElement, () => void>();

interface TaskColorSourceSelectMenuOptions<TSource extends TaskColorSource> {
	sources: readonly TSource[];
	currentSource: TSource;
	onSelect: (source: TSource) => void | Promise<void>;
}

export function renderTaskColorSourceSelectButton(buttonEl: HTMLButtonElement, source: TaskColorSource): void {
	buttonEl.empty();
	buttonEl.addClass('operon-task-color-source-select-button');
	const iconEl = buttonEl.createSpan('operon-task-color-source-select-icon');
	setIcon(iconEl, getTaskColorSourceIcon(source));
	buttonEl.createSpan({
		cls: 'operon-task-color-source-select-label',
		text: getTaskColorSourceLabel(source),
	});
	const chevronEl = buttonEl.createSpan('operon-task-color-source-select-chevron');
	setIcon(chevronEl, 'chevron-down');
}

export function showTaskColorSourceSelectMenu<TSource extends TaskColorSource>(
	anchorEl: HTMLElement,
	options: TaskColorSourceSelectMenuOptions<TSource>,
): void {
	const ownerDocument = anchorEl.ownerDocument;
	const ownerWindow = ownerDocument.defaultView ?? window;
	closeTaskColorSourceSelectMenus(ownerDocument);

	const menuEl = ownerDocument.body.createDiv('operon-task-color-source-menu');
	menuEl.setAttr('role', 'menu');
	menuEl.addClass('is-positioning');

	const itemButtons: HTMLButtonElement[] = [];
	for (const source of options.sources) {
		const itemButton = menuEl.createEl('button', {
			cls: 'operon-task-color-source-menu-item',
			attr: {
				type: 'button',
				role: 'menuitemradio',
				'aria-checked': String(source === options.currentSource),
			},
		});
		itemButton.classList.toggle('is-selected', source === options.currentSource);
		const iconEl = itemButton.createSpan('operon-task-color-source-menu-item-icon');
		setIcon(iconEl, getTaskColorSourceIcon(source));
		itemButton.createSpan({
			cls: 'operon-task-color-source-menu-item-label',
			text: getTaskColorSourceLabel(source),
		});
		const selectedIconEl = itemButton.createSpan('operon-task-color-source-menu-item-selected-icon');
		if (source === options.currentSource) {
			setIcon(selectedIconEl, 'check');
		}
		itemButton.addEventListener('click', (event) => {
			event.preventDefault();
			closeMenu();
			void options.onSelect(source);
		});
		itemButtons.push(itemButton);
	}

	const closeMenu = (): void => {
		ownerDocument.removeEventListener('pointerdown', onDocumentPointerDown, true);
		ownerDocument.removeEventListener('keydown', onDocumentKeyDown, true);
		ownerWindow.removeEventListener('resize', closeMenu, true);
		ownerWindow.removeEventListener('scroll', closeMenu, true);
		MENU_CLEANUPS.delete(menuEl);
		menuEl.remove();
	};
	MENU_CLEANUPS.set(menuEl, closeMenu);

	const focusItem = (delta: number): void => {
		if (itemButtons.length === 0) return;
		const activeIndex = itemButtons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
		const currentIndex = activeIndex >= 0
			? activeIndex
			: Math.max(0, itemButtons.findIndex(button => button.classList.contains('is-selected')));
		const nextIndex = (currentIndex + delta + itemButtons.length) % itemButtons.length;
		itemButtons[nextIndex]?.focus();
	};

	function onDocumentPointerDown(event: PointerEvent): void {
		const target = event.target as Node | null;
		if (target && (menuEl.contains(target) || anchorEl.contains(target))) return;
		closeMenu();
	}

	function onDocumentKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeMenu();
			anchorEl.focus();
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			focusItem(1);
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			focusItem(-1);
		}
	}

	positionTaskColorSourceMenu(anchorEl, menuEl, ownerWindow);
	ownerDocument.addEventListener('pointerdown', onDocumentPointerDown, true);
	ownerDocument.addEventListener('keydown', onDocumentKeyDown, true);
	ownerWindow.addEventListener('resize', closeMenu, true);
	ownerWindow.addEventListener('scroll', closeMenu, true);
	const selectedButton = itemButtons.find(button => button.classList.contains('is-selected')) ?? itemButtons[0];
	selectedButton?.focus();
}

function closeTaskColorSourceSelectMenus(ownerDocument: Document): void {
	for (const menuEl of Array.from(ownerDocument.querySelectorAll<HTMLElement>('.operon-task-color-source-menu'))) {
		const cleanup = MENU_CLEANUPS.get(menuEl);
		if (cleanup) {
			cleanup();
		} else {
			menuEl.remove();
		}
	}
}

function positionTaskColorSourceMenu(anchorEl: HTMLElement, menuEl: HTMLElement, ownerWindow: Window): void {
	const anchorRect = anchorEl.getBoundingClientRect();
	const viewportWidth = ownerWindow.innerWidth;
	const viewportHeight = ownerWindow.innerHeight;
	const margin = 8;
	menuEl.setCssProps({
		'--operon-task-color-source-menu-min-width': `${Math.max(220, Math.round(anchorRect.width))}px`,
	});

	const menuRect = menuEl.getBoundingClientRect();
	const belowTop = anchorRect.bottom + 6;
	const aboveTop = anchorRect.top - menuRect.height - 6;
	const top = belowTop + menuRect.height <= viewportHeight - margin
		? belowTop
		: Math.max(margin, aboveTop);
	const left = Math.max(
		margin,
		Math.min(anchorRect.left, viewportWidth - menuRect.width - margin),
	);
	menuEl.setCssProps({
		'--operon-task-color-source-menu-left': `${Math.round(left)}px`,
		'--operon-task-color-source-menu-top': `${Math.round(top)}px`,
	});
	menuEl.removeClass('is-positioning');
}
