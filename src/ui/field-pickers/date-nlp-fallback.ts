import { DateParseCandidate, DateParseContext, DatePickerLang } from './date-nlp';

interface DatePickerStrings {
	searchPlaceholder: string;
	clear: string;
	apply: string;
	manualDate: string;
	parsedFrom: (input: string) => string;
	quickSuggestions: string;
	today: string;
	tomorrow: string;
	yesterday: string;
	thisWeek: string;
	nextWeek: string;
	lastWeek: string;
	thisWeekend: string;
	nextWeekend: string;
	lastWeekend: string;
	daysAgo: (count: number) => string;
	daysFromNow: (count: number) => string;
	weeksAgo: (count: number) => string;
	weeksFromNow: (count: number) => string;
	monthsAgo: (count: number) => string;
	monthsFromNow: (count: number) => string;
	weekdayNames: string[];
	nextWeekdayLabel: (name: string) => string;
	lastWeekdayLabel: (name: string) => string;
}

const STRINGS: Record<DatePickerLang, DatePickerStrings> = {
	en: {
		searchPlaceholder: 'Type a date like next tuesday',
		clear: 'Clear',
		apply: 'Apply',
		manualDate: 'Pick a date',
		parsedFrom: input => `Parsed from "${input}"`,
		quickSuggestions: 'Suggestions',
		today: 'Today',
		tomorrow: 'Tomorrow',
		yesterday: 'Yesterday',
		thisWeek: 'This week',
		nextWeek: 'Next week',
		lastWeek: 'Last week',
		thisWeekend: 'This weekend',
		nextWeekend: 'Next weekend',
		lastWeekend: 'Last weekend',
		daysAgo: count => `${count} days ago`,
		daysFromNow: count => `${count} days from now`,
		weeksAgo: count => `${count} weeks ago`,
		weeksFromNow: count => `${count} weeks from now`,
		monthsAgo: count => `${count} months ago`,
		monthsFromNow: count => `${count} months from now`,
		weekdayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
		nextWeekdayLabel: name => `Next ${name}`,
		lastWeekdayLabel: name => `Last ${name}`,
	},
	tr: {
		searchPlaceholder: 'Gelecek sali gibi bir tarih yazin',
		clear: 'Temizle',
		apply: 'Uygula',
		manualDate: 'Tarih sec',
		parsedFrom: input => `"${input}" ifadesinden cozuldu`,
		quickSuggestions: 'Oneriler',
		today: 'Bugun',
		tomorrow: 'Yarin',
		yesterday: 'Dun',
		thisWeek: 'Bu hafta',
		nextWeek: 'Gelecek hafta',
		lastWeek: 'Gecen hafta',
		thisWeekend: 'Bu hafta sonu',
		nextWeekend: 'Gelecek hafta sonu',
		lastWeekend: 'Gecen hafta sonu',
		daysAgo: count => `${count} gun once`,
		daysFromNow: count => `${count} gun sonra`,
		weeksAgo: count => `${count} hafta once`,
		weeksFromNow: count => `${count} hafta sonra`,
		monthsAgo: count => `${count} ay once`,
		monthsFromNow: count => `${count} ay sonra`,
		weekdayNames: ['Pazar', 'Pazartesi', 'Sali', 'Carsamba', 'Persembe', 'Cuma', 'Cumartesi'],
		nextWeekdayLabel: name => `Gelecek ${name.toLowerCase()}`,
		lastWeekdayLabel: name => `Gecen ${name.toLowerCase()}`,
	},
	zh: {
		searchPlaceholder: '输入日期，例如下周二',
		clear: '清除',
		apply: '应用',
		manualDate: '选择日期',
		parsedFrom: input => `解析自「${input}」`,
		quickSuggestions: '建议',
		today: '今天',
		tomorrow: '明天',
		yesterday: '昨天',
		thisWeek: '本周',
		nextWeek: '下周',
		lastWeek: '上周',
		thisWeekend: '本周末',
		nextWeekend: '下周末',
		lastWeekend: '上周末',
		daysAgo: count => `${count} 天前`,
		daysFromNow: count => `${count} 天后`,
		weeksAgo: count => `${count} 周前`,
		weeksFromNow: count => `${count} 周后`,
		monthsAgo: count => `${count} 个月前`,
		monthsFromNow: count => `${count} 个月后`,
		weekdayNames: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
		nextWeekdayLabel: name => `下${name.replace(/^星期/, '')}`,
		lastWeekdayLabel: name => `上${name.replace(/^星期/, '')}`,
	},
};

const ENGLISH_PHRASES: Record<string, (reference: Date) => Date> = {
	today: reference => cloneDate(reference),
	tomorrow: reference => addDays(reference, 1),
	yesterday: reference => addDays(reference, -1),
	'this week': reference => startOfWeek(reference),
	'next week': reference => addDays(startOfWeek(reference), 7),
	'last week': reference => addDays(startOfWeek(reference), -7),
	'this weekend': reference => saturdayOfWeek(reference),
	'next weekend': reference => addDays(saturdayOfWeek(reference), 7),
	'last weekend': reference => addDays(saturdayOfWeek(reference), -7),
};

const CHINESE_PHRASES: Record<string, (reference: Date) => Date> = {
	'今天': reference => cloneDate(reference),
	'明天': reference => addDays(reference, 1),
	'昨天': reference => addDays(reference, -1),
	'本周': reference => startOfWeek(reference),
	'下周': reference => addDays(startOfWeek(reference), 7),
	'上周': reference => addDays(startOfWeek(reference), -7),
	'本周末': reference => saturdayOfWeek(reference),
	'下周末': reference => addDays(saturdayOfWeek(reference), 7),
	'上周末': reference => addDays(saturdayOfWeek(reference), -7),
};

const TURKISH_PHRASES: Record<string, (reference: Date) => Date> = {
	'bugun': reference => cloneDate(reference),
	'yarin': reference => addDays(reference, 1),
	'dun': reference => addDays(reference, -1),
	'bu hafta': reference => startOfWeek(reference),
	'gelecek hafta': reference => addDays(startOfWeek(reference), 7),
	'gecen hafta': reference => addDays(startOfWeek(reference), -7),
	'bu hafta sonu': reference => saturdayOfWeek(reference),
	'gelecek hafta sonu': reference => addDays(saturdayOfWeek(reference), 7),
	'gecen hafta sonu': reference => addDays(saturdayOfWeek(reference), -7),
};

const ENGLISH_WEEKDAYS = new Map<string, number>([
	['sunday', 0],
	['monday', 1],
	['tuesday', 2],
	['wednesday', 3],
	['thursday', 4],
	['friday', 5],
	['saturday', 6],
]);

const CHINESE_WEEKDAYS = new Map<string, number>([
	['星期日', 0],
	['星期天', 0],
	['周日', 0],
	['星期一', 1],
	['周一', 1],
	['星期二', 2],
	['周二', 2],
	['星期三', 3],
	['周三', 3],
	['星期四', 4],
	['周四', 4],
	['星期五', 5],
	['周五', 5],
	['星期六', 6],
	['周六', 6],
]);

const TURKISH_WEEKDAYS = new Map<string, number>([
	['pazar', 0],
	['pazartesi', 1],
	['sali', 2],
	['salı', 2],
	['carsamba', 3],
	['çarşamba', 3],
	['persembe', 4],
	['perşembe', 4],
	['cuma', 5],
	['cumartesi', 6],
]);

export function getDatePickerStrings(language: DatePickerLang): DatePickerStrings {
	return STRINGS[language];
}

export function getQuickDateCandidates(context: DateParseContext, query = ''): DateParseCandidate[] {
	const strings = STRINGS[context.language];
	const reference = context.referenceDate ?? normalizedToday();
	const lowered = normalizeInput(query);
	const base: DateParseCandidate[] = [
		buildQuickCandidate(strings.today, cloneDate(reference), context),
		buildQuickCandidate(strings.tomorrow, addDays(reference, 1), context),
		buildQuickCandidate(strings.yesterday, addDays(reference, -1), context),
		buildQuickCandidate(strings.thisWeek, startOfWeek(reference), context),
		buildQuickCandidate(strings.nextWeek, addDays(startOfWeek(reference), 7), context),
		buildQuickCandidate(strings.lastWeek, addDays(startOfWeek(reference), -7), context),
		buildQuickCandidate(strings.thisWeekend, saturdayOfWeek(reference), context),
		buildQuickCandidate(strings.nextWeekend, addDays(saturdayOfWeek(reference), 7), context),
		buildQuickCandidate(strings.lastWeekend, addDays(saturdayOfWeek(reference), -7), context),
	];

	const weekdayNames = strings.weekdayNames;
	for (let day = 0; day <= 6; day++) {
		base.push(buildQuickCandidate(strings.nextWeekdayLabel(weekdayNames[day]), nextWeekday(reference, day), context));
		base.push(buildQuickCandidate(strings.lastWeekdayLabel(weekdayNames[day]), previousWeekday(reference, day), context));
	}

	if (!lowered) return base.slice(0, 8);
	return base.filter(candidate => normalizeInput(candidate.primaryLabel).includes(lowered)).slice(0, 12);
}

export function parseFallbackDateCandidates(input: string, context: DateParseContext): DateParseCandidate[] {
	const normalized = normalizeInput(input);
	if (!normalized) return [];

	const strings = STRINGS[context.language];
	const reference = context.referenceDate ?? normalizedToday();

	const numeric = parseNumericRelativeCandidates(normalized, strings, context, reference);
	if (numeric.length > 0) return numeric;

	const absolute = parseAbsoluteDate(normalized, context);
	if (absolute) return [absolute];

	const phraseDate = parsePhraseDate(normalized, context.language, reference);
	if (phraseDate) {
		return [{
			isoDate: toIsoDate(phraseDate),
			primaryLabel: formatLongDate(phraseDate, context.language),
			secondaryLabel: strings.parsedFrom(input.trim()),
			source: 'fallback',
			confidence: 0.96,
			kind: 'nlp',
		}];
	}

	return [];
}

function parsePhraseDate(input: string, language: DatePickerLang, reference: Date): Date | null {
	const phrases = language === 'tr'
		? TURKISH_PHRASES
		: language === 'zh'
			? CHINESE_PHRASES
			: ENGLISH_PHRASES;
	const direct = phrases[input];
	if (direct) return direct(reference);

	const weekdays = language === 'tr'
		? TURKISH_WEEKDAYS
		: language === 'zh'
			? CHINESE_WEEKDAYS
			: ENGLISH_WEEKDAYS;
	const nextPrefix = language === 'tr' ? 'gelecek ' : language === 'zh' ? '下' : 'next ';
	const lastPrefix = language === 'tr' ? 'gecen ' : language === 'zh' ? '上' : 'last ';

	if (weekdays.has(input)) {
		return nextWeekday(reference, weekdays.get(input)!);
	}
	if (input.startsWith(nextPrefix)) {
		const weekday = input.slice(nextPrefix.length).trim();
		if (weekdays.has(weekday)) return nextWeekday(reference, weekdays.get(weekday)!);
	}
	if (input.startsWith(lastPrefix)) {
		const weekday = input.slice(lastPrefix.length).trim();
		if (weekdays.has(weekday)) return previousWeekday(reference, weekdays.get(weekday)!);
	}

	return null;
}

function parseNumericRelativeCandidates(
	input: string,
	strings: DatePickerStrings,
	context: DateParseContext,
	reference: Date,
): DateParseCandidate[] {
	const match = /^(\d{1,3})(?:\s+([a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]+))?$/.exec(input);
	if (!match) return [];

	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return [];
	const unitToken = match[2] ?? '';
	const includeDays = matchesUnit(unitToken, context.language, 'days');
	const includeWeeks = matchesUnit(unitToken, context.language, 'weeks');
	const includeMonths = matchesUnit(unitToken, context.language, 'months');

	const candidates: DateParseCandidate[] = [];
	if (includeDays) {
		candidates.push(buildRelativeCandidate(strings.daysFromNow(amount), addDays(reference, amount), context));
	}
	if (includeWeeks) {
		candidates.push(buildRelativeCandidate(strings.weeksFromNow(amount), addDays(reference, amount * 7), context));
	}
	if (includeMonths) {
		candidates.push(buildRelativeCandidate(strings.monthsFromNow(amount), addMonths(reference, amount), context));
	}
	if (includeDays) {
		candidates.push(buildRelativeCandidate(strings.daysAgo(amount), addDays(reference, -amount), context));
	}
	if (includeWeeks) {
		candidates.push(buildRelativeCandidate(strings.weeksAgo(amount), addDays(reference, -amount * 7), context));
	}
	if (includeMonths) {
		candidates.push(buildRelativeCandidate(strings.monthsAgo(amount), addMonths(reference, -amount), context));
	}

	return candidates;
}

function matchesUnit(token: string, language: DatePickerLang, unit: 'days' | 'weeks' | 'months'): boolean {
	if (!token) return true;
	const lowered = normalizeInput(token);
	const prefixes: Record<typeof unit, string[]> = language === 'tr'
		? {
			days: ['g', 'gu', 'gun'],
			weeks: ['h', 'ha', 'haf', 'hafta'],
			months: ['a', 'ay'],
		}
		: language === 'zh'
			? {
				days: ['天', '日'],
				weeks: ['周', '星期'],
				months: ['月'],
			}
			: {
				days: ['d', 'da', 'day', 'days'],
				weeks: ['w', 'we', 'wee', 'week', 'weeks'],
				months: ['m', 'mo', 'mon', 'month', 'months'],
			};
	return prefixes[unit].some(prefix => prefix.startsWith(lowered) || lowered.startsWith(prefix));
}

function parseAbsoluteDate(input: string, context: DateParseContext): DateParseCandidate | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
	const [year, month, day] = input.split('-').map(Number);
	const date = new Date(year, month - 1, day, 12, 0, 0, 0);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return {
		isoDate: input,
		primaryLabel: formatLongDate(date, context.language),
		secondaryLabel: input,
		source: 'fallback',
		confidence: 0.98,
		kind: 'nlp',
	};
}

function buildQuickCandidate(label: string, date: Date, context: DateParseContext): DateParseCandidate {
	return {
		isoDate: toIsoDate(date),
		primaryLabel: label,
		secondaryLabel: formatLongDate(date, context.language),
		source: 'quick',
		confidence: 0.72,
		kind: 'quick',
	};
}

function buildRelativeCandidate(label: string, date: Date, context: DateParseContext): DateParseCandidate {
	return {
		isoDate: toIsoDate(date),
		primaryLabel: label,
		secondaryLabel: formatLongDate(date, context.language),
		source: 'fallback',
		confidence: 0.9,
		kind: 'numeric-relative',
	};
}

function normalizedToday(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
}

function cloneDate(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

function addDays(date: Date, days: number): Date {
	const next = cloneDate(date);
	next.setDate(next.getDate() + days);
	return next;
}

function addMonths(date: Date, months: number): Date {
	const next = cloneDate(date);
	next.setMonth(next.getMonth() + months);
	return next;
}

function startOfWeek(date: Date): Date {
	const next = cloneDate(date);
	const dayIndex = (next.getDay() + 6) % 7;
	next.setDate(next.getDate() - dayIndex);
	return next;
}

function saturdayOfWeek(date: Date): Date {
	return addDays(startOfWeek(date), 5);
}

function nextWeekday(date: Date, weekday: number): Date {
	const next = cloneDate(date);
	const current = next.getDay();
	let diff = (weekday - current + 7) % 7;
	if (diff === 0) diff = 7;
	next.setDate(next.getDate() + diff);
	return next;
}

function previousWeekday(date: Date, weekday: number): Date {
	const next = cloneDate(date);
	const current = next.getDay();
	let diff = (current - weekday + 7) % 7;
	if (diff === 0) diff = 7;
	next.setDate(next.getDate() - diff);
	return next;
}

function toIsoDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function formatLongDate(date: Date, language: DatePickerLang): string {
	const locale = language === 'tr' ? 'tr-TR' : language === 'zh' ? 'zh-CN' : 'en-US';
	return new Intl.DateTimeFormat(locale, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	}).format(date);
}

function normalizeInput(input: string): string {
	return input
		.trim()
		.toLocaleLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\s+/g, ' ');
}
