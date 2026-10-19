import type { ModelMessage } from "ai";
import { WorkspaceId } from "#/domain/ids";
import { modelBilling } from "#/domain/model-pricing";
import type { SessionItem } from "#/domain/session-item";
import {
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
	subagentTree as loadSubagentTree,
	mergeSubagentFork,
	recordSubagentStep,
	subagentAncestors,
} from "../adapters/subagents";
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
>;

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
	const childTokens = (
		await descendants(input.session.userId, input.session.id)
	).reduce(
		(total, child) =>
			total + usageTokens(sessionTokenUsage(child.items as SessionItem[])),
		0,
	);
	const state = subagentBudgetState(limits, {
		steps,
		minutes:
			((input.now ?? Date.now()) - Date.parse(input.session.createdAt)) /
			60_000,
		tokens: usageTokens(sessionTokenUsage(input.items)) + childTokens,
	});
	if (state.state === "exhausted")
		throw new SubagentBudgetExhausted(state.reason);
	if (state.state === "wrap-up") {
		const notice = subagentWrapUpNotice(state.reason);
		if (
			!input.messages.some(
				(message) =>
					message.role === "user" &&
					typeof message.content === "string" &&
					message.content.startsWith("Budget nearly used ("),
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
			billing: modelBilling({
				harness: session.harness === "codex" ? "codex" : "api",
				modelId: session.listedModelId,
			}),
		});
	const header = subagentReportHeader({
		label,
		role,
		outcome: input.outcome,
		steps: node?.steps ?? session.agentSteps ?? 0,
		minutes: (now - Date.parse(session.createdAt)) / 60_000,
		tokens: spend.tokens,
		costUsd: spend.costUsd,
		costEstimated: spend.planBilled,
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
			patch = await transferWriterPatch({
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
		await mergeSubagentFork(session.id, {
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

/**
 * Deletes writer forks 30 minutes after their report (the parent has the
 * patch and ref by then); run from the maintenance sweep.
 */
export async function teardownSubagentForks(
	machines: WorkspaceMachines,
	graceMinutes = 30,
) {
	let deleted = 0;
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
