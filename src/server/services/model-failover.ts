import { API_MODEL_LIST } from "#/domain/api-model-list";
import {
	apiModelReasoning,
	connectionModels,
	type PublicModelConnection,
} from "#/domain/model-connection";
import {
	canonicalModelId,
	chosenRoute,
	decideFailover,
	type FailoverConnection,
	type FailoverDecision,
	failoverCandidates,
	failoverConnectionKind,
	type ModelRoute,
	nextTurnFailover,
	type RouteLabel,
	routeConnectionKey,
	routeKey,
	SUBSCRIPTION_KEY,
	type TurnFailover,
	turnFailover,
	turnFailoverPolicy,
} from "#/domain/model-failover";
import type { ApiTurn } from "../adapters/api-turns";
import { browseModels } from "../adapters/browse-models";
import { codexSubscriptionCatalog } from "../adapters/codex-subscription";
import { listModelConnections } from "../adapters/model-connections";
import { loadModelFailoverPreferences } from "../adapters/model-failover-preferences";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";

export { SUBSCRIPTION_LABEL } from "#/domain/model-failover";

import { SUBSCRIPTION_LABEL } from "#/domain/model-failover";

/** The ChatGPT plan's models; empty while its catalog is unreachable (often the outage itself). */
async function subscriptionConnection(
	userId: string,
): Promise<FailoverConnection | null> {
	if (!(await hasManagedCodexAuth(userId).catch(() => false))) return null;
	const models = await codexSubscriptionCatalog(userId).catch(() => []);
	return {
		key: SUBSCRIPTION_KEY,
		label: SUBSCRIPTION_LABEL,
		kind: "subscription",
		revision: "",
		models: models.map((model) => ({
			id: model.id,
			label: model.label,
			...(model.reasoning
				? { reasoning: model.reasoning.levels.map((level) => level.id) }
				: {}),
		})),
	};
}

export function apiFailoverConnections(
	connections: readonly PublicModelConnection[],
	browsed: Parameters<typeof connectionModels>[1],
): FailoverConnection[] {
	return connections.map((connection) => ({
		key: connection.id,
		label: connection.label,
		kind: failoverConnectionKind(connection),
		provider: connection.provider,
		baseUrl: connection.baseUrl,
		revision: connection.revision,
		models: connectionModels(connection, browsed).map((model) => {
			const reasoning = apiModelReasoning(connection.provider, model.id);
			return {
				id: model.id,
				label: model.label,
				...(reasoning
					? { reasoning: reasoning.levels.map((level) => level.id) }
					: {}),
			};
		}),
	}));
}

/** Every route the user could continue on right now: the ChatGPT plan and each API connection. */
export async function failoverConnections(
	userId: string,
): Promise<FailoverConnection[]> {
	const [subscription, connections] = await Promise.all([
		subscriptionConnection(userId),
		listModelConnections(userId),
	]);
	const browsed = connections.some((row) => row.provider === "openrouter")
		? await browseModels().catch(() => [])
		: [];
	return [
		...(subscription ? [subscription] : []),
		...apiFailoverConnections(connections, browsed),
	];
}

export function routeLabel(
	connections: readonly FailoverConnection[],
	route: ModelRoute,
): RouteLabel {
	const key = routeConnectionKey(route);
	const connection = connections.find((row) => row.key === key);
	const canonical = canonicalModelId(
		connection ?? {
			kind: key === SUBSCRIPTION_KEY ? "subscription" : "custom",
		},
		route.modelId,
	);
	return {
		model:
			connection?.models.find((model) => model.id === route.modelId)?.label ??
			API_MODEL_LIST.find((entry) => entry.openRouterId === canonical)?.label ??
			route.modelId,
		connection:
			connection?.label ??
			(key === SUBSCRIPTION_KEY ? SUBSCRIPTION_LABEL : "API connection"),
	};
}

export type FailoverPlan = {
	readonly decision: FailoverDecision;
	/** The route that just failed. */
	readonly failing: { route: ModelRoute; label: RouteLabel };
	readonly previous: TurnFailover | null;
};

/** What a turn whose serving route just failed for `reason` should do next. */
export async function planModelFailover(input: {
	readonly turn: ApiTurn;
	readonly evaluation: boolean;
	readonly child: boolean;
	/** Custom endpoints are unreachable from the Cloudflare executor. */
	readonly allowCustom: boolean;
}): Promise<FailoverPlan> {
	const { turn } = input;
	const previous = turnFailover(turn.failover);
	const original = chosenRoute(turn);
	const serving = previous?.route ?? original;
	const preferences = await loadModelFailoverPreferences(turn.user_id);
	const policy = turnFailoverPolicy({
		enabled: preferences.enabled,
		evaluation: input.evaluation,
		child: input.child,
	});
	const connections =
		policy === "off" ? [] : await failoverConnections(turn.user_id);
	const failing = {
		route: serving,
		label: previous?.label ?? routeLabel(connections, serving),
	};
	const candidates = failoverCandidates({
		original,
		connections,
		order: preferences.connectionOrder,
		tried: [...(previous?.tried ?? []), routeKey(original), routeKey(serving)],
		sameModelOnly: policy === "same-model",
		allowCustom: input.allowCustom,
	});
	return {
		decision: decideFailover({
			policy,
			switches: previous?.switches ?? 0,
			serving,
			candidates,
			askBeforePaid: preferences.askBeforePaid,
			canAsk: !input.child,
		}),
		failing,
		previous,
	};
}

/**
 * A turn the user explicitly continued on a fallback (the "Continue on …"
 * answer): it starts on that route, with the chosen one already tried.
 */
export async function pinnedTurnFailover(
	userId: string,
	original: ModelRoute,
	key: string,
): Promise<TurnFailover> {
	const connections = await failoverConnections(userId);
	const preferences = await loadModelFailoverPreferences(userId);
	const candidate = failoverCandidates({
		original,
		connections,
		order: preferences.connectionOrder,
		tried: [routeKey(original)],
	}).find((row) => routeKey(row.route) === key);
	if (!candidate)
		throw new Error(
			"That fallback model is no longer available. Choose a model in the composer.",
		);
	return nextTurnFailover(
		null,
		{ route: original, label: routeLabel(connections, original) },
		candidate,
	);
}
