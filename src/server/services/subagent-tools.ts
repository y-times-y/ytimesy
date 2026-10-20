import { randomUUID } from "node:crypto";
import { type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { agentSessionMachineSlug } from "#/domain/agent-session";
import { independentReviewBrief } from "#/domain/checker-brief";
import { latestUserRequestText } from "#/domain/child-task-activity";
import { fusionPairProfile } from "#/domain/fusion-pairs";
import type { LeadMode } from "#/domain/harness-variant";
import { WorkspaceId } from "#/domain/ids";
import type { FailoverConnection } from "#/domain/model-failover";
import { posixShellQuoted } from "#/domain/posix-command";
import {
	type ModelRole,
	type ResolvedChildModel,
	type RoleModels,
	resolveRoleModel,
	roleModelFor,
} from "#/domain/role-models";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import {
	beginSidekickRound,
	harnessExplorationBrief,
	isActiveSidekick,
	latestUserRequestId,
	newSidekickState,
	SIDEKICK_EXPLORE_NOTE,
	type SidekickState,
	sidekickRoundLabel,
	sidekickRoundMessage,
	sidekickRoundsLeft,
	sidekickState,
} from "#/domain/sidekick";
import type { SidekickRoundKind } from "#/domain/sidekick-signals";
import {
	AGENT_SEND_TOOL,
	AGENT_TOOL,
	builderRemaining,
	isReaderRole,
	SUBAGENT_BRIEF_MAX,
	SUBAGENT_ROLES,
	SUBAGENT_TITLE_MAX,
	type SubagentBudget,
	type SubagentPlacement,
	type SubagentRole,
	subagentAdmission,
	subagentPlacement,
} from "#/domain/subagent";
import {
	type SubagentNode,
	type SubagentTreeSession,
	subagentNodeRemaining,
	subagentTree,
} from "#/domain/subagent-tree";
import { budgetTokenWeight } from "#/domain/subagent-usage";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	saveAgentSessionProviderRef,
	saveAgentTaskState,
} from "../adapters/agent-sessions";
import {
	subagentTree as loadSubagentTree,
	mergeSubagentFork,
	requestSubagentStop,
	saveSidekickState,
	saveSubagentSpec,
	subagentAncestors,
	takeSubagentReport,
} from "../adapters/subagents";
import { queueAgentPeerMessage } from "./agent-peer-messaging";
import { openAgentTask } from "./agent-session-machine";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { startPreparedAgentTask } from "./harness-workspace-session";
import { failoverConnections } from "./model-failover";
import { markSidekickRoundStart } from "./sidekick-workspace";
import { retireSidekick } from "./subagent-runtime";
import { forkWriterWorkspace } from "./subagent-writer";
import type { WorkspaceMachines } from "./workspace-machines";

/** What queueAgentPeerMessage delivers at most. */
const PEER_MESSAGE_MAX = 8_000;
/** The longest a reader's caller blocks on wait: true before the report arrives as a message instead. */
const MAX_WAIT_MS = 10 * 60_000;
const WAIT_POLL_MS = 3_000;

/** Everything the tools touch outside themselves; tests pass fakes. */
export type SubagentToolDeps = {
	readonly now: () => number;
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly ancestors: (
		userId: string,
		sessionId: string,
	) => Promise<readonly AgentSessionRecord[]>;
	readonly tree: (
		userId: string,
		rootId: string,
	) => Promise<readonly (SubagentTreeSession & AgentSessionRecord)[]>;
	readonly session: (
		userId: string,
		sessionId: string,
	) => Promise<AgentSessionRecord | null>;
	readonly openTask: typeof openAgentTask;
	readonly saveSpec: typeof saveSubagentSpec;
	readonly fork: typeof forkWriterWorkspace;
	readonly saveProviderRef: typeof saveAgentSessionProviderRef;
	readonly mergeFork: typeof mergeSubagentFork;
	readonly start: (
		scope: Parameters<typeof startPreparedAgentTask>[0],
		taskId: string,
		options?: { readonly reasoning?: string },
	) => Promise<unknown>;
	/** Every route the user can use now (role models are checked against it). */
	readonly routes: (userId: string) => Promise<readonly FailoverConnection[]>;
	readonly markFailed: (sessionId: string) => Promise<unknown>;
	readonly takeReport: typeof takeSubagentReport;
	readonly message: typeof queueAgentPeerMessage;
	readonly stop: typeof requestSubagentStop;
	/** Lead mode fusion: the round's start snapshot, the sidekick's state and retirement. */
	readonly markRoundStart: typeof markSidekickRoundStart;
	readonly saveSidekick: typeof saveSidekickState;
	readonly retireSidekick: typeof retireSidekick;
};

// Resolved at call time, so a test that mocks one of these modules does not
// need every export the tools use.
const defaultDeps: SubagentToolDeps = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			}
			signal.addEventListener("abort", done, { once: true });
		}),
	ancestors: (...args) => subagentAncestors(...args),
	tree: (...args) => loadSubagentTree(...args),
	session: (...args) => agentSessionForOwner(...args),
	openTask: (...args) => openAgentTask(...args),
	saveSpec: (...args) => saveSubagentSpec(...args),
	fork: (...args) => forkWriterWorkspace(...args),
	saveProviderRef: (...args) => saveAgentSessionProviderRef(...args),
	mergeFork: (...args) => mergeSubagentFork(...args),
	start: (scope, taskId, options) =>
		Effect.runPromise(startPreparedAgentTask(scope, taskId, options)),
	routes: (userId) => failoverConnections(userId),
	markFailed: (sessionId) => saveAgentTaskState(sessionId, "failed"),
	takeReport: (...args) => takeSubagentReport(...args),
	message: (...args) => queueAgentPeerMessage(...args),
	stop: (...args) => requestSubagentStop(...args),
	markRoundStart: (...args) => markSidekickRoundStart(...args),
	saveSidekick: (...args) => saveSidekickState(...args),
	retireSidekick: (...args) => retireSidekick(...args),
};

export type SubagentToolContext = {
	/** The unwrapped machines (a fork and the parent's VM are both addressed). */
	readonly machines: WorkspaceMachines;
	/** The calling agent: the builder or a subagent below level 3. */
	readonly parent: AgentSessionRecord;
	readonly workspace: () => Promise<AgentToolWorkspace>;
	readonly signal: AbortSignal;
	/** A durable step's own deadline for blocking calls. */
	readonly waitDeadlineAt?: number;
	/** A model per role (harness variant roleModels); children inherit the parent's model otherwise. */
	readonly roleModels?: RoleModels;
	/** Harness variant lead: fusion makes the root's first writer a persistent sidekick. */
	readonly lead?: LeadMode;
	/**
	 * The parent turn's reasoning effort: a child on another model gets it
	 * unless its roleModels entry sets one (a same-model child inherits the
	 * parent turn's settings when its first turn is sent).
	 */
	readonly parentReasoning?: string;
	/** Harness variant rigor=on: the checker's brief gets the rigor checks. */
	readonly rigor?: boolean;
	/**
	 * Lead mode fusion: called when a sidekick round starts, so the lead's
	 * turn stops writing to the shared checkout at once (fusion-lead.ts).
	 */
	readonly onSidekickRound?: () => void;
	/** Lead mode fusion: resolves once the lead's writing calls already started have finished. */
	readonly leadWritesSettled?: () => Promise<void>;
	/** Lead mode fusion: the lead's background commands still running (they may write while the sidekick works). */
	readonly leadBackgroundCommands?: () => readonly string[];
	readonly deps?: Partial<SubagentToolDeps>;
};

/** A sidekick started before the shared checkout, on its own fork. */
const FORKED_SIDEKICK = "it ran on a fork from before the shared checkout";
function forkedSidekick(session: AgentSessionRecord | undefined) {
	return !!session?.agentFork?.vmId && !session.agentFork.deletedAt;
}

/**
 * Retires an idle sidekick that still has its own fork (started before the
 * shared checkout): its next round starts a fresh sidekick in the lead's
 * checkout instead. True when it was retired.
 */
async function retireForkedSidekick(
	context: SubagentToolContext,
	deps: SubagentToolDeps,
	session: (SubagentTreeSession & AgentSessionRecord) | undefined,
	live: boolean,
) {
	if (
		!session ||
		live ||
		!forkedSidekick(session) ||
		!isActiveSidekick(session)
	)
		return false;
	await deps.retireSidekick(context.machines, session, FORKED_SIDEKICK);
	return true;
}

/** The lead's background commands still running, as a note for the sidekick's round message. */
function backgroundNote(context: SubagentToolContext) {
	const ids = context.leadBackgroundCommands?.() ?? [];
	return ids.length
		? `The lead has background commands still running in this checkout (${ids.join(", ")}); they may write files while you work.`
		: "";
}

const ROLE_TEXT =
	"writer: edits code on a fork of your VM and returns a patch; researcher, reviewer: read-only on your VM; checker: independent pass/fail of your current work against the user's task";
/** Lead mode fusion: the writer is the sidekick, in the lead's own checkout. */
const LEAD_ROLE_TEXT =
	"writer: your sidekick, which works in your own checkout while you wait (its changes stay uncommitted in your working tree for you to review); researcher, reviewer: read-only on your VM; checker: independent pass/fail of your current work against the user's task";

const agentInput = z.object({
	role: z.enum(SUBAGENT_ROLES).describe(ROLE_TEXT),
	title: z.string().min(1).max(SUBAGENT_TITLE_MAX),
	brief: z
		.string()
		.max(SUBAGENT_BRIEF_MAX)
		.optional()
		.describe(
			"Self-contained: goal, context (paths, findings, working commands), constraints, what not to touch, report format. Required except for checker, which takes none.",
		),
	wait: z
		.boolean()
		.optional()
		.describe(
			"Readers only: block until the report (default false: keep working, the report arrives as a message)",
		),
});

/** Lead mode fusion: the lead marks a round as exploration. */
const exploreField = z
	.boolean()
	.optional()
	.describe(
		"Writer (your sidekick) only: an exploration round. It changes no files and returns the relevant file paths, key snippets with line ranges, the check commands and open questions for you to plan from.",
	);

const sendInput = z.object({
	id: z.string().min(1).max(20).describe('The agent id, e.g. "1.2"'),
	message: z
		.string()
		.min(1)
		.max(8_000)
		.optional()
		.describe("Steering, delivered at the agent's next step"),
	stop: z.boolean().optional().describe("Wrap up now and report what is done"),
});

type Tree = {
	root: AgentSessionRecord;
	sessions: readonly (SubagentTreeSession & AgentSessionRecord)[];
	nodes: readonly SubagentNode[];
};

/**
 * The builder's delegation tools (docs/subagents.md): `agent` starts a
 * child in the background with a self-contained brief, `agent_send` steers
 * or stops one. Children's reports arrive as messages. Admission (depth,
 * live children, tree size, budget) is checked first; a refusal is a tool
 * error telling the agent to do the work itself.
 */
export function subagentTools(context: SubagentToolContext): ToolSet {
	const deps = { ...defaultDeps, ...context.deps };
	const { parent } = context;
	const loadTree = () => loadTreeFor(deps, parent);

	// Lead mode fusion: the root's writer is its persistent sidekick, and the
	// lead may mark a round as exploration.
	const isLead = context.lead === "fusion" && !parent.parentSessionId;
	const requestKey = () =>
		latestUserRequestId(sessionItemsFromUnknown(parent.items));
	const agent = tool({
		description: isLead
			? "Start a subagent. It sees only your brief (never this conversation), works within its own budget and reports back as a message. Your writer is your sidekick: it works directly in your checkout, you wait while it works (the runtime holds your turn until its report), and you review its changes in place with git diff. Readers share your VM read-only and run in the background. Returns its id and budget."
			: "Start a subagent in the background. It sees only your brief (never this conversation), works within its own budget and reports back as a message; keep working meanwhile. Writers get a fork of your VM (your uncommitted work included) and return a patch and git ref for you to review and apply; readers share your VM read-only. Returns its id and budget.",
		inputSchema: isLead
			? agentInput.extend({
					role: z.enum(SUBAGENT_ROLES).describe(LEAD_ROLE_TEXT),
					explore: exploreField,
				})
			: agentInput,
		execute: async (
			input: z.infer<typeof agentInput> & { explore?: boolean },
		) => {
			const role: SubagentRole = input.role;
			// Before any await: a write in the same batch must already see the round.
			if (isLead && role === "writer") context.onSidekickRound?.();
			if (role === "checker" && input.brief?.trim())
				throw new Error(
					"A checker takes no brief: the runtime gives it the user's task and your deliverable, so its verdict stays independent.",
				);
			if (role !== "checker" && !input.brief?.trim())
				throw new Error("A brief is required for this role.");
			if (input.wait && !isReaderRole(role))
				throw new Error(
					"Only readers can be awaited; a writer's report arrives as a message.",
				);
			if (role === "writer" && isReaderRole(parent.agentRole))
				throw new Error(
					"A read-only agent cannot start a writer; report what should change instead.",
				);
			if (input.explore && !(isLead && role === "writer"))
				throw new Error("explore applies only to your sidekick (a writer).");
			// Lead mode fusion: the root's writer is its one persistent sidekick.
			const sidekick = isLead && role === "writer";
			if (sidekick) {
				const tree = await loadTree();
				const alive = tree.nodes.find(
					(node) =>
						node.parentId === parent.id &&
						isActiveSidekick(
							tree.sessions.find((session) => session.id === node.id),
						),
				);
				const replaced =
					alive &&
					(await retireForkedSidekick(
						context,
						deps,
						tree.sessions.find((session) => session.id === alive.id),
						alive.live,
					));
				if (alive && !replaced)
					throw new Error(
						`Your sidekick ${alive.label} is still available (${alive.live ? "working" : "idle"}): send it the next brief or feedback with ${AGENT_SEND_TOOL} (id ${alive.label}) instead of starting another writer. To replace it, stop it first (${AGENT_SEND_TOOL} with stop: true).`,
					);
			}
			const workspace = await context.workspace();
			const { childId, budget, placement, model, notice } = await spawnSubagent(
				context,
				deps,
				{
					role,
					modelRole: role,
					sidekick: sidekick
						? {
								kind: input.explore ? "explore" : "build",
								requestKey: requestKey(),
							}
						: undefined,
					title: input.title,
					brief: async (tree) =>
						role === "checker"
							? await checkerBriefFor(context, tree.root, workspace)
							: `${(input.brief as string).trim()}${input.explore ? `\n\n${SIDEKICK_EXPLORE_NOTE}` : ""}`,
				},
				workspace,
			);
			const label =
				(await loadTree()).nodes.find((node) => node.id === childId)?.label ??
				"?";
			const started = {
				id: label,
				taskId: childId,
				role,
				vm: placement,
				model: model.label,
				budget: publicBudget(budget, model.listedModelId),
				...(notice ? { modelNotice: notice } : {}),
				...(budget.sidekick
					? {
							sidekick: `Your persistent sidekick for this chat: up to ${budget.sidekick.maxRounds} rounds per user request, steps and minutes per round. It works in your checkout; you wait while it works and review its changes in place after its report. Then send feedback or the next brief with ${AGENT_SEND_TOOL} (also on the user's later messages); it keeps its context.`,
						}
					: {}),
			};
			if (!input.wait) return started;
			const report = await waitForReport(context, deps, childId, budget);
			return report
				? { ...started, ...report }
				: {
						...started,
						note: "Still running; its report will arrive as a message.",
					};
		},
	});

	const agentSend = tool({
		description: isLead
			? "Steer one of your running subagents (message, delivered at its next step) or stop it (it wraps up and reports what is done). A message to your idle sidekick starts its next round in your checkout; you wait for its report. A finished reader resumes with the message."
			: "Steer one of your running subagents (message, delivered at its next step) or stop it (it wraps up and reports what is done). A finished agent resumes with the message.",
		inputSchema: isLead
			? sendInput.extend({ explore: exploreField })
			: sendInput,
		execute: async (
			input: z.infer<typeof sendInput> & { explore?: boolean },
		) => {
			if (!input.message && !input.stop)
				throw new Error("Pass a message, stop: true, or both.");
			// Before any await: a message usually starts a sidekick round, and a
			// write in the same batch must already see it (the next step's gate
			// lifts this when no round runs).
			if (isLead && input.message && !input.stop) context.onSidekickRound?.();
			const tree = await loadTree();
			const target = tree.nodes.find(
				(node) => node.label === input.id && node.parentId === parent.id,
			);
			if (!target)
				throw new Error(
					`No agent ${input.id} of yours. Your agents: ${
						tree.nodes
							.filter((node) => node.parentId === parent.id)
							.map((node) => `${node.label} (${node.role}, ${node.state})`)
							.join(", ") || "none"
					}.`,
				);
			const session = tree.sessions.find((entry) => entry.id === target.id);
			const sidekick = sidekickState(session);
			if (
				sidekick &&
				session &&
				input.message &&
				!input.stop &&
				(await retireForkedSidekick(context, deps, session, target.live))
			) {
				const workspace = await context.workspace();
				const spawned = await spawnSubagent(
					context,
					deps,
					{
						role: "writer",
						modelRole: "writer",
						title: session.title,
						sidekick: {
							kind: input.explore ? "explore" : "build",
							requestKey: requestKey(),
						},
						brief: async () =>
							`${input.message?.trim()}${input.explore ? `\n\n${SIDEKICK_EXPLORE_NOTE}` : ""}`,
					},
					workspace,
				);
				const label =
					(await loadTree()).nodes.find((node) => node.id === spawned.childId)
						?.label ?? "?";
				return {
					id: label,
					status: `sidekick ${target.label} ran on a fork from before the shared checkout and is retired; sidekick ${label} took this brief in your checkout, round 1/${spawned.budget.sidekick?.maxRounds ?? "?"} started`,
					note: `Use id ${label} from now on.`,
					delivery: "now",
				};
			}
			if (sidekick && session) {
				const handled = await sendToSidekick(context, deps, {
					target,
					session,
					state: sidekick,
					message: input.message,
					stop: !!input.stop,
					kind: input.explore ? "explore" : "build",
					requestKey: requestKey(),
				});
				if (handled) return handled;
			}
			if (input.stop) await deps.stop(target.id);
			const text = [
				input.message,
				input.stop
					? "Your parent asked you to stop: start nothing new, finish the step you are on, and write your report now (what is done, how it was verified, what is not)."
					: undefined,
			]
				.filter(Boolean)
				.join("\n\n");
			await deps.message(parent, target.id, text, randomUUID());
			return {
				id: target.label,
				status: input.stop ? "stopping" : "message queued",
				delivery: "next step",
			};
		},
	});

	return { [AGENT_TOOL]: agent, [AGENT_SEND_TOOL]: agentSend };
}

type LoadedTree = Tree & { level: number };

/**
 * agent_send to a sidekick (lead mode fusion). Stop retires it. A message
 * while it is idle starts its next round in the lead's checkout: the
 * checkout is snapshotted (the round's changes are diffed against it), the
 * round's budget starts, and the message arrives. A message while it works
 * is ordinary steering (null: the caller handles it).
 */
async function sendToSidekick(
	context: SubagentToolContext,
	deps: SubagentToolDeps,
	input: {
		readonly target: SubagentNode;
		readonly session: SubagentTreeSession & AgentSessionRecord;
		readonly state: SidekickState;
		readonly message?: string;
		readonly stop: boolean;
		readonly kind: SidekickRoundKind;
		readonly requestKey?: string;
	},
) {
	const { target, session, state } = input;
	if (input.stop) {
		const status = await deps.retireSidekick(
			context.machines,
			session,
			"stopped by the lead",
		);
		if (status !== "stopping")
			return {
				id: target.label,
				status: "retired",
				note: "A new writer becomes your next sidekick.",
			};
		return null;
	}
	if (state.retired)
		throw new Error(
			`Sidekick ${target.label} is retired (${state.retired.reason}). Start a new writer, or do this yourself.`,
		);
	if (target.live) return null;
	if (!sidekickRoundsLeft(state, input.requestKey))
		throw new Error(
			`Sidekick ${target.label} has used all ${state.maxRounds} rounds. Take over, or stop it and start a new writer.`,
		);
	const round = state.round + 1;
	// The runtime's heading goes in front; delivery takes 8,000 characters.
	const note = sidekickRoundMessage({
		round,
		maxRounds: state.maxRounds,
		message: "",
		turnFirstRound: round,
	}).length;
	if (note + (input.message ?? "").trim().length > PEER_MESSAGE_MAX)
		throw new Error(
			`A sidekick round's message takes at most ${PEER_MESSAGE_MAX - note} characters; shorten it or point to a file in your checkout (the sidekick works in it).`,
		);
	const next = await beginRound(context, deps, {
		target,
		state,
		round,
		kind: input.kind,
		requestKey: input.requestKey,
	});
	await deps.message(
		context.parent,
		target.id,
		sidekickRoundMessage({
			round,
			maxRounds: state.maxRounds,
			message: [input.message ?? "", backgroundNote(context)]
				.filter(Boolean)
				.join("\n\n"),
			turnFirstRound: next.turnFirstRound,
			kind: input.kind,
		}),
		randomUUID(),
	);
	return {
		id: target.label,
		status: `${sidekickRoundLabel(next)} started`,
		checkout:
			"it works in your checkout now; you wait for its report, then review its changes in place",
		...(backgroundNote(context)
			? {
					backgroundCommands:
						"Your background commands are still running and may write while it works; stop them (ytimesy-job stop) if they touch its files.",
				}
			: {}),
		...(next.pendingSwitch
			? {
					model: `this round starts by compacting its context; it continues on ${next.pendingSwitch.to} (same session)`,
				}
			: {}),
		delivery: "now",
	};
}

/**
 * Starts a sidekick's next round: snapshots the lead's checkout (the
 * round's base) and saves the round's state. The lead stops writing at once.
 */
async function beginRound(
	context: SubagentToolContext,
	deps: SubagentToolDeps,
	input: {
		readonly target: SubagentNode;
		readonly state: SidekickState;
		readonly round: number;
		readonly kind: SidekickRoundKind;
		readonly requestKey?: string;
	},
) {
	context.onSidekickRound?.();
	// A write the lead started earlier in this batch finishes before the snapshot.
	await context.leadWritesSettled?.();
	const workspace = await context.workspace();
	const base = await roundBase(
		context,
		deps,
		workspace,
		input.target.label,
		input.round,
	);
	const next = beginSidekickRound(input.state, {
		now: new Date(deps.now()).toISOString(),
		steps: input.target.steps,
		tokens: input.target.subtree.budgetTokens,
		base,
		kind: input.kind,
		requestKey: input.requestKey,
	});
	await deps.saveSidekick(input.target.id, next, { clearStop: true });
	return next;
}

/** The round's start snapshot; a failed snapshot only costs the round's precise diff. */
async function roundBase(
	context: SubagentToolContext,
	deps: SubagentToolDeps,
	workspace: AgentToolWorkspace,
	label: string,
	round: number,
) {
	try {
		return await deps.markRoundStart({
			machines: context.machines,
			vm: WorkspaceId(workspace.vm),
			label,
			round,
		});
	} catch (cause) {
		console.warn("A sidekick round's start could not be snapshotted.", {
			message: cause instanceof Error ? cause.message.slice(0, 200) : "",
		});
		return undefined;
	}
}

/**
 * Lead mode fusion's first step (Devin Fusion: the user's task, then the
 * sidekick's code exploration): before the lead's first model call for a
 * user request, the harness starts an exploration round with a brief built
 * from the request. An idle sidekick from the chat's earlier requests takes
 * it as its next round; otherwise a new sidekick starts. Null when the lead
 * has a working sidekick or none can start (the lead then plans alone).
 */
export async function startHarnessExploration(
	context: SubagentToolContext,
	input: { readonly requestKey: string; readonly requestText: string },
) {
	const deps = { ...defaultDeps, ...context.deps };
	const { parent } = context;
	const tree = await loadTreeFor(deps, parent);
	const node = tree.nodes.find(
		(entry) =>
			entry.parentId === parent.id &&
			isActiveSidekick(
				tree.sessions.find((session) => session.id === entry.id),
			),
	);
	const brief = harnessExplorationBrief(input.requestText);
	const forked =
		!!node &&
		(await retireForkedSidekick(
			context,
			deps,
			tree.sessions.find((entry) => entry.id === node.id),
			node.live,
		));
	if (node && !forked) {
		const session = tree.sessions.find((entry) => entry.id === node.id);
		const state = sidekickState(session);
		if (!session || !state || node.live) return null;
		if (!sidekickRoundsLeft(state, input.requestKey)) return null;
		const round = state.round + 1;
		const next = await beginRound(context, deps, {
			target: node,
			state,
			round,
			kind: "explore",
			requestKey: input.requestKey,
		});
		await deps.message(
			parent,
			node.id,
			sidekickRoundMessage({
				round,
				maxRounds: state.maxRounds,
				message: [
					brief.slice(0, PEER_MESSAGE_MAX - 800),
					backgroundNote(context),
				]
					.filter(Boolean)
					.join("\n\n"),
				turnFirstRound: next.turnFirstRound,
			}),
			randomUUID(),
		);
		return { id: node.label, round };
	}
	const workspace = await context.workspace();
	const { childId } = await spawnSubagent(
		context,
		deps,
		{
			role: "writer",
			modelRole: "writer",
			title: "Explore the code for this request",
			sidekick: { kind: "explore", requestKey: input.requestKey },
			brief: async () => brief,
		},
		workspace,
	);
	const label =
		(await loadTreeFor(deps, parent)).nodes.find(
			(entry) => entry.id === childId,
		)?.label ?? "?";
	return { id: label, round: 1 };
}

async function loadTreeFor(
	deps: SubagentToolDeps,
	parent: AgentSessionRecord,
): Promise<LoadedTree> {
	const ancestors = await deps.ancestors(parent.userId, parent.id);
	const root = ancestors.at(-1) ?? parent;
	const sessions = await deps.tree(parent.userId, root.id);
	return {
		root,
		sessions,
		level: ancestors.length,
		nodes: subagentTree(root.id, sessions, deps.now()).nodes,
	};
}

/**
 * Admission, placement and start of one child: the agent tool's path, and
 * the runtime's for children it starts itself (the attempt loop's checker
 * and judge). `cap` lowers the admitted budget, never raises it.
 */
async function spawnSubagent(
	context: SubagentToolContext,
	deps: SubagentToolDeps,
	input: {
		readonly role: SubagentRole;
		/** Which roleModels entry applies (the judge is a reviewer with its own entry). */
		readonly modelRole: ModelRole;
		readonly title: string;
		readonly brief: (tree: LoadedTree) => Promise<string>;
		readonly cap?: Partial<SubagentBudget>;
		/** Lead mode fusion: a writer that persists across rounds, and its first round. */
		readonly sidekick?: {
			readonly kind: SidekickRoundKind;
			readonly requestKey?: string;
		};
	},
	workspace: AgentToolWorkspace,
) {
	const { parent } = context;
	const { role } = input;
	if (!parent.listedModelId)
		throw new Error("Your session has no model for a subagent to inherit.");
	const { model, notice } = await childModel(
		context,
		deps,
		input.modelRole,
		parent.listedModelId,
	);
	const tree = await loadTreeFor(deps, parent);
	const own = tree.nodes.find((node) => node.id === parent.id);
	const parentRemaining = own
		? subagentNodeRemaining(own)
		: builderRemaining(
				subagentTree(tree.root.id, tree.sessions, deps.now()).total
					.budgetTokens,
			);
	const admission = subagentAdmission({
		parentLevel: tree.level,
		liveChildrenOfParent: tree.nodes.filter(
			(node) => node.parentId === parent.id && node.live,
		).length,
		liveInTree: tree.nodes.filter((node) => node.live).length,
		parentRemaining: parentRemaining ?? builderRemaining(0),
	});
	if (!admission.admitted) throw new Error(admission.reason);
	let budget: SubagentBudget = {
		steps: Math.min(admission.budget.steps, input.cap?.steps ?? Infinity),
		minutes: Math.min(admission.budget.minutes, input.cap?.minutes ?? Infinity),
		tokens: Math.min(admission.budget.tokens, input.cap?.tokens ?? Infinity),
		// Counted in the builder's tokens: a cheaper child's tokens weigh less.
		...(tree.root.listedModelId ? { priceBasis: tree.root.listedModelId } : {}),
	};
	const brief = [
		await input.brief(tree),
		input.sidekick ? backgroundNote(context) : "",
	]
		.filter(Boolean)
		.join("\n\n");
	// Lead mode fusion's sidekick works in the lead's own checkout.
	const placement: SubagentPlacement = input.sidekick
		? "shared-writer"
		: subagentPlacement(role);
	if (input.sidekick) {
		context.onSidekickRound?.();
		await context.leadWritesSettled?.();
	}
	const child = await deps.openTask({
		userId: parent.userId,
		projectId: parent.projectId,
		parentSessionId: parent.id,
		title: input.title,
		harness: model.harness,
		modelId: model.listedModelId,
		prompt: brief,
		placement: placement === "fork" ? "fresh" : "shared",
		access: placement === "shared-read-only" ? "read_only" : "read_write",
		...(placement === "shared-writer" ? { sharedWriter: true } : {}),
	});
	const childId = child.id;
	try {
		if (input.sidekick)
			budget = {
				...budget,
				sidekick: newSidekickState(budget, new Date(deps.now()).toISOString(), {
					...input.sidekick,
					model: model.listedModelId,
					pair: fusionPairProfile(parent.listedModelId, model.listedModelId),
				}),
			};
		await deps.saveSpec(parent.userId, childId, { role, budget });
		// Round 1's base: the lead's checkout before the sidekick starts.
		if (budget.sidekick) {
			const label = (await loadTreeFor(deps, parent)).nodes.find(
				(node) => node.id === childId,
			)?.label;
			const base = label
				? await roundBase(context, deps, workspace, label, 1)
				: undefined;
			if (base) {
				const sidekick: SidekickState = {
					...budget.sidekick,
					rounds: budget.sidekick.rounds.map((round) =>
						round.n === 1 ? { ...round, base } : round,
					),
				};
				budget = { ...budget, sidekick };
				await deps.saveSidekick(childId, sidekick);
			}
		}
		if (placement === "fork") {
			const fork = await deps.fork({
				machines: context.machines,
				parentVm: workspace.vm,
				slug: agentSessionMachineSlug(childId),
			});
			await deps.saveProviderRef(childId, fork.vm);
			await deps.mergeFork(childId, {
				vmId: fork.vm,
				sourceVmId: workspace.vm,
				forkMs: fork.forkMs,
				bootedAt: new Date(deps.now()).toISOString(),
				base: fork.base,
				parentHead: fork.parentHead,
			});
		}
		await deps.start(
			{
				userId: parent.userId,
				projectId: parent.projectId,
				sessionId: parent.id,
				harnessId: parent.harness,
				createNew: false,
			},
			childId,
			model.reasoning ? { reasoning: model.reasoning } : undefined,
		);
	} catch (cause) {
		await deps.markFailed(childId).catch(() => {});
		throw cause;
	}
	return { childId, budget, placement, model, notice };
}

/**
 * The child's model: its role's entry in roleModels when the user can use
 * that route (an API child under a Codex builder and the reverse are both
 * fine), else the parent's, with a notice when an entry was set but unusable.
 */
async function childModel(
	context: SubagentToolContext,
	deps: SubagentToolDeps,
	role: ModelRole,
	parentModel: string,
): Promise<{ model: ResolvedChildModel; notice?: string }> {
	const inherited: ResolvedChildModel = {
		harness: context.parent.harness,
		listedModelId: parentModel,
		label: parentModel,
	};
	if (!roleModelFor(context.roleModels, role)) return { model: inherited };
	let connections: readonly FailoverConnection[];
	try {
		connections = await deps.routes(context.parent.userId);
	} catch {
		return {
			model: inherited,
			notice: `Could not list this account's model routes; this ${role} runs on the parent's model ${parentModel}.`,
		};
	}
	const resolved = resolveRoleModel({
		role,
		roleModels: context.roleModels,
		connections,
		parentModel,
		parentEffort: context.parentReasoning,
	});
	if (resolved.kind === "inherit") return { model: inherited };
	if (resolved.kind === "fallback")
		return { model: inherited, notice: resolved.notice };
	return { model: resolved.model, notice: resolved.notice };
}

/**
 * Starts a read-only subagent with a brief the runtime wrote (the builder never
 * adds to it): the attempt loop's checker and tiebreak judge. Its report is
 * taken by the runtime, not delivered to the builder.
 */
export async function startRuntimeSubagent(
	context: SubagentToolContext,
	input: {
		readonly role: "checker" | "reviewer";
		/** The roleModels entry to use; the role's own by default (the tiebreak judge passes "judge"). */
		readonly modelRole?: ModelRole;
		readonly title: string;
		readonly brief: string;
		readonly cap?: Partial<SubagentBudget>;
	},
) {
	const deps = { ...defaultDeps, ...context.deps };
	const workspace = await context.workspace();
	const { childId, budget, model, notice } = await spawnSubagent(
		context,
		deps,
		{
			role: input.role,
			modelRole: input.modelRole ?? input.role,
			title: input.title.slice(0, SUBAGENT_TITLE_MAX),
			brief: async () => input.brief,
			cap: input.cap,
		},
		workspace,
	);
	return {
		sessionId: childId,
		budget,
		model: {
			harness: model.harness,
			modelId: model.listedModelId,
			...(model.reasoning ? { reasoning: model.reasoning } : {}),
		},
		...(notice ? { notice } : {}),
	};
}

/** What the agent tool reports: tokens in the child's own model when it is priced differently. */
function publicBudget(budget: SubagentBudget, childModelId: string) {
	const weight = budgetTokenWeight(childModelId, budget.priceBasis);
	return {
		steps: budget.steps,
		minutes: budget.minutes,
		tokens: Math.floor(budget.tokens / weight),
	};
}

async function checkerBriefFor(
	context: SubagentToolContext,
	root: AgentSessionRecord,
	workspace: AgentToolWorkspace,
) {
	const rootSession =
		root.items === null || root.items === undefined
			? await (context.deps?.session ?? agentSessionForOwner)(
					root.userId,
					root.id,
				)
			: root;
	const taskText = latestUserRequestText(
		sessionItemsFromUnknown(rootSession?.items),
	);
	if (!taskText.trim())
		throw new Error("There is no user task for a checker to check.");
	const status = await context.machines.exec(
		WorkspaceId(workspace.vm),
		`git -C ${posixShellQuoted(workspace.cwd)} status --porcelain=v1 --untracked-files=all`,
		30_000,
	);
	const changedFiles = status.stdout
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter(Boolean);
	return independentReviewBrief({
		taskText,
		checkout: workspace.cwd,
		changedFiles,
		scratch: "$HOME",
		rigor: context.rigor,
	});
}

async function waitForReport(
	context: SubagentToolContext,
	deps: SubagentToolDeps,
	childId: string,
	budget: SubagentBudget,
) {
	const deadline = Math.min(
		deps.now() + Math.min(MAX_WAIT_MS, budget.minutes * 60_000),
		context.waitDeadlineAt ?? Number.POSITIVE_INFINITY,
	);
	while (deps.now() < deadline && !context.signal.aborted) {
		const taken = await deps.takeReport(childId);
		if (taken) return { outcome: taken.outcome, report: taken.report };
		await deps.sleep(WAIT_POLL_MS, context.signal);
	}
	return null;
}
