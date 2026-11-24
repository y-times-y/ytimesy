import { API_MODEL_LIST } from "#/domain/api-model-list";
import {
	CLAUDE_CODE_KEY,
	CLAUDE_CODE_LABEL,
	CLAUDE_CODE_MODELS,
	claudeSubscriptionEnabled,
} from "#/domain/claude-code-route";
import {
	apiModelReasoning,
	connectionModels,
	type PublicModelConnection,
} from "#/domain/model-connection";
import {
	canonicalModelId,
	chosenRoute,
	decideFailover,
	excludedFailoverConnections,
	type FailoverConnection,
	type FailoverDecision,
	type FailoverReason,
	failoverCandidates,
	failoverConnectionKind,
	type ModelRoute,
	nextTurnFailover,
	prepaidKind,
	type RouteLabel,
	routeConnectionKey,
	routeKey,
	SUBSCRIPTION_KEY,
	stickyFallbackKey,
	type TurnFailover,
	turnFailover,
	turnFailoverPolicy,
} from "#/domain/model-failover";
import type { ApiTurn } from "../adapters/api-turns";
import { browseModels } from "../adapters/browse-models";
import { hasClaudeSubscription } from "../adapters/claude-subscription";
import { codexSubscriptionCatalog } from "../adapters/codex-subscription";
import { listModelConnections } from "../adapters/model-connections";
import { loadModelFailoverPreferences } from "../adapters/model-failover-preferences";
import {
	lastSettledTurnFailover,
	planSpentUntil,
} from "../adapters/plan-spent";
import {
	claudeCodeYSquaredAvailable,
	isYSquaredSession,
} from "../adapters/y-mode";
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

/** The Claude subscription (Claude Code) when it is switched on and connected. */
async function claudeCodeConnection(
	userId: string,
): Promise<FailoverConnection | null> {
	if (
		!claudeSubscriptionEnabled() ||
		!(await hasClaudeSubscription(userId).catch(() => false))
	)
		return null;
	return {
		key: CLAUDE_CODE_KEY,
		label: CLAUDE_CODE_LABEL,
		kind: "subscription",
		revision: "",
		models: CLAUDE_CODE_MODELS.map((model) => ({
			id: model.id,
			label: model.label,
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
		// A subscription waiting for the user to sign in again serves nothing.
		models: (connection.subscription &&
		connection.subscription.status !== "ready"
			? []
			: connectionModels(connection, browsed)
		).map((model) => {
			const reasoning = apiModelReasoning(
				connection.provider,
				model.id,
				connection.baseUrl,
			);
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
	const [subscription, claudeCode, connections] = await Promise.all([
		subscriptionConnection(userId),
		claudeCodeConnection(userId),
		listModelConnections(userId),
	]);
	const browsed = connections.some((row) => row.provider === "openrouter")
		? await browseModels().catch(() => [])
		: [];
	return [
		...(subscription ? [subscription] : []),
		...(claudeCode ? [claudeCode] : []),
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
			kind:
				key === SUBSCRIPTION_KEY || key === CLAUDE_CODE_KEY
					? "subscription"
					: "custom",
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
			(key === SUBSCRIPTION_KEY
				? SUBSCRIPTION_LABEL
				: key === CLAUDE_CODE_KEY
					? CLAUDE_CODE_LABEL
					: "API connection"),
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
	readonly reason: FailoverReason;
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
		reason: input.reason,
	});
	const connections =
		policy === "off" ? [] : await failoverConnections(turn.user_id);
	const failing = {
		route: serving,
		label: previous?.label ?? routeLabel(connections, serving),
	};
	// Y² has no machine for Claude Code: it is a fallback for Y² only when
	// the user has a Claude runner box.
	const fallbackConnections =
		connections.some((row) => row.key === CLAUDE_CODE_KEY) &&
		(await isYSquaredSession(turn.user_id, turn.session_id).catch(
			() => false,
		)) &&
		!(await claudeCodeYSquaredAvailable(turn.user_id, turn.session_id).catch(
			() => false,
		))
			? connections.filter((row) => row.key !== CLAUDE_CODE_KEY)
			: connections;
	const candidates = failoverCandidates({
		original,
		connections: fallbackConnections,
		order: preferences.connectionOrder,
		tried: [...(previous?.tried ?? []), routeKey(original), routeKey(serving)],
		excludedConnections: excludedFailoverConnections(
			previous,
			serving,
			input.reason,
		),
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
			servingPrepaid:
				serving.connectionId === null ||
				prepaidKind(
					connections.find((row) => row.key === serving.connectionId)?.kind ??
						"key",
				),
			reason: input.reason,
			fallbackHops: previous?.fallbackHops ?? 0,
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

/**
 * A new turn of a chat whose last turn moved off this route because its
 * plan ran out: while that plan is still spent, the turn starts on the same
 * fallback (stickyFallbackKey), with no failed request and no repeated
 * "continued on …" line. Undefined otherwise, or on any doubt: the turn then
 * starts on its route and fails over inside itself as before.
 */
export async function stickyTurnFailover(
	userId: string,
	sessionId: string,
	original: ModelRoute,
): Promise<TurnFailover | undefined> {
	try {
		const preferences = await loadModelFailoverPreferences(userId);
		if (!preferences.enabled) return undefined;
		const [spentUntil, previous] = await Promise.all([
			planSpentUntil(userId, original),
			lastSettledTurnFailover(sessionId),
		]);
		const key = stickyFallbackKey({
			enabled: preferences.enabled,
			original,
			previous: turnFailover(previous),
			spentUntil,
			now: Date.now(),
		});
		if (!key) return undefined;
		const failover = await pinnedTurnFailover(userId, original, key);
		console.info(
			JSON.stringify({ event: "turn.started_on_fallback", sessionId }),
		);
		return failover;
	} catch {
		return undefined;
	}
}
