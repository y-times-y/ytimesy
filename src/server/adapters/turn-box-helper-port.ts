import type { ModelMessage } from "ai";
import {
	CHECKER_FORCED_FINAL_MARK,
	hasCheckerFinalNotice,
} from "#/domain/checker-brief";
import type { SessionItem } from "#/domain/session-item";
import { isSideChat } from "#/domain/side-chat";
import type { SubagentRole } from "#/domain/subagent";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";
import { subagentReport } from "../services/subagent-runtime";
import { subagentMemory } from "../services/turn-memory";
import type { WorkspaceMachines } from "../services/workspace-machines";
import {
	type AgentSessionRecord,
	agentSessionMetadataForOwner,
	descendantTokenUsageItemsForOwner,
} from "./agent-sessions";
import { saveAgentTaskResultAndEvent } from "./agent-task-events";
import type { ApiTurn } from "./api-turns";
import { recordSubagentStep } from "./subagents";

/**
 * A helper's own turn on a box (docs/turn-runner-boxes.md, "The super agent
 * and helpers on a box"): the edge counts its steps against its budget and
 * reads its own helpers' token use (only for the turn's own chat, which must
 * be a helper with a role; the record is read here, never taken from the
 * box), and writes its report to the parent when the turn settles (for a
 * writer, moving its patch into the parent's checkout with the edge's
 * machines).
 */
export type TurnBoxHelperDeps = {
	readonly machines?: () => WorkspaceMachines;
	/** Test hooks (default: the product's). */
	readonly owner?: typeof agentSessionMetadataForOwner;
	readonly recordStep?: typeof recordSubagentStep;
	readonly descendantUsage?: typeof descendantTokenUsageItemsForOwner;
	readonly report?: typeof subagentReport;
};

async function ownHelper(turn: ApiTurn, deps: TurnBoxHelperDeps) {
	const chat = await (deps.owner ?? agentSessionMetadataForOwner)(
		turn.user_id,
		turn.session_id,
	);
	if (!chat?.parentSessionId || !chat.agentRole)
		throw new TurnBoxPortForbidden("helper:session");
	return chat;
}

export async function helperStepPort(
	turn: ApiTurn,
	call: { readonly op: "record" | "descendantUsage" },
	deps: TurnBoxHelperDeps = {},
): Promise<unknown> {
	const chat = await ownHelper(turn, deps);
	return call.op === "record"
		? (deps.recordStep ?? recordSubagentStep)(chat.id)
		: (deps.descendantUsage ?? descendantTokenUsageItemsForOwner)(
				turn.user_id,
				chat.id,
			);
}

/**
 * A helper turn on a box settled: its report goes to the parent as at the end
 * of `runApiTurn` (completed: its final words; failed: the failure and what it
 * said so far, for a writer the partial patch), saved as the task's result and
 * its event queued. Side chats and cancelled turns report nothing, as there.
 */
export async function settleHelperReport(
	turn: ApiTurn,
	owner: Omit<AgentSessionRecord, "items">,
	input: {
		readonly state: "completed" | "failed" | "cancelled";
		readonly items: readonly SessionItem[];
	},
	deps: TurnBoxHelperDeps & {
		readonly machines: () => WorkspaceMachines;
		readonly applyToThread?: () => Promise<boolean>;
		readonly save?: typeof saveAgentTaskResultAndEvent;
		readonly enqueue?: (eventId: string) => Promise<unknown>;
	},
): Promise<string | null> {
	if (!owner.parentSessionId || isSideChat(owner)) return null;
	if (input.state === "cancelled") return null;
	const items = input.items;
	const said = (from: number) =>
		items
			.slice(from)
			.filter((item) => item.kind === "agentMessage")
			.map((item) => (item as { text: string }).text)
			.join("\n");
	const report = deps.report ?? subagentReport;
	const applyToThread = (await deps.applyToThread?.().catch(() => false))
		? { applyToThread: true }
		: {};
	let summary: string;
	if (input.state === "completed") {
		let lastUser = items.length - 1;
		while (lastUser >= 0 && items[lastUser]?.kind !== "userMessage") lastUser--;
		const messages = (turn as { messages?: ModelMessage[] }).messages ?? [];
		summary = await report({
			machines: deps.machines(),
			session: owner,
			items,
			outcome: "finished",
			text: `${said(lastUser + 1).slice(-9000) || "(no final report)"}${
				owner.agentRole === "checker" && hasCheckerFinalNotice(messages)
					? `\n${CHECKER_FORCED_FINAL_MARK}`
					: ""
			}`,
			...applyToThread,
		});
	} else {
		const failure =
			[...items]
				.reverse()
				.find((item) => item.kind === "error")
				?.message?.trim() || "The helper's turn failed.";
		summary = owner.agentRole
			? await report({
					machines: deps.machines(),
					session: owner,
					items,
					outcome: failure.startsWith("Budget exhausted (")
						? "budget exhausted"
						: "failed",
					text: [failure, said(0).slice(-6000)].filter(Boolean).join("\n\n"),
					...applyToThread,
				}).catch(() => failure)
			: failure;
	}
	const eventId = await (deps.save ?? saveAgentTaskResultAndEvent)({
		sessionId: owner.id,
		turnId: turn.id,
		eventType: input.state === "completed" ? "completed" : "failed",
		summary,
	});
	if (eventId)
		await (
			deps.enqueue ??
			(async (id: string) =>
				(await import("../jobs/queue")).enqueueAgentTaskEvent(id))
		)(eventId).catch(() => {});
	return summary;
}

/**
 * A helper's read-only memory on a box: built here in every request (a
 * TurnMemory-like value holds promises a Worker cannot settle in a later
 * request) for the turn's own helper chat and its role.
 */
export async function helperMemoryPort(
	turn: ApiTurn,
	call: {
		readonly op: "available" | "tool" | "attach";
		readonly wording?: string;
		readonly tool?: "search_memory" | "read_memory";
		readonly input?: unknown;
		readonly messages?: ModelMessage[];
		readonly items?: SessionItem[];
	},
	deps: TurnBoxHelperDeps & { readonly memory?: typeof subagentMemory } = {},
): Promise<unknown> {
	const chat = await ownHelper(turn, deps);
	const memory = await (deps.memory ?? subagentMemory)(
		{
			id: chat.id,
			userId: turn.user_id,
			projectId: chat.projectId ?? null,
			role: chat.agentRole as SubagentRole,
		},
		call.wording ? { wording: call.wording as never } : {},
	).catch(() => null);
	if (call.op === "available") return memory !== null;
	if (!memory) return null;
	if (call.op === "attach")
		return memory.attach(call.messages ?? [], call.items ?? []);
	const run = call.tool ? memory.tools[call.tool]?.execute : undefined;
	if (!run) throw new TurnBoxPortForbidden("helper:memory-tool");
	return run(call.input as never, {
		toolCallId: "box",
		messages: [],
	} as never);
}
