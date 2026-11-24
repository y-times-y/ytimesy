import {
	CLAUDE_CODE_LABEL,
	claudeCodeTurnRevision,
} from "#/domain/claude-code-route";
import {
	type ListedModel,
	listedModelSupportsFastMode,
} from "#/domain/listed-model";
import { parseModelRouteId } from "#/domain/model-connection";
import {
	canonicalModelId,
	failoverConnectionKind,
	modelTier,
	SUBSCRIPTION_LABEL,
} from "#/domain/model-failover";
import { harnessForModelId } from "#/domain/model-harness";
import type {
	ThreadModel,
	ThreadModelChoices,
} from "#/domain/y-squared-models";
import { claudeSubscriptionStatus } from "../adapters/claude-subscription";
import {
	codexSubscriptionCatalog,
	readCodexSubscriptionUsage,
} from "../adapters/codex-subscription";
import { listModelConnections } from "../adapters/model-connections";
import { loadModelFailoverPreferences } from "../adapters/model-failover-preferences";
import { planSpentUntil } from "../adapters/plan-spent";
import { ySquaredCrewFor } from "../adapters/y-squared-crew-client";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import { apiModelCatalog } from "./api-workspace-session";

/** A plan window this full is "nearly used up". */
const NEARLY_SPENT_PERCENT = 90;

const clock = (at: number) =>
	`${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

type Window = { usedPercent?: unknown; resetsAt?: unknown } | null | undefined;

/** Epoch milliseconds from a reset time that may be in seconds. */
const resetMs = (value: number) => (value < 1e12 ? value * 1000 : value);

/** The ChatGPT plan's usage windows: when it is spent until, and whether it is nearly spent. */
export function codexPlanState(
	usage: unknown,
	now: number,
): { spentUntil: number | null; nearly: boolean } {
	const bucket = (
		usage as {
			limits?: {
				rateLimitsByLimitId?: {
					codex?: { primary?: Window; secondary?: Window };
				};
			};
		} | null
	)?.limits?.rateLimitsByLimitId?.codex;
	let spentUntil: number | null = null;
	let nearly = false;
	for (const window of [bucket?.primary, bucket?.secondary]) {
		if (typeof window?.usedPercent !== "number") continue;
		const reset =
			typeof window.resetsAt === "number" ? resetMs(window.resetsAt) : null;
		if (window.usedPercent >= 100 && reset !== null && reset > now)
			spentUntil = Math.max(spentUntil ?? 0, reset);
		else if (window.usedPercent >= NEARLY_SPENT_PERCENT) nearly = true;
	}
	return { spentUntil, nearly };
}

function speedsOf(model: ListedModel): string[] {
	return (
		model.speeds?.map((speed) => speed.id) ??
		(listedModelSupportsFastMode(model) ? ["fast"] : [])
	);
}

/** Whether Y² may choose models for this project (the crew's setting; on when it cannot be read). */
async function modelChoiceEnabled(projectId: string) {
	const status = await ySquaredCrewFor(projectId)
		?.proactive?.()
		.catch(() => null);
	return status?.settings.modelChoice ?? true;
}

/**
 * What Y² can start a thread on or switch one to, right now: the models the
 * composer's picker would offer this person on each connected route (the
 * ChatGPT plan, the Claude plan, API keys, the Grok plan, gateways), each with
 * the route it runs on, a tier from the failover table, and whether its plan
 * is used up. Reads only the person's own connections.
 */
export async function ySquaredThreadModels(
	userId: string,
	projectId: string,
): Promise<ThreadModelChoices> {
	const now = Date.now();
	const [enabled, failover, hasCodex, apiModels, connections, claude] =
		await Promise.all([
			modelChoiceEnabled(projectId),
			loadModelFailoverPreferences(userId)
				.then((preferences) => preferences.enabled)
				.catch(() => true),
			hasManagedCodexAuth(userId).catch(() => false),
			apiModelCatalog(userId).catch(() => [] as readonly ListedModel[]),
			listModelConnections(userId).catch(() => []),
			claudeSubscriptionStatus(userId).catch(() => null),
		]);
	const codexModels = hasCodex
		? await codexSubscriptionCatalog(userId).catch(
				() => [] as readonly ListedModel[],
			)
		: [];
	const codexUsage = hasCodex
		? await Promise.race([
				readCodexSubscriptionUsage(userId),
				new Promise<undefined>((resolve) =>
					setTimeout(() => resolve(undefined), 3_000),
				),
			]).catch(() => undefined)
		: undefined;
	const codexState = codexPlanState(codexUsage, now);
	// One lookup per connection: whether its plan is used up.
	const spent = new Map<string, number | null>();
	const spentUntil = async (key: string, connectionId: string | null) => {
		if (!spent.has(key))
			spent.set(
				key,
				await planSpentUntil(userId, {
					connectionId,
					connectionRevision:
						connectionId === null ? claudeCodeTurnRevision() : "",
				}).catch(() => null),
			);
		return spent.get(key) ?? null;
	};
	const models: ThreadModel[] = [];
	const add = (
		listed: ListedModel,
		route: string,
		tier: ThreadModel["tier"],
		state: { until: number | null; nearly?: boolean; down?: string },
	) => {
		const down =
			state.down ??
			(state.until && state.until > now
				? `plan used up until ${clock(state.until)}`
				: undefined);
		models.push({
			id: listed.id,
			label: listed.label,
			harness: harnessForModelId(listed.id) ?? "api",
			route,
			tier,
			reasoning: listed.reasoning?.levels.map((level) => level.id) ?? [],
			...(listed.reasoning
				? { defaultReasoning: listed.reasoning.defaultLevelId }
				: {}),
			speeds: speedsOf(listed),
			usable: !down,
			...(down ? { unavailable: down } : {}),
			...(!down && state.nearly ? { nearlySpent: true } : {}),
		});
	};
	for (const listed of codexModels)
		add(
			listed,
			`${SUBSCRIPTION_LABEL} (ChatGPT plan)`,
			modelTier(canonicalModelId({ kind: "subscription" }, listed.id) ?? ""),
			{ until: codexState.spentUntil, nearly: codexState.nearly },
		);
	for (const listed of apiModels) {
		if (listed.id.startsWith("claude-code/")) {
			const modelId = listed.id.slice("claude-code/".length);
			add(
				listed,
				`${CLAUDE_CODE_LABEL} (Claude plan)`,
				modelTier(canonicalModelId({ kind: "subscription" }, modelId) ?? ""),
				{
					until: await spentUntil("claude-code", null),
					...(claude?.status === "refused"
						? { down: "the Claude sign-in needs renewing" }
						: {}),
				},
			);
			continue;
		}
		const route = parseModelRouteId(listed.id);
		const connection = route
			? connections.find((row) => row.id === route.connectionId)
			: undefined;
		if (!route || !connection) continue;
		add(
			listed,
			connection.subscription
				? `${connection.label} (plan)`
				: `${connection.label} (API key)`,
			modelTier(
				canonicalModelId(
					{
						kind: failoverConnectionKind(connection),
						provider: connection.provider,
						baseUrl: connection.baseUrl,
					},
					route.modelId,
				) ?? "",
			),
			{
				until: connection.subscription
					? await spentUntil(connection.id, connection.id)
					: null,
				...(connection.subscription &&
				connection.subscription.status !== "ready"
					? { down: "its sign-in needs renewing" }
					: {}),
			},
		);
	}
	return { enabled, failover, models };
}
