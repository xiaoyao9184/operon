import { isRetiredKeyMapping, KeyMapping } from '../types/settings';
import { IndexedTask } from '../types/fields';

export const OPERON_YAML_PROPERTY_HIDDEN_CLASS = 'operon-yaml-property-hidden';
export const OPERON_YAML_METADATA_HIDDEN_CLASS = 'operon-yaml-metadata-hidden';

function normalizePropertyName(value: string | null | undefined): string {
	return (value ?? '').trim().toLowerCase();
}

export function isOperonYamlFileTask(task: IndexedTask | null | undefined): boolean {
	return task?.primary.format === 'yaml';
}

export function getHiddenYamlPropertyNames(keyMappings: KeyMapping[]): Set<string> {
	return new Set(
		keyMappings
			.filter(mapping => !isRetiredKeyMapping(mapping.canonicalKey))
			.filter(mapping => mapping.hideInFileTaskView === true)
			.map(mapping => normalizePropertyName(mapping.visiblePropertyName || mapping.canonicalKey))
			.filter(Boolean),
	);
}

export function shouldHideYamlPropertyKey(
	propertyKey: string | null | undefined,
	hiddenPropertyNames: Set<string>,
	task: IndexedTask | null | undefined,
): boolean {
	if (!isOperonYamlFileTask(task)) return false;
	return hiddenPropertyNames.has(normalizePropertyName(propertyKey));
}

export function shouldHideYamlMetadataContainer(
	propertyKeys: Array<string | null | undefined>,
	hiddenPropertyNames: Set<string>,
	task: IndexedTask | null | undefined,
): boolean {
	if (!isOperonYamlFileTask(task)) return false;
	if (propertyKeys.length === 0) return false;
	return propertyKeys.every(key => hiddenPropertyNames.has(normalizePropertyName(key)));
}

export function applyFileTaskPropertyVisibility(
	root: ParentNode,
	task: IndexedTask | null | undefined,
	keyMappings: KeyMapping[],
): void {
	const hiddenPropertyNames = getHiddenYamlPropertyNames(keyMappings);
	const metadataContainers = Array.from(root.querySelectorAll<HTMLElement>('.metadata-container'));

	for (const container of metadataContainers) {
		const propertyEls = Array.from(container.querySelectorAll<HTMLElement>('.metadata-property'));
		const propertyKeys: Array<string | null> = [];

		for (const propertyEl of propertyEls) {
			const propertyKey = propertyEl.getAttribute('data-property-key');
			propertyKeys.push(propertyKey);
			propertyEl.classList.toggle(
				OPERON_YAML_PROPERTY_HIDDEN_CLASS,
				shouldHideYamlPropertyKey(propertyKey, hiddenPropertyNames, task),
			);
		}

		container.classList.toggle(
			OPERON_YAML_METADATA_HIDDEN_CLASS,
			shouldHideYamlMetadataContainer(propertyKeys, hiddenPropertyNames, task),
		);
	}
}
