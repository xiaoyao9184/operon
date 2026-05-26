/**
 * Priority definition model for Operon.
 * Priorities are ordered: index 0 = highest importance.
 */

export interface PriorityDefinition {
	/** Internal stable priority id used for settings-side rename matching */
	id: string;
	/** Priority label used in task fields (e.g. "highest", "high") */
	label: string;
	/** Display color for priority chips (hex) */
	color: string;
	/** Optional icon used by priority-aware task icon displays */
	priorityIcon?: string;
}

export function createPriorityId(): string {
	return `pr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function clonePriorityDefinition(priority: PriorityDefinition): PriorityDefinition {
	return { ...priority };
}

/** Default priority configuration (highest importance first) */
export const DEFAULT_PRIORITIES: PriorityDefinition[] = [
	{ id: 'pr_s', label: 'S', color: '#e41a1b' },
	{ id: 'pr_a', label: 'A', color: '#ff7124' },
	{ id: 'pr_b', label: 'B', color: '#a1b752' },
	{ id: 'pr_c', label: 'C', color: '#3f84a8' },
	{ id: 'pr_d', label: 'D', color: '#0e6175' },
	{ id: 'pr_e', label: 'E', color: '#024959' },
	{ id: 'pr_f', label: 'F', color: '#504e4e' },
];
