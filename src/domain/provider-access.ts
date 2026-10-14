import { API_MODEL_LIST, apiModelSections } from "./api-model-list";
import {
	AUTHOR_LABELS,
	DIRECT_MODEL_ENDPOINTS,
	directModelProvider,
} from "./browse-models";
import {
	CUSTOM_SECTION,
	isCustomConnection,
	type PublicModelConnection,
	parseModelRouteId,
} from "./model-connection";

/**
 * The provider a maker's own key connects as, or null when no listed model is
 * offered through that maker's key (DeepSeek runs only on US hosts, so a
 * DeepSeek key would send code to DeepSeek's API).
 */
export function directKeyProvider(author: string) {
	return API_MODEL_LIST.some(
		(model) => model.author === author && model.directId,
	)
		? directModelProvider(author)
		: null;
}

export function providerKeyConnection(author: string, apiKey: string) {
	if (apiKey.trim().startsWith("sk-or-"))
		return {
			provider: "openrouter" as const,
			label: "OpenRouter",
			apiKey: apiKey.trim(),
		};
	const provider = directKeyProvider(author);
	if (!provider)
		throw new Error(
			"Direct keys for this provider are not supported. Use an OpenRouter key.",
		);
	return {
		provider,
		label: AUTHOR_LABELS[author],
		apiKey: apiKey.trim(),
		...(provider === "compatible"
			? { baseUrl: DIRECT_MODEL_ENDPOINTS[author] }
			: {}),
	};
}

/** Picker sections: the curated makers, then Custom once a custom endpoint is connected. */
export function apiPickerSections(
	connections: readonly PublicModelConnection[],
): readonly string[] {
	return connections.some(isCustomConnection)
		? [...apiModelSections(), CUSTOM_SECTION]
		: apiModelSections();
}

export function providerConnections(
	author: string,
	connections: readonly PublicModelConnection[],
) {
	if (author === CUSTOM_SECTION) return connections.filter(isCustomConnection);
	return connections.filter(
		(connection) =>
			connection.provider === "openrouter" ||
			connection.provider === author ||
			(connection.provider === "compatible" &&
				connection.baseUrl === DIRECT_MODEL_ENDPOINTS[author]),
	);
}

export function selectedProviderConnection(
	available: readonly PublicModelConnection[],
	selectedRoute: string,
	chosenConnectionId?: string,
): PublicModelConnection | undefined {
	const routeConnectionId = parseModelRouteId(selectedRoute)?.connectionId;
	return (
		available.find((row) => row.id === chosenConnectionId) ??
		available.find((row) => row.id === routeConnectionId) ??
		available[0]
	);
}
