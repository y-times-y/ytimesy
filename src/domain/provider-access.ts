import {
	API_MODEL_LIST,
	apiModelSections,
	OFFERED_API_MODELS,
} from "./api-model-list";
import {
	AUTHOR_LABELS,
	DIRECT_MODEL_ENDPOINTS,
	directModelProvider,
} from "./browse-models";
import {
	CUSTOM_SECTION,
	directAuthor,
	isCustomConnection,
	type ModelProvider,
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
	const serving = connections.filter(
		(connection) =>
			connection.provider === "openrouter" ||
			connection.provider === author ||
			(connection.provider === "compatible" &&
				connection.baseUrl === DIRECT_MODEL_ENDPOINTS[author]),
	);
	// A prepaid subscription (SuperGrok) comes first: it costs nothing extra.
	return [
		...serving.filter((connection) => connection.subscription),
		...serving.filter((connection) => !connection.subscription),
	];
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

/** A provider a key can be added for in Settings > Agents > API keys. */
export type KeyProviderChoice = {
	/** A catalog maker (API_MODEL_LIST author), "openrouter" or "custom". */
	readonly id: string;
	readonly label: string;
	/** What the key unlocks, for the choice's tooltip. */
	readonly hint: string;
};

export const OPENROUTER_CHOICE = "openrouter";
export const CUSTOM_CHOICE = CUSTOM_SECTION;

/**
 * Every catalog maker whose own key unlocks a listed model (in list order),
 * then OpenRouter, which unlocks every maker, then a custom endpoint. Derived
 * from API_MODEL_LIST, so a maker appears here once its direct ids are listed
 * and its API is one we call (directModelProvider).
 */
export function keyProviderChoices(): readonly KeyProviderChoice[] {
	const makers = apiModelSections().flatMap((author) =>
		directKeyProvider(author)
			? [
					{
						id: author,
						label: AUTHOR_LABELS[author] ?? author,
						hint: `Unlocks ${OFFERED_API_MODELS.filter(
							(model) => model.author === author && model.directId,
						)
							.map((model) => model.label)
							.join(", ")}`,
					},
				]
			: [],
	);
	return [
		...makers,
		{
			id: OPENROUTER_CHOICE,
			label: "OpenRouter",
			hint: "Unlocks every listed model from every provider",
		},
		{
			id: CUSTOM_CHOICE,
			label: "Custom endpoint",
			hint: "Your OpenAI-compatible gateway or self-hosted models; they appear under Custom",
		},
	];
}

/** The connection to save for a key added under a Settings choice. */
export function keyChoiceConnection(
	choice: string,
	input: { label: string; apiKey: string; baseUrl: string },
) {
	const apiKey = input.apiKey.trim();
	const base =
		choice === OPENROUTER_CHOICE
			? { provider: "openrouter" as const, label: "OpenRouter", apiKey }
			: choice === CUSTOM_CHOICE
				? {
						provider: "compatible" as const,
						label: "Custom endpoint",
						apiKey,
						baseUrl: input.baseUrl.trim(),
					}
				: providerKeyConnection(choice, apiKey);
	return { ...base, label: input.label.trim() || base.label };
}

/** The Settings choice a saved connection belongs to. */
export function connectionKeyChoice(connection: {
	provider: ModelProvider;
	baseUrl: string;
}): string {
	if (connection.provider === "openrouter") return OPENROUTER_CHOICE;
	if (isCustomConnection(connection)) return CUSTOM_CHOICE;
	return directAuthor(connection) ?? CUSTOM_CHOICE;
}

/** The display name of a Settings choice. */
export function keyChoiceLabel(choice: string): string {
	return (
		keyProviderChoices().find((row) => row.id === choice)?.label ??
		AUTHOR_LABELS[choice] ??
		choice
	);
}
