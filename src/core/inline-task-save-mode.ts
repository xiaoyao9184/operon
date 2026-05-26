export type InlineTaskSaveMode = 'daily-notes' | 'specific-file';

export interface InlineTaskSaveModeSettings {
	inlineTaskUseDailyNote: boolean;
}

export function resolveEffectiveInlineTaskSaveMode(
	settings: InlineTaskSaveModeSettings,
	dailyNotesAvailable: boolean,
): InlineTaskSaveMode {
	return settings.inlineTaskUseDailyNote && dailyNotesAvailable
		? 'daily-notes'
		: 'specific-file';
}
