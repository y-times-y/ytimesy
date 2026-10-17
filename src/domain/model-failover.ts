import { z } from "zod";
import { API_MODEL_LIST } from "./api-model-list";
import { type ApiTurnSettings, apiTurnSettings } from "./api-turn-settings";
import { isDevelopmentEnvironment } from "./development-environment";
import {
	directAuthor,
	isCustomConnection,
	type ModelProvider,
} from "./model-connection";
import {
	subscriptionTurnRevision,
	subscriptionTurnSettings,
} from "./subscription-turn";

/**
 * Automatic model failover: when the serving connection is down, the turn's
 * next model step continues on the next best route. Only provider-side
 * failures qualify; a request the provider rejects on its merits (invalid,
 * too long, refused) or that only the user can fix (a revoked login or key)
 * fails the same way anywhere and never moves.
 */
export type FailoverReason =
	| "outage"
	| "overloaded"
	| "rate-limited"
	| "usage-limit"
	| "timeout";

const REASON_TEXT: Record<FailoverReason, string> = {
	outage: "outage",
	overloaded: "overloaded",
	"rate-limited": "rate limited",
	"usage-limit": "usage limit reached",
	timeout: "timed out",
};

/** The transcript text a "Continue on …" answer sends. */
export const FAILOVER_CONTINUE_TEXT = "Continue on the fallback model.";

/** The Codex (ChatGPT plan) connection's key; API connections use their id. */
export const SUBSCRIPTION_KEY = "codex";

/** What serves a model step: a connection (or the subscription), its revision and a model. */
export type ModelRoute = {
	readonly connectionId: string | null;
	readonly connectionRevision: string;
	readonly modelId: string;
	readonly settings?: ApiTurnSettings;
};

export function routeConnectionKey(route: Pick<ModelRoute, "connectionId">) {
	return route.connectionId ?? SUBSCRIPTION_KEY;
}

export function routeKey(route: Pick<ModelRoute, "connectionId" | "modelId">) {
	return `${routeConnectionKey(route)}|${route.modelId}`;
}

/** Subscriptions are prepaid; keys and gateways bill the user's provider account. */
export type FailoverConnectionKind =
	| "subscription"
	| "key"
	| "gateway"
	| "custom";

export type FailoverModel = {
	readonly id: string;
	readonly label: string;
	/** Reasoning levels this route accepts; absent means none can be carried over. */
	readonly reasoning?: readonly string[];
};

export type FailoverConnection = {
	readonly key: string;
	readonly label: string;
	readonly kind: FailoverConnectionKind;
	readonly provider?: ModelProvider;
	readonly baseUrl?: string;
	/** The API connection's revision; unused for the subscription. */
	readonly revision: string;
	/** What this connection can serve now; empty when its catalog is unreachable. */
	readonly models: readonly FailoverModel[];
};

export function failoverConnectionKind(connection: {
	provider: ModelProvider;
	baseUrl: string;
}): FailoverConnectionKind {
	if (connection.provider === "openrouter") return "gateway";
	return isCustomConnection(connection) ? "custom" : "key";
}

const KIND_RANK: Record<FailoverConnectionKind, number> = {
	subscription: 0,
	key: 1,
	gateway: 2,
	custom: 3,
};

/**
 * The user's order first (keys they ranked, while those connections still
 * exist), then everything else by default: subscriptions, direct keys,
 * gateways, custom endpoints, each in the order they were added.
 */
export function orderedFailoverConnections<
	T extends Pick<FailoverConnection, "key" | "kind">,
>(connections: readonly T[], preferred: readonly string[] = []): T[] {
	const rank = (connection: T) => {
		const index = preferred.indexOf(connection.key);
		return index >= 0 ? index : preferred.length + KIND_RANK[connection.kind];
	};
	return connections
		.map((connection, index) => ({ connection, index }))
		.sort(
			(a, b) => rank(a.connection) - rank(b.connection) || a.index - b.index,
		)
		.map(({ connection }) => connection);
}

/**
 * Codex subscription slugs that are the same model as a listed API model.
 * Explicit: a slug is never matched by string similarity.
 */
export const SUBSCRIPTION_MODEL_EQUIVALENTS: Readonly<Record<string, string>> =
	{
		"gpt-6.1-sol": "openai/gpt-6.1-sol",
		"gpt-6-astra": "openai/gpt-6-astra",
		"gpt-6-luna": "openai/gpt-6-luna",
	};

export type ModelTier = "frontier" | "balanced" | "fast";

/**
 * Comparable models by tier, keyed by their OpenRouter id (the canonical id),
 * in fallback preference order. A model absent from this table only fails
 * over to itself on another connection.
 */
export const MODEL_TIERS: Readonly<Record<ModelTier, readonly string[]>> = {
	frontier: [
		"openai/gpt-6.1-sol",
		"anthropic/claude-opus-5.5",
		"google/gemini-4-argon",
		"openai/gpt-6-astra",
		"x-ai/grok-4.7",
	],
	balanced: ["anthropic/claude-sonnet-5.5", "x-ai/grok-4.6"],
	fast: [
		"openai/gpt-6-luna",
		"anthropic/claude-haiku-5.5",
		"google/gemini-3.8-flash",
		"google/gemini-3.7-flash",
	],
};

export function modelTier(canonical: string): ModelTier | null {
	for (const [tier, models] of Object.entries(MODEL_TIERS))
		if (models.includes(canonical)) return tier as ModelTier;
	return null;
}

/** The listed model a route's id names, as its OpenRouter id, or null when it is not listed. */
export function canonicalModelId(
	connection: Pick<FailoverConnection, "kind" | "provider" | "baseUrl">,
	modelId: string,
): string | null {
	switch (connection.kind) {
		case "subscription":
			return SUBSCRIPTION_MODEL_EQUIVALENTS[modelId] ?? null;
		case "gateway":
			return API_MODEL_LIST.some((entry) => entry.openRouterId === modelId)
				? modelId
				: null;
		case "key": {
			const author =
				connection.provider && connection.baseUrl
					? directAuthor({
							provider: connection.provider,
							baseUrl: connection.baseUrl,
						})
					: null;
			return (
				API_MODEL_LIST.find(
					(entry) => entry.author === author && entry.directId === modelId,
				)?.openRouterId ?? null
			);
		}
		case "custom":
			return (
				API_MODEL_LIST.find(
					(entry) =>
						entry.openRouterId === modelId || entry.directId === modelId,
				)?.openRouterId ?? null
			);
	}
}

/** Same-tier models nearest first: the same maker, then the tier's preference order. */
function closestModels(canonical: string): string[] {
	const tier = modelTier(canonical);
	if (!tier) return [];
	const author = canonical.split("/")[0];
	return MODEL_TIERS[tier]
		.filter((id) => id !== canonical)
		.map((id, index) => ({ id, index }))
		.sort(
			(a, b) =>
				Number(b.id.split("/")[0] === author) -
					Number(a.id.split("/")[0] === author) || a.index - b.index,
		)
		.map(({ id }) => id);
}

export type FailoverCandidate = {
	readonly route: ModelRoute;
	readonly connectionKey: string;
	readonly connectionLabel: string;
	readonly modelLabel: string;
	/** Billed to the user's own provider account rather than a subscription. */
	readonly paid: boolean;
	/** The user's chosen model, on another connection. */
	readonly sameModel: boolean;
};

/** The reasoning level the user chose for the original route, if any. */
function chosenReasoning(route: ModelRoute) {
	if (route.connectionId === null)
		return subscriptionTurnSettings(route.connectionRevision)?.reasoning;
	return route.settings?.reasoning;
}

function candidateRoute(
	connection: FailoverConnection,
	model: FailoverModel,
	reasoning: string | undefined,
): ModelRoute {
	const kept =
		reasoning && model.reasoning?.includes(reasoning) ? reasoning : undefined;
	if (connection.kind === "subscription")
		return {
			connectionId: null,
			connectionRevision: subscriptionTurnRevision(kept, false),
			modelId: model.id,
		};
	// A faster (pricier) speed is never carried to a fallback.
	return {
		connectionId: connection.key,
		connectionRevision: connection.revision,
		modelId: model.id,
		settings: kept ? { reasoning: kept } : {},
	};
}

/**
 * Where a turn may continue, best first: the user's model through their other
 * connections, then the closest same-tier model on any connection. Routes
 * already tried this turn are never offered again, so a turn cannot loop.
 */
export function failoverCandidates(input: {
	readonly original: ModelRoute;
	readonly connections: readonly FailoverConnection[];
	readonly order?: readonly string[];
	readonly tried: readonly string[];
	readonly sameModelOnly?: boolean;
	/** Custom endpoints are unreachable from the Cloudflare executor. */
	readonly allowCustom?: boolean;
}): FailoverCandidate[] {
	const originalKey = routeConnectionKey(input.original);
	const originalConnection =
		input.connections.find((row) => row.key === originalKey) ??
		(originalKey === SUBSCRIPTION_KEY
			? { kind: "subscription" as const }
			: null);
	const canonical = originalConnection
		? canonicalModelId(originalConnection, input.original.modelId)
		: null;
	const connections = orderedFailoverConnections(
		input.connections.filter(
			(row) => row.kind !== "custom" || input.allowCustom !== false,
		),
		input.order,
	);
	const reasoning = chosenReasoning(input.original);
	const tried = new Set(input.tried);
	const candidates: FailoverCandidate[] = [];
	const offer = (wanted: string | null, sameModel: boolean) => {
		for (const connection of connections)
			for (const model of connection.models) {
				const matches = wanted
					? canonicalModelId(connection, model.id) === wanted
					: connection.key === originalKey &&
						model.id === input.original.modelId;
				if (!matches) continue;
				const route = candidateRoute(connection, model, reasoning);
				const key = routeKey(route);
				if (tried.has(key)) continue;
				tried.add(key);
				candidates.push({
					route,
					connectionKey: connection.key,
					connectionLabel: connection.label,
					modelLabel: model.label,
					paid: connection.kind !== "subscription",
					sameModel,
				});
			}
	};
	offer(canonical, true);
	if (!input.sameModelOnly && canonical)
		for (const closest of closestModels(canonical)) offer(closest, false);
	return candidates;
}

/** At most this many switches per turn; then the turn fails, listing what was tried. */
export const MAX_TURN_FAILOVERS = 3;

export type FailoverPolicy = "any-model" | "same-model" | "off";

/**
 * Benchmarks stay pinned to their model and connection, so their scores mean
 * something. Child agents may move only to the same model on another
 * connection: their parent chose that model for the task.
 */
export function turnFailoverPolicy(input: {
	readonly enabled: boolean;
	readonly evaluation: boolean;
	readonly child: boolean;
}): FailoverPolicy {
	if (!input.enabled || input.evaluation) return "off";
	return input.child ? "same-model" : "any-model";
}

export type FailoverDecision =
	| { readonly kind: "switch"; readonly candidate: FailoverCandidate }
	| { readonly kind: "ask"; readonly candidate: FailoverCandidate }
	| { readonly kind: "stop" };

export function decideFailover(input: {
	readonly policy: FailoverPolicy;
	readonly switches: number;
	readonly serving: ModelRoute;
	readonly candidates: readonly FailoverCandidate[];
	readonly askBeforePaid: boolean;
	/** Someone is there to answer a question (a root chat, not a child agent). */
	readonly canAsk: boolean;
}): FailoverDecision {
	if (input.policy === "off" || input.switches >= MAX_TURN_FAILOVERS)
		return { kind: "stop" };
	const candidate = input.candidates.find(
		(row) => input.policy === "any-model" || row.sameModel,
	);
	if (!candidate) return { kind: "stop" };
	// Moving from a prepaid subscription onto the user's own bill.
	if (
		input.askBeforePaid &&
		candidate.paid &&
		input.serving.connectionId === null
	)
		return input.canAsk ? { kind: "ask", candidate } : { kind: "stop" };
	return { kind: "switch", candidate };
}

export type RouteLabel = {
	readonly model: string;
	readonly connection: string;
};

/** A turn's failover state: the route now serving it and every route it tried. */
export type TurnFailover = {
	readonly route: ModelRoute;
	readonly label: RouteLabel;
	readonly tried: readonly string[];
	readonly triedLabels: readonly string[];
	readonly switches: number;
};

const routeSchema = z.object({
	connectionId: z.string().nullable(),
	connectionRevision: z.string().min(1),
	modelId: z.string().min(1).max(512),
	settings: z.unknown().optional(),
});
const turnFailoverSchema = z.object({
	route: routeSchema,
	label: z.object({ model: z.string(), connection: z.string() }),
	tried: z.array(z.string()).max(32),
	triedLabels: z.array(z.string()).max(32),
	switches: z.number().int().min(0),
});

/** A stored failover column, or null when absent or unreadable (the turn then uses its own route). */
export function turnFailover(value: unknown): TurnFailover | null {
	const parsed = turnFailoverSchema.safeParse(value);
	if (!parsed.success) return null;
	const { settings, ...route } = parsed.data.route;
	return {
		...parsed.data,
		route: { ...route, settings: apiTurnSettings(settings) },
	};
}

type TurnRouteFields = {
	readonly connection_id: string | null;
	readonly connection_revision: string;
	readonly model_id: string;
	readonly settings?: unknown;
	readonly failover?: unknown;
};

/** The route the user chose for this turn. */
export function chosenRoute(turn: TurnRouteFields): ModelRoute {
	return {
		connectionId: turn.connection_id,
		connectionRevision: turn.connection_revision,
		modelId: turn.model_id,
		settings: apiTurnSettings(turn.settings),
	};
}

/** The route serving this turn's next step: its fallback once it failed over (sticky for the turn). */
export function servingRoute(turn: TurnRouteFields): ModelRoute {
	return turnFailover(turn.failover)?.route ?? chosenRoute(turn);
}

/** The state after moving to `candidate`; the route that just failed stays tried. */
export function nextTurnFailover(
	previous: TurnFailover | null,
	failing: { route: ModelRoute; label: RouteLabel },
	candidate: FailoverCandidate,
): TurnFailover {
	const label = {
		model: candidate.modelLabel,
		connection: candidate.connectionLabel,
	};
	const tried = [...(previous?.tried ?? [])];
	const triedLabels = [...(previous?.triedLabels ?? [])];
	for (const [key, text] of [
		[routeKey(failing.route), routeLabelText(failing.label)],
		[routeKey(candidate.route), routeLabelText(label)],
	]) {
		if (tried.includes(key)) continue;
		tried.push(key);
		triedLabels.push(text);
	}
	return {
		route: candidate.route,
		label,
		tried,
		triedLabels,
		switches: (previous?.switches ?? 0) + 1,
	};
}

export function routeLabelText(label: RouteLabel) {
	return label.model === label.connection
		? label.model
		: `${label.model} via ${label.connection}`;
}

export function failoverNotice(
	from: RouteLabel,
	to: RouteLabel,
	reason: FailoverReason,
) {
	return `${from.connection} is unavailable (${REASON_TEXT[reason]}); continued on ${routeLabelText(to)}.`;
}

export function failoverQuestion(
	from: RouteLabel,
	to: RouteLabel,
	reason: FailoverReason,
) {
	return `${from.connection} is unavailable (${REASON_TEXT[reason]}). Continuing on ${routeLabelText(to)} bills your API key, and you asked to be asked first.`;
}

/** Appended to the turn's failure once it had moved at least once. */
export function failoverExhaustedDetail(failover: TurnFailover | null) {
	return failover && failover.triedLabels.length > 1
		? ` Automatic failover tried: ${failover.triedLabels.join(", ")}.`
		: "";
}

/** The runtime note the next model reads after a switch; its earlier reasoning is gone. */
export function failoverRuntimeNote(
	from: RouteLabel,
	to: RouteLabel,
	reason: FailoverReason,
) {
	return `Runtime model switch: ${routeLabelText(from)} became unavailable (${REASON_TEXT[reason]}), so this same turn continues on ${routeLabelText(to)}. The history above is the conversation so far; the previous model's private reasoning is not available. Its last response may have been cut off: inspect the working tree and command state before repeating any change. This note is runtime status, not a new user request.`;
}

/**
 * Development only: `YTIMESY_DEV_FORCE_MODEL_OUTAGE=<connection>[@<step>]`
 * makes that connection ("codex" or an API connection id) answer HTTP 503
 * from that durable step on (from the first step without one). Only in
 * development (see isDevelopmentEnvironment), whatever the variable says.
 */
export function forcedDevelopmentOutage(
	env: {
		readonly YTIMESY_DEV_FORCE_MODEL_OUTAGE?: string;
		readonly YTIMESY_ENVIRONMENT?: string;
	},
	connectionKey: string,
	step: number,
): boolean {
	const value = env.YTIMESY_DEV_FORCE_MODEL_OUTAGE?.trim();
	if (!value || !isDevelopmentEnvironment(env)) return false;
	const [key, from] = value.split("@");
	const first = from ? Number.parseInt(from, 10) : 1;
	return key === connectionKey && Number.isFinite(first) && step >= first;
}
