import { randomUUID } from "node:crypto";
import { type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { agentSessionMachineSlug } from "#/domain/agent-session";
import { independentReviewBrief } from "#/domain/checker-brief";
import { latestUserRequestText } from "#/domain/child-task-activity";
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
	isActiveSidekick,
	newSidekickState,
	type SidekickState,
	sidekickRoundLabel,
	sidekickRoundMessage,
	sidekickRoundsLeft,
	sidekickState,
} from "#/domain/sidekick";
import {
	AGENT_SEND_TOOL,
	AGENT_TOOL,
	builderRemaining,
	isReaderRole,
	SUBAGENT_BRIEF_MAX,
	SUBAGENT_ROLES,
	SUBAGENT_TITLE_MAX,
	type SubagentBudget,
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
import { syncSidekickFork } from "./sidekick-sync";
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
	/** Lead mode fusion: the sidekick's fork sync, state and retirement. */
	readonly syncSidekick: typeof syncSidekickFork;
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
		Effect.runPromise(
			startPreparedAgentTask(scope, taskId, undefined, options),
		),
	routes: (userId) => failoverConnections(userId),
	markFailed: (sessionId) => saveAgentTaskState(sessionId, "failed"),
	takeReport: (...args) => takeSubagentReport(...args),
	message: (...args) => queueAgentPeerMessage(...args),
	stop: (...args) => requestSubagentStop(...args),
	syncSidekick: (...args) => syncSidekickFork(...args),
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
	readonly deps?: Partial<SubagentToolDeps>;
};

const agentInput = z.object({
	role: z
		.enum(SUBAGENT_ROLES)
		.describe(
			"writer: edits code on a fork of your VM and returns a patch; researcher, reviewer: read-only on your VM; checker: independent pass/fail of your current work against the user's task",
		),
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

	const agent = tool({
		description:
			"Start a subagent in the background. It sees only your brief (never this conversation), works within its own budget and reports back as a message; keep working meanwhile. Writers get a fork of your VM (your uncommitted work included) and return a patch and git ref for you to review and apply; readers share your VM read-only. Returns its id and budget.",
		inputSchema: agentInput,
		execute: async (input) => {
			const role: SubagentRole = input.role;
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
			// Lead mode fusion: the root's writer is its one persistent sidekick.
			const sidekick =
				context.lead === "fusion" &&
				role === "writer" &&
				!parent.parentSessionId;
			if (sidekick) {
				const tree = await loadTree();
				const alive = tree.nodes.find(
					(node) =>
						node.parentId === parent.id &&
						isActiveSidekick(
							tree.sessions.find((session) => session.id === node.id),
						),
				);
				if (alive)
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
					sidekick,
					title: input.title,
					brief: async (tree) =>
						role === "checker"
							? await checkerBriefFor(context, tree.root, workspace)
							: (input.brief as string).trim(),
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
							sidekick: `Your persistent sidekick: up to ${budget.sidekick.maxRounds} rounds, steps and minutes per round. After its report, send feedback or the next brief with ${AGENT_SEND_TOOL}; it keeps its context, and its fork is synced with your checkout before each round.`,
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
		description:
			"Steer one of your running subagents (message, delivered at its next step) or stop it (it wraps up and reports what is done). A finished agent resumes with the message.",
		inputSchema: sendInput,
		execute: async (input) => {
			if (!input.message && !input.stop)
				throw new Error("Pass a message, stop: true, or both.");
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
			if (sidekick && session) {
				const handled = await sendToSidekick(context, deps, {
					target,
					session,
					state: sidekick,
					message: input.message,
					stop: !!input.stop,
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
 * agent_send to a sidekick (lead mode fusion). Stop retires it (an idle
 * one's fork is deleted now). A message while it is idle starts its next
 * round: the fork is synced with the lead's checkout, the round's budget
 * starts, and the message arrives with how the checkout changed. A message
 * while it works is ordinary steering (null: the caller handles it).
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
				note: "Its fork is deleted; a new writer becomes your next sidekick.",
			};
		return null;
	}
	if (state.retired)
		throw new Error(
			`Sidekick ${target.label} is retired (${state.retired.reason}). Start a new writer, or do this yourself.`,
		);
	if (target.live) return null;
	if (!sidekickRoundsLeft(state))
		throw new Error(
			`Sidekick ${target.label} has used all ${state.maxRounds} rounds. Take over, or stop it and start a new writer.`,
		);
	const fork = session.agentFork;
	if (!fork?.vmId || fork.deletedAt || !fork.base || !fork.parentHead)
		throw new Error(
			`Sidekick ${target.label}'s fork is gone; stop it and start a new writer.`,
		);
	const round = state.round + 1;
	// The runtime's note on the checkout goes in front; delivery takes 8,000 characters.
	const note = sidekickRoundMessage({
		round,
		maxRounds: state.maxRounds,
		sync: "conflict",
		message: "",
	}).length;
	if (note + (input.message ?? "").trim().length > PEER_MESSAGE_MAX)
		throw new Error(
			`A sidekick round's message takes at most ${PEER_MESSAGE_MAX - note} characters; shorten it or point to a file in your checkout (it is synced to the sidekick).`,
		);
	const workspace = await context.workspace();
	const sync = await deps.syncSidekick({
		machines: context.machines,
		leadVm: workspace.vm,
		forkVm: WorkspaceId(fork.vmId),
		label: target.label,
		round,
		base: fork.base,
		parentHead: fork.parentHead,
	});
	await deps.mergeFork(target.id, {
		base: sync.base,
		parentHead: sync.parentHead,
	});
	const next = beginSidekickRound(state, {
		now: new Date(deps.now()).toISOString(),
		steps: target.steps,
		tokens: target.subtree.budgetTokens,
		sync: sync.status,
	});
	await deps.saveSidekick(target.id, next, { clearStop: true });
	await deps.message(
		context.parent,
		target.id,
		sidekickRoundMessage({
			round,
			maxRounds: state.maxRounds,
			sync: sync.status,
			message: input.message ?? "",
		}),
		randomUUID(),
	);
	return {
		id: target.label,
		status: `${sidekickRoundLabel(next)} started`,
		checkout: {
			unchanged: "its fork now matches your checkout",
			clean:
				"its fork now matches your checkout (all its earlier work was in it)",
			carried:
				"its fork now matches your checkout plus its earlier work you have not applied",
			conflict:
				"its fork now matches your checkout; its unapplied earlier work conflicted and was set aside",
		}[sync.status],
		delivery: "now",
	};
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
		/** Lead mode fusion: a writer that persists across rounds. */
		readonly sidekick?: boolean;
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
	if (input.sidekick)
		budget = {
			...budget,
			sidekick: newSidekickState(budget, new Date(deps.now()).toISOString()),
		};
	const brief = await input.brief(tree);
	const placement = subagentPlacement(role);
	const child = await deps.openTask({
		userId: parent.userId,
		projectId: parent.projectId,
		parentSessionId: parent.id,
		title: input.title,
		harness: model.harness,
		modelId: model.listedModelId,
		prompt: brief,
		placement: placement === "fork" ? "fresh" : "shared",
		access: placement === "fork" ? "read_write" : "read_only",
		execution: "parallel",
		dependsOnSessionId: null,
	});
	const childId = child.id;
	try {
		await deps.saveSpec(parent.userId, childId, { role, budget });
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
	});
	if (resolved.kind === "inherit") return { model: inherited };
	if (resolved.kind === "fallback")
		return { model: inherited, notice: resolved.notice };
	return { model: resolved.model, notice: resolved.notice };
}

/**
 * Starts a read-only child with a brief the runtime wrote (the builder never
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
