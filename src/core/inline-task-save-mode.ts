export type InlineTaskSaveMode = 'daily-notes' | 'specific-file' | 'active-file' | 'ask-every-time';

export interface InlineTaskSaveModeSettings {
	inlineTaskSaveMode?: InlineTaskSaveMode;
	inlineTaskUseDailyNote: boolean;
}

export function resolveEffectiveInlineTaskSaveMode(
	settings: InlineTaskSaveModeSettings,
	dailyNotesAvailable: boolean,
): InlineTaskSaveMode {
	const requestedMode = settings.inlineTaskSaveMode
		?? (settings.inlineTaskUseDailyNote ? 'daily-notes' : 'specific-file');
	if (requestedMode === 'daily-notes' && !dailyNotesAvailable) return 'specific-file';
	return requestedMode;
}
