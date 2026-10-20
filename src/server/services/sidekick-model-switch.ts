import type { ModelMessage } from "ai";
import type { ApiTokenUsage } from "#/domain/api-token-usage";
import { parseModelRouteId } from "#/domain/model-connection";
import {
	type FailoverConnection,
	type ModelRoute,
	nextTurnFailover,
	type RouteLabel,
	routeKey,
	SUBSCRIPTION_KEY,
	type TurnFailover,
} from "#/domain/model-failover";
import {
	type ResolvedChildModel,
	type RoleModels,
	resolveRoleModel,
} from "#/domain/role-models";
import { modelSwitchHistory } from "#/domain/runtime-handoff";
import type { SessionItem } from "#/domain/session-item";
import {
	completeSidekickSwitch,
	currentSidekickRound,
	recordSidekickDecision,
	type SidekickState,
	sidekickState,
} from "#/domain/sidekick";
import {
	type ClassifierInput,
	sidekickEscalation,
} from "#/domain/sidekick-classifier";
import {
	roundCommands,
	roundEvidence,
	sidekickRoundBrief,
	sidekickRoundItems,
	sidekickSignals,
} from "#/domain/sidekick-signals";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
} from "../adapters/agent-sessions";
import { updateSidekickState } from "../adapters/subagents";
import type { ModelSwitchTarget } from "./model-agent-loop";
import { failoverConnections } from "./model-failover";
import {
	classifySidekick,
	type SidekickClassification,
} from "./sidekick-classifier";

/**
 * Lead mode fusion's model switch, as Devin Fusion does it: "switching the
 * model during context compaction, which would trigger a cache miss anyway.
 * Each time we trigger compaction, we take it as an opportunity to evaluate
 * the situation and switch the model". The same sidekick session (its id,
 * fork, label and history) continues on roleModels.writerEscalation from a
 * provider-neutral summary of its context.
 *
 * Policy, in this order:
 * 1. A round's classifier decision switch_model (src/server/services/
 *    subagent-runtime.ts) marks the switch pending; it is carried out at the
 *    sidekick's next compaction.
 * 2. A sidekick's round is usually far below the compaction threshold, so
 *    the next round does not wait for one: its turn compacts before its
 *    first step (ModelAgentInput.compactFirst) and switches there.
 * 3. Any other compaction of the sidekick's context (context pressure
 *    mid-round) asks the classifier again ("evaluate the situation"); a
 *    switch_model there switches at that compaction.
 * The switch continues the running turn on the new route (as a failover
 * does) and moves the session to it, so later rounds stay there.
 */

export type SidekickSwitchDeps = {
	readonly session?: typeof agentSessionForOwner;
	/** Compare-and-set of the state, with the session's model in the same write. */
	readonly updateState?: typeof updateSidekickState;
	readonly routes?: (userId: string) => Promise<readonly FailoverConnection[]>;
	readonly classify?: (
		summary: ClassifierInput,
	) => Promise<SidekickClassification>;
	readonly now?: () => number;
};

/**
 * Turns whose switch was dropped (route unavailable, or the switch failed):
 * no further switch, and no more switch compactions, in them. Kept in
 * memory whether or not the state's own mark (switchBlockedTurn) was saved,
 * which also covers a step that runs in another isolate.
 */
const blockedTurns = new Set<string>();

export function blockSidekickSwitch(turnId: string) {
	blockedTurns.add(turnId);
	if (blockedTurns.size > 1000)
		blockedTurns.delete(blockedTurns.values().next().value as string);
}

/** Whether a turn may still switch the sidekick's model. */
export function sidekickSwitchAllowed(state: SidekickState, turnId: string) {
	return !blockedTurns.has(turnId) && state.switchBlockedTurn !== turnId;
}

/** What the run does at a compaction: switch or not, and the classifier's usage to charge. */
export type CompactionSwitchDecision = {
	readonly target: ModelSwitchTarget | null;
	readonly usage?: ApiTokenUsage | null;
};

/** The hook the sidekick's run asks at each compaction (ModelAgentInput.switchAtCompaction). */
export function sidekickSwitchAtCompaction(input: {
	readonly userId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly roleModels: RoleModels | undefined;
	/** The session's items now (the round so far). */
	readonly items: () => readonly SessionItem[];
	readonly signal?: AbortSignal;
	readonly deps?: SidekickSwitchDeps;
}) {
	const deps = input.deps ?? {};
	return async ({
		forced,
	}: {
		readonly forced: boolean;
	}): Promise<CompactionSwitchDecision> => {
		const none = { target: null };
		const session = await (deps.session ?? agentSessionForOwner)(
			input.userId,
			input.sessionId,
		);
		const state = sidekickState(session);
		if (!session || !state || state.retired) return none;
		if (!sidekickSwitchAllowed(state, input.turnId)) return none;
		if (state.pendingSwitch)
			return {
				target: {
					spec: state.pendingSwitch.to,
					reason: state.pendingSwitch.reason,
					trigger: "pending",
				},
			};
		const escalation = sidekickEscalation(
			input.roleModels,
			session.listedModelId,
		);
		if (forced || !escalation) return none;
		const { answer, record, usage } = await (
			deps.classify ??
			((summary: ClassifierInput) =>
				classifySidekick({
					userId: input.userId,
					sessionId: input.sessionId,
					roleModels: input.roleModels,
					summary,
					signal: input.signal,
				}))
		)(compactionSummary(state, input.items(), session, escalation));
		// A hand_back mid-round is recorded only: the round's own decision reaches the lead.
		await (deps.updateState ?? updateSidekickState)(
			input.sessionId,
			(current) => recordSidekickDecision(current, record),
		).catch(() => {});
		return {
			target:
				answer.decision === "switch_model"
					? { spec: escalation, reason: answer.reason, trigger: "compaction" }
					: null,
			usage,
		};
	};
}

/** The classifier's input at a compaction: the round so far. */
function compactionSummary(
	state: SidekickState,
	items: readonly SessionItem[],
	session: AgentSessionRecord,
	escalation: string,
): ClassifierInput {
	const round = sidekickRoundItems(items, state.round);
	const kind = currentSidekickRound(state)?.kind ?? "build";
	const evidence = roundEvidence(round);
	const report =
		[...round].reverse().find((item) => item.kind === "agentMessage")?.text ??
		"";
	return {
		point: "compaction",
		round: state.round,
		roundKind: kind,
		model: session.listedModelId ?? "",
		brief: sidekickRoundBrief(items, state.round),
		report,
		commands: roundCommands(round),
		signals: sidekickSignals({
			kind,
			outcome: "finished",
			// Mid-round: no patch yet, so no-file-change cannot be judged.
			patchFiles: 1,
			evidence,
			previous: state.rounds.find((entry) => entry.n === state.round - 1)
				?.evidence,
			roundsLeft: 1,
		}),
		canSwitch: !!escalation,
	};
}

/** The escalation spec's route among the user's routes, with its labels. */
function switchRoute(
	resolved: ResolvedChildModel,
	connections: readonly FailoverConnection[],
): { route: ModelRoute; label: RouteLabel } | null {
	if (resolved.harness === "codex") {
		const connection = connections.find(
			(entry) => entry.kind === "subscription",
		);
		return {
			route: {
				connectionId: null,
				connectionRevision: subscriptionTurnRevision(resolved.reasoning),
				modelId: resolved.listedModelId,
			},
			label: {
				model:
					connection?.models.find(
						(model) => model.id === resolved.listedModelId,
					)?.label ?? resolved.listedModelId,
				connection: connection?.label ?? SUBSCRIPTION_KEY,
			},
		};
	}
	const parsed = parseModelRouteId(resolved.listedModelId);
	const connection = connections.find(
		(entry) => entry.key === parsed?.connectionId,
	);
	if (!parsed || !connection) return null;
	return {
		route: {
			connectionId: parsed.connectionId,
			connectionRevision: connection.revision,
			modelId: parsed.modelId,
			...(resolved.reasoning
				? { settings: { reasoning: resolved.reasoning } }
				: {}),
		},
		label: {
			model:
				connection.models.find((model) => model.id === parsed.modelId)?.label ??
				parsed.modelId,
			connection: connection.label,
		},
	};
}

/** What the turn continues with after a switch (or on its own route when it cannot switch). */
export type SidekickSwitchOutcome =
	| {
			readonly kind: "switched";
			readonly failover: TurnFailover;
			readonly messages: ModelMessage[];
			readonly to: string;
			readonly from: string;
			/** The new route's labels (the timeline's model switch item). */
			readonly label: RouteLabel;
	  }
	| { readonly kind: "kept"; readonly reason: string };

/**
 * Carries out a switch the run ended for (ModelSwitchAtCompaction): moves
 * the session to the escalation model, records the switch in the
 * sidekick's state, and returns the turn's failover onto the new route with
 * its history made provider-neutral. When the route is unavailable the
 * pending switch is dropped and the turn continues where it was.
 */
export async function completeSidekickModelSwitch(input: {
	readonly userId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly roleModels: RoleModels | undefined;
	readonly target: ModelSwitchTarget;
	readonly compacted: boolean;
	/** The route serving the turn now, its labels and failover so far. */
	readonly current: { readonly route: ModelRoute; readonly label: RouteLabel };
	readonly previous: TurnFailover | null;
	readonly messages: ModelMessage[];
	readonly deps?: SidekickSwitchDeps;
}): Promise<SidekickSwitchOutcome> {
	const deps = input.deps ?? {};
	const now = new Date((deps.now ?? Date.now)()).toISOString();
	const session = await (deps.session ?? agentSessionForOwner)(
		input.userId,
		input.sessionId,
	);
	const state = sidekickState(session);
	if (!session || !state) return { kind: "kept", reason: "not a sidekick" };
	const update = deps.updateState ?? updateSidekickState;
	// Once per turn, whether or not the state's mark is saved: a dropped
	// switch must not compact again and again.
	const keep = async (reason: string) => {
		blockSidekickSwitch(input.turnId);
		await update(input.sessionId, (current) => {
			const { pendingSwitch: _, ...rest } = current;
			return { ...rest, switchBlockedTurn: input.turnId };
		}).catch(() => {});
		return { kind: "kept" as const, reason };
	};
	const entry =
		input.roleModels?.writerEscalation?.model === input.target.spec
			? input.roleModels.writerEscalation
			: { model: input.target.spec };
	const connections = await (deps.routes ?? failoverConnections)(input.userId);
	const resolved = resolveRoleModel({
		role: "writerEscalation",
		roleModels: { writerEscalation: entry },
		connections,
		parentModel: session.listedModelId ?? "",
	});
	if (resolved.kind !== "role")
		return keep(
			resolved.kind === "fallback" ? resolved.notice : "no escalation model",
		);
	const next = switchRoute(resolved.model, connections);
	if (!next) return keep(`no route for ${resolved.model.listedModelId}`);
	if (routeKey(next.route) === routeKey(input.current.route))
		return keep("already on the escalation model");
	// The model and the switch's record in one write; a sidekick retired
	// meanwhile is not switched (nor brought back).
	const saved = await update(
		input.sessionId,
		(current) =>
			current.retired
				? null
				: completeSidekickSwitch(current, {
						from: session.listedModelId ?? "",
						to: resolved.model.listedModelId,
						reason: input.target.reason,
						round: current.round,
						trigger: input.target.trigger,
						compacted: input.compacted,
						at: now,
					}),
		{
			listedModelId: resolved.model.listedModelId,
			harness: resolved.model.harness === "codex" ? "codex" : "api",
		},
	);
	if (!saved) return keep("the sidekick was retired meanwhile");
	const failover = nextTurnFailover(input.previous, input.current, {
		route: next.route,
		connectionKey: next.route.connectionId ?? SUBSCRIPTION_KEY,
		connectionLabel: next.label.connection,
		modelLabel: next.label.model,
		paid: next.route.connectionId !== null,
		sameModel: false,
	});
	return {
		kind: "switched",
		failover,
		to: resolved.model.listedModelId,
		from: session.listedModelId ?? "",
		label: next.label,
		messages: modelSwitchHistory(
			input.messages,
			`Runtime note: your context was compacted and you now run on ${resolved.model.listedModelId} (${input.target.reason.replace(/[.\s]+$/, "")}). Continue the current round from the summary above; your checkout is unchanged.`,
		),
	};
}
