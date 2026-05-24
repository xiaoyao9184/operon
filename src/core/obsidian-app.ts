import { Editor, App } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { isRecord, isUnknownFunction } from './unknown-value';

export function getAppLocale(app: App | null | undefined): string | undefined {
	if (!app) return undefined;
	const locale = (app as App & { locale?: unknown }).locale;
	return typeof locale === 'string' ? locale : undefined;
}

export function getWindowApp(ownerWindow: Window = window): App | undefined {
	const app = (ownerWindow as Window & { app?: unknown }).app;
	return isRecord(app) ? app as unknown as App : undefined;
}

export function getEditorViewFromEditor(editor: Editor): EditorView | null {
	const cm = (editor as Editor & { cm?: unknown }).cm;
	return cm instanceof EditorView ? cm : null;
}

export function getCommunityPlugin(app: App | undefined, pluginId: string): unknown {
	if (!app) return null;
	const pluginsHost = (app as App & { plugins?: unknown }).plugins;
	if (!isRecord(pluginsHost)) return null;
	if (isUnknownFunction(pluginsHost.getPlugin)) {
		return pluginsHost.getPlugin(pluginId);
	}
	const plugins = pluginsHost.plugins;
	return isRecord(plugins) ? plugins[pluginId] : null;
}

export function getInternalPlugin(app: App, pluginId: string): unknown {
	const internalPlugins = (app as App & { internalPlugins?: unknown }).internalPlugins;
	if (!isRecord(internalPlugins)) return null;
	const plugins = internalPlugins.plugins;
	const plugin = isRecord(plugins) ? plugins[pluginId] : null;
	if (plugin) return plugin;
	return isUnknownFunction(internalPlugins.getPluginById)
		? internalPlugins.getPluginById(pluginId)
		: null;
}

export function isPluginEnabled(plugin: unknown): boolean {
	return isRecord(plugin) && plugin.enabled === true;
}

export function isDailyNotesCoreAvailable(app: App): boolean {
	return isPluginEnabled(getInternalPlugin(app, 'daily-notes'));
}
