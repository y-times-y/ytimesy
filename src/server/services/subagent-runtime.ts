import type { ModelMessage } from "ai";
import { checkerWrapUpLeadMs } from "#/domain/checker-brief";
import { WorkspaceId } from "#/domain/ids";
import { sessionBilling } from "#/domain/model-pricing";
import type { RoleModels } from "#/domain/role-models";
import type { SessionItem } from "#/domain/session-item";
import {
	currentSidekickRound,
	endSidekickRound,
	isActiveSidekick,
	markSidekickSwitch,
	previousSidekickRound,
	recordSidekickDecision,
	reportPushesBack,
	retireSidekickState,
	type SidekickState,
	sidekickIdleTtlMinutes,
	sidekickPatchLabel,
	sidekickRoundLabel,
	sidekickRoundsLeft,
	sidekickState,
	subagentBudgetCheck,
} from "#/domain/sidekick";
import {
	type ClassifierInput,
	sidekickDecisionNotice,
	sidekickEscalation,
} from "#/domain/sidekick-classifier";
import {
	roundCommands,
	roundEvidence,
	sidekickRoundBrief,
	sidekickRoundItems,
	sidekickSignals,
} from "#/domain/sidekick-signals";
import {
	AGENT_SEND_TOOL,
	overlappingWriters,
	type SubagentFork,
	type SubagentOutcome,
	subagentBudgetState,
	subagentReportHeader,
	type WriterPatch,
	writerPatchBlock,
} from "#/domain/subagent";
import { subagentWrapUpNotice } from "#/domain/subagent-instructions";
import { subagentTree } from "#/domain/subagent-tree";
import {
	agentSpend,
	budgetTokenWeight,
	sessionTokenUsage,
	usageTokens,
} from "#/domain/subagent-usage";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	descendantAgentSessions,
} from "../adapters/agent-sessions";
import {
	forkedWritersDueForTeardown,
	idleSidekicksPastTtl,
	subagentTree as loadSubagentTree,
	mergeSubagentFork,
	recordSubagentStep,
	requestSubagentStop,
	saveSidekickState,
	subagentAncestors,
} from "../adapters/subagents";
import {
	classifySidekick,
	type SidekickClassification,
} from "./sidekick-classifier";
import { transferWriterPatch } from "./subagent-writer";
import type { WorkspaceMachines } from "./workspace-machines";

/** A subagent's turn stopped at its budget; its work so far is still reported. */
export class SubagentBudgetExhausted extends Error {
	constructor(readonly reason: string) {
		super(`Budget exhausted (${reason}).`);
		this.name = "SubagentBudgetExhausted";
	}
}

type SubagentSession = Pick<
	AgentSessionRecord,
	"id" | "userId" | "createdAt" | "agentRole" | "agentBudget"
> &
	Partial<Pick<AgentSessionRecord, "listedModelId">>;

/**
 * Checked before every model step of a subagent's turn: counts the step,
 * compares steps, wall minutes and subtree tokens with its budget, adds the
 * wrap-up notice once at 90% and stops the turn at 100%.
 */
export async function guardSubagentStep(input: {
	readonly session: SubagentSession;
	readonly items: readonly SessionItem[];
	readonly messages: ModelMessage[];
	readonly now?: number;
	readonly deps?: {
		readonly recordStep?: typeof recordSubagentStep;
		readonly descendants?: typeof descendantAgentSessions;
	};
}): Promise<ModelMessage[]> {
	const recordStep = input.deps?.recordStep ?? recordSubagentStep;
	const descendants = input.deps?.descendants ?? descendantAgentSessions;
	const { steps, budget } = await recordStep(input.session.id);
	const limits = budget ?? input.session.agentBudget;
	if (!limits) return input.messages;
	// Tokens count in the budget's basis model: a cheaper model's count for less.
	const weight = (modelId: string | null | undefined) =>
		budgetTokenWeight(modelId, limits.priceBasis);
	const childTokens = (
		await descendants(input.session.userId, input.session.id)
	).reduce(
		(total, child) =>
			total +
			usageTokens(sessionTokenUsage(child.items as SessionItem[])) *
				weight(child.listedModelId),
		0,
	);
	const checker = input.session.agentRole === "checker";
	// A sidekick's steps and minutes count per round (src/domain/sidekick.ts).
	const check = subagentBudgetCheck(
		limits,
		{
			steps,
			tokens:
				usageTokens(sessionTokenUsage(input.items)) *
					weight(input.session.listedModelId) +
				childTokens,
			createdAt: input.session.createdAt,
		},
		input.now ?? Date.now(),
	);
	const state = subagentBudgetState(
		check.limits,
		check.used,
		checker ? checkerWrapUpLeadMs(check.limits.minutes * 60_000) / 60_000 : 0,
	);
	if (state.state === "exhausted")
		throw new SubagentBudgetExhausted(`${check.reasonPrefix}${state.reason}`);
	if (state.state === "wrap-up") {
		const notice = subagentWrapUpNotice(
			`${check.reasonPrefix}${state.reason}`,
			input.session.agentRole,
		);
		// Once per round: an earlier round's notice stays in a sidekick's history.
		const marker = `Budget nearly used (${check.reasonPrefix}`;
		if (
			!input.messages.some(
				(message) =>
					message.role === "user" &&
					typeof message.content === "string" &&
					message.content.startsWith(marker),
			)
		)
			return [...input.messages, { role: "user", content: notice }];
	}
	return input.messages;
}

/**
 * The report a subagent's parent receives: a one-line header (outcome,
 * steps, minutes, tokens, dollars), the agent's own final text, and for a
 * writer the patch transferred into the parent's checkout.
 */
export async function subagentReport(input: {
	readonly machines: WorkspaceMachines;
	readonly session: AgentSessionRecord;
	readonly items: readonly SessionItem[];
	readonly outcome: SubagentOutcome;
	readonly text: string;
	readonly now?: number;
	readonly deps?: SidekickRuntimeDeps;
	/** Lead mode fusion: the variant's role models (the classifier's and writerEscalation's). */
	readonly roleModels?: RoleModels;
}): Promise<string> {
	const { session } = input;
	const role = session.agentRole;
	if (!role) return input.text;
	const now = input.now ?? Date.now();
	const ancestors = await subagentAncestors(session.userId, session.id);
	const root = ancestors.at(-1);
	const tree = root
		? subagentTree(
				root.id,
				(await loadSubagentTree(session.userId, root.id)).map((entry) =>
					entry.id === session.id ? { ...entry, items: input.items } : entry,
				),
				now,
			)
		: null;
	const node = tree?.nodes.find((entry) => entry.id === session.id);
	const label = node?.label ?? "?";
	const spend =
		node?.subtree ??
		agentSpend({
			items: input.items,
			billing: sessionBilling(session),
		});
	// A sidekick's state as saved now (agent_send may have stopped it mid-round).
	const sidekick = sidekickState(session)
		? sidekickState(
				(await (input.deps?.session ?? agentSessionForOwner)(
					session.userId,
					session.id,
				)) ?? session,
			)
		: null;
	const header = subagentReportHeader({
		label,
		role,
		outcome: input.outcome,
		steps: node?.steps ?? session.agentSteps ?? 0,
		minutes:
			(now - Date.parse(sidekick?.roundStartedAt ?? session.createdAt)) /
			60_000,
		tokens: spend.tokens,
		costUsd: spend.costUsd,
		costEstimated: spend.planBilled,
		...(sidekick ? { round: sidekickRoundLabel(sidekick) } : {}),
	});
	const parts = [header, input.text.trim()];
	if (role === "writer") {
		let patch: WriterPatch | null = null;
		let failure: string | undefined;
		const fork = session.agentFork;
		const parent = ancestors[0];
		try {
			if (!fork?.vmId || !fork.base || !fork.parentHead || !parent?.providerRef)
				throw new Error("the fork's record is incomplete");
			patch = await (input.deps?.transfer ?? transferWriterPatch)({
				machines: input.machines,
				forkVm: WorkspaceId(fork.vmId),
				parentVm: WorkspaceId(parent.providerRef),
				label: sidekick ? sidekickPatchLabel(label, sidekick.round) : label,
				base: fork.base,
				parentHead: fork.parentHead,
			});
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
		}
		await (input.deps?.mergeFork ?? mergeSubagentFork)(session.id, {
			patch,
			reportedAt: new Date(now).toISOString(),
		}).catch(() => {});
		const siblings = (tree?.nodes ?? []).filter(
			(other) =>
				other.id !== session.id &&
				other.parentId === node?.parentId &&
				other.role === "writer",
		);
		const siblingFiles = await Promise.all(
			siblings.map(async (sibling) => ({
				label: sibling.label,
				files:
					(await agentSessionForOwner(session.userId, sibling.id))?.agentFork
						?.patch?.files ?? [],
			})),
		);
		parts.push(
			writerPatchBlock(
				patch,
				patch ? overlappingWriters(patch.files, siblingFiles) : [],
				failure,
			),
		);
		if (sidekick)
			parts.push(
				await endSidekickRoundAndReport({
					machines: input.machines,
					sessionId: session.id,
					label,
					fork: fork ?? null,
					state: sidekick,
					userId: session.userId,
					outcome: input.outcome,
					patch,
					report: input.text,
					items: input.items,
					model: session.listedModelId ?? null,
					roleModels: input.roleModels,
					now,
					deps: input.deps,
				}),
			);
	}
	return parts.filter(Boolean).join("\n\n");
}

/** What the sidekick functions touch outside themselves; tests pass fakes. */
export type SidekickRuntimeDeps = {
	readonly session?: typeof agentSessionForOwner;
	readonly transfer?: typeof transferWriterPatch;
	readonly mergeFork?: typeof mergeSubagentFork;
	readonly saveState?: typeof saveSidekickState;
	readonly descendants?: typeof descendantAgentSessions;
	readonly stop?: typeof requestSubagentStop;
	readonly now?: () => number;
	/** The round's classifier (classifySidekick with the variant's role models). */
	readonly classify?: (
		summary: ClassifierInput,
	) => Promise<SidekickClassification>;
};

/**
 * Closes a sidekick's round after its report: records the round and the
 * classifier's decision on it, retires it when it has no rounds left (or
 * was retired meanwhile) and then deletes its fork, since the patch and ref
 * are already in the lead's checkout. A hand_back puts a notice in the
 * report; a switch_model marks the switch for its next compaction. Returns
 * the report's closing lines.
 */
async function endSidekickRoundAndReport(input: {
	readonly machines: WorkspaceMachines;
	readonly sessionId: string;
	readonly userId: string;
	readonly label: string;
	readonly fork: SubagentFork | null;
	readonly state: SidekickState;
	readonly outcome: SubagentOutcome;
	readonly patch: WriterPatch | null;
	readonly report: string;
	/** The sidekick's history (this round is the part after its start message). */
	readonly items: readonly SessionItem[];
	readonly model: string | null;
	readonly roleModels?: RoleModels;
	readonly now: number;
	readonly deps?: SidekickRuntimeDeps;
}) {
	const roundItems = sidekickRoundItems(input.items, input.state.round);
	const kind = currentSidekickRound(input.state)?.kind ?? "build";
	const patchFiles = input.patch?.files.length ?? 0;
	// Hand-back signals: this round against the one before it.
	const evidence = roundEvidence(roundItems);
	const signals = sidekickSignals({
		kind,
		outcome: input.outcome,
		patchFiles,
		evidence,
		previous: previousSidekickRound(input.state)?.evidence,
		roundsLeft: sidekickRoundsLeft(input.state),
	});
	const escalation = sidekickEscalation(input.roleModels, input.model);
	const summary: ClassifierInput = {
		point: "round",
		round: input.state.round,
		roundKind: kind,
		model: input.model ?? "",
		brief: sidekickRoundBrief(input.items, input.state.round),
		report: input.report,
		commands: roundCommands(roundItems),
		diff: {
			files: input.patch?.files ?? [],
			added: input.patch?.added ?? 0,
			removed: input.patch?.removed ?? 0,
		},
		outcome: input.outcome,
		signals,
		canSwitch: !!escalation,
	};
	const { answer, record } = await (
		input.deps?.classify ??
		((summary: ClassifierInput) =>
			classifySidekick({
				userId: input.userId,
				roleModels: input.roleModels,
				summary,
			}))
	)(summary);
	let ended = recordSidekickDecision(
		endSidekickRound(input.state, {
			now: new Date(input.now).toISOString(),
			outcome: input.outcome,
			patchFiles,
			evidence,
			signals,
			pushback: reportPushesBack(input.report),
		}),
		record,
	);
	const switching =
		answer.decision === "switch_model" && escalation && !ended.retired;
	if (switching)
		ended = markSidekickSwitch(ended, {
			to: escalation,
			reason: answer.reason,
			round: input.state.round,
			at: new Date(input.now).toISOString(),
		});
	await (input.deps?.saveState ?? saveSidekickState)(
		input.sessionId,
		ended,
	).catch(() => {});
	const notice = sidekickDecisionNotice({
		label: input.label,
		decision:
			answer.decision === "switch_model" && !switching
				? "hand_back"
				: answer.decision,
		reason: answer.reason,
		...(switching ? { switchTo: escalation } : {}),
	});
	if (ended.retired) {
		await deleteSidekickFork(input.machines, input.sessionId, input.fork, {
			...input.deps,
			now: () => input.now,
		});
		return [
			`Sidekick ${input.label} is retired (${ended.retired.reason}); its fork is deleted. Start a new writer for more work.`,
			notice,
		]
			.filter(Boolean)
			.join("\n\n");
	}
	return [
		`Sidekick ${input.label}: ${sidekickRoundLabel(ended)} done. It keeps its context and fork: send feedback or the next brief with ${AGENT_SEND_TOOL} (id ${input.label}); its fork is synced with your checkout first, so apply or discard this patch before you do.`,
		notice,
	]
		.filter(Boolean)
		.join("\n\n");
}

async function deleteSidekickFork(
	machines: WorkspaceMachines,
	sessionId: string,
	fork: SubagentFork | null | undefined,
	deps?: SidekickRuntimeDeps,
) {
	if (!fork?.vmId || fork.deletedAt) return;
	try {
		await machines.destroy(WorkspaceId(fork.vmId));
		await (deps?.mergeFork ?? mergeSubagentFork)(sessionId, {
			deletedAt: new Date(deps?.now?.() ?? Date.now()).toISOString(),
		});
	} catch (cause) {
		// The maintenance sweep deletes it later (a retired sidekick is an ordinary writer there).
		console.warn("A sidekick fork could not be deleted yet.", {
			message: cause instanceof Error ? cause.message.slice(0, 200) : "",
		});
	}
}

/**
 * Retires one sidekick: an idle one's fork is deleted now; a running one
 * is asked to stop and its fork goes after its report.
 */
export async function retireSidekick(
	machines: WorkspaceMachines,
	session: Pick<
		AgentSessionRecord,
		"id" | "agentRole" | "agentBudget" | "agentFork" | "turnStatus"
	>,
	reason: string,
	deps?: SidekickRuntimeDeps,
) {
	const state = sidekickState(session);
	if (!state) return "not a sidekick" as const;
	const now = new Date(deps?.now?.() ?? Date.now()).toISOString();
	await (deps?.saveState ?? saveSidekickState)(
		session.id,
		retireSidekickState(state, reason, now),
	);
	if (session.turnStatus === "running") {
		await (deps?.stop ?? requestSubagentStop)(session.id);
		return "stopping" as const;
	}
	await deleteSidekickFork(machines, session.id, session.agentFork, deps);
	return "retired" as const;
}

/**
 * The lead's turn ended: its active sidekicks are retired, or with
 * `keepIdle` (a completed turn) only those still working are; an idle
 * sidekick stays for the chat's next message until its idle TTL.
 */
export async function retireLeadSidekicks(
	machines: WorkspaceMachines,
	lead: { readonly userId: string; readonly id: string },
	reason: string,
	deps?: SidekickRuntimeDeps,
	options: { readonly keepIdle?: boolean } = {},
) {
	const children = await (deps?.descendants ?? descendantAgentSessions)(
		lead.userId,
		lead.id,
	);
	let retired = 0;
	for (const child of children)
		if (
			child.parentSessionId === lead.id &&
			isActiveSidekick(child) &&
			!(options.keepIdle && child.turnStatus !== "running")
		) {
			await retireSidekick(machines, child, reason, deps).catch((cause) =>
				console.warn("A sidekick could not be retired.", {
					message: cause instanceof Error ? cause.message.slice(0, 200) : "",
				}),
			);
			retired += 1;
		}
	return retired;
}

/**
 * Deletes writer forks 30 minutes after their report (the parent has the
 * patch and ref by then), and retires sidekicks idle past their TTL (their
 * forks go with them); run from the maintenance sweep.
 */
export async function teardownSubagentForks(
	machines: WorkspaceMachines,
	graceMinutes = 30,
	idleMinutes = sidekickIdleTtlMinutes(),
) {
	let deleted = 0;
	for (const idle of await idleSidekicksPastTtl(idleMinutes)) {
		const status = await retireSidekick(
			machines,
			idle,
			`idle for over ${idleMinutes} minutes`,
		).catch((cause) => {
			console.warn("An idle sidekick could not be retired yet.", {
				message: cause instanceof Error ? cause.message.slice(0, 200) : "",
			});
			return null;
		});
		if (status === "retired") deleted += 1;
	}
	for (const fork of await forkedWritersDueForTeardown(graceMinutes)) {
		try {
			await machines.destroy(WorkspaceId(fork.vmId));
			await mergeSubagentFork(fork.sessionId, {
				deletedAt: new Date().toISOString(),
			});
			deleted += 1;
		} catch (cause) {
			console.warn("A subagent fork could not be deleted yet.", {
				message: cause instanceof Error ? cause.message.slice(0, 200) : "",
			});
		}
	}
	return deleted;
}
