import type { ModelMessage } from "ai";
import { checkerWrapUpLeadMs } from "#/domain/checker-brief";
import { modelName } from "#/domain/fusion-pairs";
import { WorkspaceId } from "#/domain/ids";
import { sessionBilling } from "#/domain/model-pricing";
import type { SessionItem } from "#/domain/session-item";
import {
	currentSidekickRound,
	endSidekickRound,
	isActiveSidekick,
	previousSidekickRound,
	retireSidekickState,
	type SidekickState,
	sidekickIdleTtlMinutes,
	sidekickRoundLabel,
	sidekickRoundsLeft,
	sidekickState,
	subagentBudgetCheck,
} from "#/domain/sidekick";
import {
	roundEvidence,
	sidekickRoundItems,
	sidekickSignals,
	sidekickStuckNotice,
	warrantsEscalation,
} from "#/domain/sidekick-signals";
import {
	AGENT_SEND_TOOL,
	overlappingWriters,
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
	type SidekickRoundChanges,
	sidekickRoundChanges,
} from "./sidekick-workspace";
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
 * writer the patch transferred into the parent's checkout; for lead mode
 * fusion's sidekick, which works in the lead's checkout, what its round
 * changed there.
 */
export async function subagentReport(input: {
	readonly machines: WorkspaceMachines;
	readonly session: AgentSessionRecord;
	readonly items: readonly SessionItem[];
	readonly outcome: SubagentOutcome;
	readonly text: string;
	readonly now?: number;
	readonly deps?: SidekickRuntimeDeps;
	/** Lead mode fusion: roleModels.writerEscalation's model, named in a stuck notice. */
	readonly escalationModel?: string;
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
	if (role === "writer" && sidekick) {
		const parent = ancestors[0];
		const base = currentSidekickRound(sidekick)?.base;
		let changes: SidekickRoundChanges | null = null;
		try {
			if (!parent?.providerRef || !base)
				throw new Error("the round's start is unknown");
			changes = await (input.deps?.roundChanges ?? sidekickRoundChanges)({
				machines: input.machines,
				vm: WorkspaceId(parent.providerRef),
				label,
				round: sidekick.round,
				base,
			});
		} catch (cause) {
			console.warn("A sidekick round's changes could not be listed.", {
				message: cause instanceof Error ? cause.message.slice(0, 200) : "",
			});
		}
		parts.push(sidekickChangesBlock(label, base, changes));
		parts.push(
			await endSidekickRoundAndReport({
				sessionId: session.id,
				label,
				state: sidekick,
				outcome: input.outcome,
				patchFiles: changes?.files.length ?? 0,
				end: changes?.end,
				items: input.items,
				model: session.listedModelId ?? null,
				escalationModel: input.escalationModel,
				now,
				deps: input.deps,
			}),
		);
	} else if (role === "writer") {
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
				label,
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
	}
	return parts.filter(Boolean).join("\n\n");
}

/** What a sidekick's round changed in the lead's checkout, and how to review it. */
export function sidekickChangesBlock(
	label: string,
	base: string | undefined,
	changes: SidekickRoundChanges | null,
) {
	if (!changes || !base)
		return `Sidekick ${label} worked in your checkout; its changes are uncommitted in your working tree. Review them in place with \`git status\` and \`git diff\` (this round's exact changes could not be listed).`;
	if (!changes.files.length)
		return `Sidekick ${label} changed no files in your checkout this round.`;
	return [
		`Sidekick ${label} worked in your checkout: this round changed ${changes.files.length} file${changes.files.length === 1 ? "" : "s"}, uncommitted in your working tree. Review them in place: \`git diff ${base.slice(0, 12)} ${changes.end.slice(0, 12)}\` is this round alone (\`git diff\` and \`git status\` show all uncommitted work).`,
		`\`\`\`\n${changes.stat}\n\`\`\``,
	].join("\n");
}

/** What the sidekick functions touch outside themselves; tests pass fakes. */
export type SidekickRuntimeDeps = {
	readonly session?: typeof agentSessionForOwner;
	readonly transfer?: typeof transferWriterPatch;
	readonly roundChanges?: typeof sidekickRoundChanges;
	readonly mergeFork?: typeof mergeSubagentFork;
	readonly saveState?: typeof saveSidekickState;
	readonly descendants?: typeof descendantAgentSessions;
	readonly stop?: typeof requestSubagentStop;
	readonly now?: () => number;
};

/**
 * Closes a sidekick's round after its report: records the round (its
 * changed files, end snapshot, evidence and hand-back signals) and retires
 * it when it has no rounds left (or was retired meanwhile). Returns the
 * report's closing line.
 */
async function endSidekickRoundAndReport(input: {
	readonly sessionId: string;
	readonly label: string;
	readonly state: SidekickState;
	readonly outcome: SubagentOutcome;
	readonly patchFiles: number;
	readonly end?: string;
	/** The sidekick's history (this round is the part after its start message). */
	readonly items: readonly SessionItem[];
	readonly model: string | null;
	readonly escalationModel?: string;
	readonly now: number;
	readonly deps?: SidekickRuntimeDeps;
}) {
	// Hand-back signals: this round against the one before it.
	const evidence = roundEvidence(
		sidekickRoundItems(input.items, input.state.round),
	);
	const signals = sidekickSignals({
		kind: currentSidekickRound(input.state)?.kind ?? "build",
		outcome: input.outcome,
		patchFiles: input.patchFiles,
		evidence,
		previous: previousSidekickRound(input.state)?.evidence,
		roundsLeft: sidekickRoundsLeft(input.state),
	});
	const ended = endSidekickRound(input.state, {
		now: new Date(input.now).toISOString(),
		outcome: input.outcome,
		patchFiles: input.patchFiles,
		end: input.end,
		evidence,
		signals,
	});
	await (input.deps?.saveState ?? saveSidekickState)(
		input.sessionId,
		ended,
	).catch(() => {});
	if (ended.retired)
		return [
			`Sidekick ${input.label} is retired (${ended.retired.reason}). Start a new writer for more work.`,
			sidekickStuckNotice({ label: input.label, signals }),
		]
			.filter(Boolean)
			.join("\n\n");
	const escalation =
		input.escalationModel &&
		warrantsEscalation(signals) &&
		modelName(input.escalationModel) !== modelName(input.model ?? "")
			? input.escalationModel
			: undefined;
	return [
		`Sidekick ${input.label}: ${sidekickRoundLabel(ended)} done. It keeps its context: send feedback or the next brief with ${AGENT_SEND_TOOL} (id ${input.label}); it works in your checkout as it is then, so keep or revert its changes first.`,
		sidekickStuckNotice({ label: input.label, signals, escalation }),
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * Retires one sidekick: it takes no more rounds; a running one is asked to
 * stop (its report still arrives). It holds no VM of its own, so nothing
 * else is deleted.
 */
export async function retireSidekick(
	_machines: WorkspaceMachines,
	session: Pick<
		AgentSessionRecord,
		"id" | "agentRole" | "agentBudget" | "turnStatus"
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
 * patch and ref by then), and retires sidekicks idle past their TTL (they
 * hold no VM, so only their state changes); run from the maintenance sweep.
 * Returns the forks deleted.
 */
export async function teardownSubagentForks(
	machines: WorkspaceMachines,
	graceMinutes = 30,
	idleMinutes = sidekickIdleTtlMinutes(),
) {
	let deleted = 0;
	for (const idle of await idleSidekicksPastTtl(idleMinutes))
		await retireSidekick(
			machines,
			idle,
			`idle for over ${idleMinutes} minutes`,
		).catch((cause) => {
			console.warn("An idle sidekick could not be retired yet.", {
				message: cause instanceof Error ? cause.message.slice(0, 200) : "",
			});
		});
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
