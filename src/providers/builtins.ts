import type { ProviderRegistration } from "./contracts.js";
import { deepseekProviderDefinition } from "./deepseek.js";
import { grokProviderDefinition } from "./grok.js";
import { openaiProviderDefinition } from "./openai.js";
import { opencodeGoProviderDefinition } from "./opencode-go.js";
import { zaiProviderDefinition } from "./zai.js";

export const BUILTIN_PROVIDER_CATALOG = createProviderCatalog([
	openaiProviderDefinition.registration,
	zaiProviderDefinition.registration,
	deepseekProviderDefinition.registration,
	opencodeGoProviderDefinition.registration,
	grokProviderDefinition.registration,
]);

export function createProviderCatalog(
	registrations: readonly ProviderRegistration[],
): readonly ProviderRegistration[] {
	const ordered = [...registrations].sort(compareRegistrations);
	assertUniqueCatalogFields(ordered);
	return Object.freeze(ordered);
}

function compareRegistrations(
	left: ProviderRegistration,
	right: ProviderRegistration,
): number {
	return (
		left.metadata.catalogOrder - right.metadata.catalogOrder ||
		left.metadata.id.localeCompare(right.metadata.id)
	);
}

function assertUniqueCatalogFields(
	registrations: readonly ProviderRegistration[],
): void {
	const ids = new Set<string>();
	const orders = new Set<number>();
	for (const registration of registrations) {
		const { id, catalogOrder } = registration.metadata;
		if (ids.has(id)) throw new Error(`Duplicate provider id: ${id}`);
		if (orders.has(catalogOrder))
			throw new Error(`Duplicate provider catalog order: ${catalogOrder}`);
		ids.add(id);
		orders.add(catalogOrder);
	}
}
