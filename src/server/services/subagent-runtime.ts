import type { ModelMessage } from "ai";
import { type ApiTokenUsage, addApiTokenUsage } from "#/domain/api-token-usage";
import {
	CHECKER_FINAL_NOTICE,
	checkerFinalStep,
	checkerWrapUpLeadMs,
	hasCheckerFinalNotice,
} from "#/domain/checker-brief";
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
	budgetUsageTokens,
	sessionTokenUsage,
} from "#/domain/subagent-usage";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	descendantAgentSessions,
} from "../adapters/agent-sessions";
import {
	addSessionRequestUsage,
	forkedWritersDueForTeardown,
	idleSidekicksPastTtl,
	subagentTree as loadSubagentTree,
	mergeSubagentFork,
	recordSubagentStep,
	requestSubagentStop,
	saveSidekickState,
	subagentAncestors,
	updateSidekickState,
} from "../adapters/subagents";
import {
	classifySidekick,
	type SidekickClassification,
} from "./sidekick-classifier";
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
 * wrap-up notice once at 90% and stops the turn at 100%. A checker instead
 * gets one final step at its limit (or within a minute of its time): the
 * final notice, with tools off (onFinalStep), so it still answers pass or
 * fail; a step after that stops it.
 */
export async function guardSubagentStep(input: {
	readonly session: SubagentSession;
	readonly items: readonly SessionItem[];
	readonly messages: ModelMessage[];
	readonly now?: number;
	/** A checker's final step: the caller turns its tools off for this step. */
	readonly onFinalStep?: () => void;
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
			budgetUsageTokens(sessionTokenUsage(child.items as SessionItem[])) *
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
				budgetUsageTokens(sessionTokenUsage(input.items)) *
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
	if (checker) {
		const final = checkerFinalStep({
			msLeft: (check.limits.minutes - check.used.minutes) * 60_000,
			exhausted: state.state === "exhausted",
			hadFinal: hasCheckerFinalNotice(input.messages),
		});
		if (final === "final") {
			input.onFinalStep?.();
			return [
				...input.messages,
				{ role: "user", content: CHECKER_FINAL_NOTICE },
			];
		}
		if (final === "stop")
			throw new SubagentBudgetExhausted(
				`${check.reasonPrefix}${state.state === "exhausted" ? state.reason : "final step taken"}`,
			);
	}
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
	/** Lead mode fusion: the variant's role models (the classifier's and writerEscalation's). */
	readonly roleModels?: RoleModels;
	/** Lead mode fusion with leadTools=thin: the lead restarts a failed writer, never takes over. */
	readonly thinLead?: boolean;
	/**
	 * Stops the round's classifier early. Not the finished turn's own signal:
	 * the report is written after the turn ended, when that signal is spent.
	 */
	readonly signal?: AbortSignal;
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
		...(node ? { name: node.name } : {}),
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
	// A sidekick from before the shared checkout still reports its fork's patch (below).
	const forkedSidekick = !!sidekick && !!session.agentFork?.vmId;
	if (role === "writer" && sidekick && !forkedSidekick) {
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
				userId: session.userId,
				outcome: input.outcome,
				changes,
				report: input.text,
				items: input.items,
				model: session.listedModelId ?? null,
				roleModels: input.roleModels,
				thinLead: input.thinLead,
				signal: input.signal,
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
				named: input.items
					.flatMap((item) => (item.kind === "userMessage" ? [item.text] : []))
					.join("\n"),
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
		if (sidekick) {
			// It worked on a fork from before the shared checkout: its round ends
			// with this patch, and it is retired (a new writer works in the lead's
			// checkout).
			const nowIso = new Date(now).toISOString();
			await (input.deps?.saveState ?? saveSidekickState)(
				session.id,
				retireSidekickState(
					endSidekickRound(sidekick, {
						now: nowIso,
						outcome: input.outcome,
						patchFiles: patch?.files.length ?? 0,
					}),
					"it ran on a fork from before the shared checkout",
					nowIso,
				),
			).catch(() => {});
			parts.push(
				`Writer ${label} ran on a fork from before the shared checkout, so it is retired after this report: review and apply its patch yourself. Your next writer works in your checkout.`,
			);
		}
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
		return `Writer ${label} worked in your checkout; its changes are uncommitted in your working tree. Review them in place with \`git status\` and \`git diff\` (this round's exact changes could not be listed).`;
	if (!changes.files.length)
		return `Writer ${label} changed no files in your checkout this round.`;
	return [
		`Writer ${label} worked in your checkout: this round changed ${changes.files.length} file${changes.files.length === 1 ? "" : "s"}, uncommitted in your working tree. Review them in place: \`git diff ${base.slice(0, 12)} ${changes.end.slice(0, 12)}\` is this round alone (\`git diff\` and \`git status\` show all uncommitted work).`,
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
	/** The round's classifier (classifySidekick with the variant's role models). */
	readonly classify?: (
		summary: ClassifierInput,
	) => Promise<SidekickClassification>;
	/** Compare-and-set of the sidekick's state (updateSidekickState). */
	readonly updateState?: (
		sessionId: string,
		mutate: (current: SidekickState) => SidekickState | null,
	) => Promise<SidekickState | null>;
	/** Adds the classifier's usage to the session's latest request. */
	readonly addUsage?: (
		sessionId: string,
		usage: ApiTokenUsage,
	) => Promise<unknown>;
	/** Charges the classifier's usage to the turn's other ledgers (an evaluation run). */
	readonly chargeUsage?: (
		usage: ApiTokenUsage,
		key: string,
	) => Promise<unknown>;
};

/** Adds a one-off call's usage to the session's latest request (where turn usage is kept). */
export function addRequestUsage(sessionId: string, usage: ApiTokenUsage) {
	return addSessionRequestUsage(sessionId, (items) => {
		for (let index = items.length - 1; index >= 0; index--) {
			const item = items[index] as SessionItem | undefined;
			if (item?.kind !== "userMessage") continue;
			const next = [...items];
			next[index] = {
				...item,
				apiUsage: addApiTokenUsage(item.apiUsage ?? null, usage),
			};
			return next;
		}
		return null;
	});
}

/**
 * Closes a sidekick's round after its report: records the round (its
 * changed files, end snapshot, evidence and hand-back signals) and the
 * classifier's decision on it, and retires it when it has no rounds left
 * (or was retired meanwhile). A hand_back puts a notice in the report; a
 * switch_model marks the switch for its next compaction. Returns the
 * report's closing lines.
 */
async function endSidekickRoundAndReport(input: {
	readonly sessionId: string;
	readonly userId: string;
	readonly label: string;
	readonly state: SidekickState;
	readonly outcome: SubagentOutcome;
	readonly changes: SidekickRoundChanges | null;
	readonly report: string;
	/** The sidekick's history (this round is the part after its start message). */
	readonly items: readonly SessionItem[];
	readonly model: string | null;
	readonly roleModels?: RoleModels;
	readonly thinLead?: boolean;
	readonly signal?: AbortSignal;
	readonly now: number;
	readonly deps?: SidekickRuntimeDeps;
}) {
	const roundItems = sidekickRoundItems(input.items, input.state.round);
	const kind = currentSidekickRound(input.state)?.kind ?? "build";
	const patchFiles = input.changes?.files.length ?? 0;
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
			files: input.changes?.files ?? [],
			...statLineCounts(input.changes?.stat ?? ""),
		},
		outcome: input.outcome,
		signals,
		canSwitch: !!escalation,
	};
	const { answer, record, usage } = await (
		input.deps?.classify ??
		((summary: ClassifierInput) =>
			classifySidekick({
				userId: input.userId,
				sessionId: input.sessionId,
				roleModels: input.roleModels,
				summary,
				signal: input.signal,
			}))
	)(summary);
	// Its spend counts like any model call's: in the session's usage and the turn's ledgers.
	if (usage) {
		await (input.deps?.addUsage ?? addRequestUsage)(
			input.sessionId,
			usage,
		).catch(() => {});
		await input.deps
			?.chargeUsage?.(usage, `classifier:${record.inputsHash}`)
			.catch(() => {});
	}
	// Applied to the state as stored now: the classifier took a while, and
	// the lead may have stopped (retired) the sidekick meanwhile.
	const close = (current: SidekickState) => {
		const ended = recordSidekickDecision(
			endSidekickRound(current, {
				now: new Date(input.now).toISOString(),
				outcome: input.outcome,
				patchFiles,
				end: input.changes?.end,
				evidence,
				signals,
				pushback: reportPushesBack(input.report),
			}),
			record,
		);
		return answer.decision === "switch_model" && escalation && !ended.retired
			? markSidekickSwitch(ended, {
					to: escalation,
					reason: answer.reason,
					round: current.round,
					at: new Date(input.now).toISOString(),
				})
			: ended;
	};
	const ended =
		(await (input.deps?.updateState ?? updateSidekickState)(
			input.sessionId,
			close,
		).catch(() => null)) ?? close(input.state);
	const switching =
		answer.decision === "switch_model" &&
		!!ended.pendingSwitch &&
		!ended.retired;
	const notice = sidekickDecisionNotice({
		label: input.label,
		decision:
			answer.decision === "switch_model" && !switching
				? "hand_back"
				: answer.decision,
		reason: answer.reason,
		...(switching ? { switchTo: escalation } : {}),
		thin: input.thinLead,
	});
	if (ended.retired)
		return [
			`Writer ${input.label} is retired (${ended.retired.reason}). Start a new writer for more work.`,
			notice,
		]
			.filter(Boolean)
			.join("\n\n");
	return [
		`Writer ${input.label}: ${sidekickRoundLabel(ended)} done. It keeps its context: send feedback or the next brief with ${AGENT_SEND_TOOL} (id ${input.label}); it works in your checkout as it is then, so keep or revert its changes first.`,
		notice,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Lines added and removed, from the summary line of `git diff --stat`. */
function statLineCounts(stat: string) {
	return {
		added: Number(/(\d+) insertions?\(\+\)/.exec(stat)?.[1] ?? 0),
		removed: Number(/(\d+) deletions?\(-\)/.exec(stat)?.[1] ?? 0),
	};
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
