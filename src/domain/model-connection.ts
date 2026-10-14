import { z } from "zod";
import { API_MODEL_LIST } from "./api-model-list";
import { type BrowseModel, DIRECT_MODEL_ENDPOINTS } from "./browse-models";

export const modelProvider = z.enum([
	"openai",
	"anthropic",
	"google",
	"openrouter",
	"compatible",
]);
export type ModelProvider = z.infer<typeof modelProvider>;
export const MODEL_PROVIDERS: Record<
	ModelProvider,
	{ label: string; baseUrl: string | null }
> = {
	openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
	anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
	google: {
		label: "Google Gemini",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	},
	openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
	compatible: { label: "OpenAI-compatible endpoint", baseUrl: null },
};

/** True when the connection talks to its provider's own API, not a proxy or custom host. */
export function officialProviderEndpoint(connection: {
	provider: ModelProvider;
	baseUrl: string;
}): boolean {
	const official = MODEL_PROVIDERS[connection.provider]?.baseUrl;
	if (!official || !connection.baseUrl) return false;
	try {
		return new URL(connection.baseUrl).origin === new URL(official).origin;
	} catch {
		return false;
	}
}

export function publicModelEndpoint(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.port && url.port !== "443")
	) {
		throw new Error(
			"Use a public HTTPS base URL without credentials, query parameters, or a custom port.",
		);
	}
	return url.href.replace(/\/+$/, "");
}

export const modelConnectionInput = z
	.object({
		id: z.uuid().optional(),
		provider: modelProvider,
		label: z.string().trim().min(1).max(80),
		apiKey: z.string().trim().min(8).max(4096),
		baseUrl: z.string().trim().max(2048).optional(),
	})
	.strict()
	.transform((input) => ({
		...input,
		baseUrl: publicModelEndpoint(
			MODEL_PROVIDERS[input.provider].baseUrl ?? input.baseUrl ?? "",
		),
	}));

export type ConnectedModel = {
	readonly id: string;
	readonly label: string;
	readonly toolStreamingVerified: boolean;
	readonly contextWindow?: number;
};
export type PublicModelConnection = {
	readonly id: string;
	readonly provider: ModelProvider;
	readonly label: string;
	readonly baseUrl: string;
	readonly models: readonly ConnectedModel[];
	readonly revision: string;
};

type ApiModelReasoning = {
	readonly levels: readonly [
		{ id: string; label: string },
		...{ id: string; label: string }[],
	];
	readonly defaultLevelId: string;
};

const reasoningLabels: Record<string, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/** Effort levels the API runtime sends, per model family; null when none apply. */
export function apiModelReasoning(
	provider: ModelProvider,
	modelId: string,
): ApiModelReasoning | null {
	const family = provider === "openrouter" ? modelId.split("/")[0] : provider;
	const ids =
		family === "openai"
			? ["low", "medium", "high", "xhigh"]
			: family === "anthropic"
				? ["low", "medium", "high", "xhigh", "max"]
				: null;
	if (!ids) return null;
	const [first, ...rest] = ids.map((id) => ({
		id,
		label: reasoningLabels[id] ?? id,
	}));
	return { levels: [first, ...rest], defaultLevelId: "medium" };
}

export function modelRouteId(connectionId: string, modelId: string): string {
	return `api/${connectionId}/${encodeURIComponent(modelId)}`;
}

export function availableConnectionModels(
	connections: readonly PublicModelConnection[],
	browseModels: readonly BrowseModel[],
) {
	return connections.flatMap((connection) =>
		connectionModels(connection, browseModels).map((model) => {
			const reasoning = apiModelReasoning(connection.provider, model.id);
			return {
				id: modelRouteId(connection.id, model.id),
				label: `${model.label} · ${connection.label}`,
				...(reasoning ? { reasoning } : {}),
			};
		}),
	);
}

/** The maker whose own key this connection is, or null for a gateway or unknown host. */
function directAuthor(connection: PublicModelConnection): string | null {
	if (connection.provider === "compatible")
		return (
			Object.entries(DIRECT_MODEL_ENDPOINTS).find(
				([, endpoint]) => endpoint === connection.baseUrl,
			)?.[0] ?? null
		);
	return connection.provider === "openrouter" ? null : connection.provider;
}

/**
 * The listed models this connection serves, in list order. Only API_MODEL_LIST
 * decides what is offered; the connection's catalog (and, for OpenRouter, the
 * current public catalog) only confirms the key can use an entry.
 */
export function connectionModels(
	connection: PublicModelConnection,
	browseModels: readonly BrowseModel[],
): readonly ConnectedModel[] {
	const saved = new Map(connection.models.map((model) => [model.id, model]));
	const browsed = new Map(browseModels.map((model) => [model.id, model]));
	const author = directAuthor(connection);
	return API_MODEL_LIST.flatMap((entry) => {
		const id =
			connection.provider === "openrouter"
				? entry.openRouterId
				: entry.author === author
					? entry.directId
					: undefined;
		if (!id) return [];
		const offered =
			saved.has(id) ||
			(connection.provider === "openrouter" && browsed.has(id));
		if (!offered) return [];
		return [
			{
				id,
				label: entry.label,
				toolStreamingVerified: saved.get(id)?.toolStreamingVerified ?? false,
				...((browsed.get(id)?.contextWindow ?? saved.get(id)?.contextWindow)
					? {
							contextWindow:
								browsed.get(id)?.contextWindow ?? saved.get(id)?.contextWindow,
						}
					: {}),
			},
		];
	});
}

export function parseModelRouteId(
	value: string,
): { connectionId: string; modelId: string } | null {
	const match = /^api\/([^/]+)\/(.+)$/.exec(value);
	if (!match || !z.uuid().safeParse(match[1]).success) return null;
	try {
		const modelId = decodeURIComponent(match[2]);
		return modelId.length > 0 && modelId.length <= 512
			? { connectionId: match[1], modelId }
			: null;
	} catch {
		return null;
	}
}
