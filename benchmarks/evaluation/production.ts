import { Effect } from "effect";
import type {
	EvaluationProtocol,
	EvaluationTask,
} from "#/domain/harness-evaluation";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import {
	agentSessionForOwner,
	descendantAgentSessions,
} from "#/server/adapters/agent-sessions";
import { database } from "#/server/adapters/database";
import { projectForOwner } from "#/server/adapters/projects";
import {
	bindAgentSessionMachine,
	deleteAgentSessionMachine,
	openAgentSession,
} from "#/server/services/agent-session-machine";
import { cancelServerTurn } from "#/server/services/cancel-server-turn";
import { sendHarnessWorkspaceTask } from "#/server/services/harness-workspace-session";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

export const evaluationPatchScript = (commit: string) => `set -eu
cd "$(cat /tmp/ytimesy-project-cwd)"
git cat-file -e ${quote(`${commit}^{commit}`)}
evaluation_index=$(mktemp /tmp/ytimesy-evaluation-index.XXXXXX)
trap 'rm -f "$evaluation_index"' EXIT
GIT_INDEX_FILE="$evaluation_index" git read-tree HEAD
GIT_INDEX_FILE="$evaluation_index" git add -A -- .
GIT_INDEX_FILE="$evaluation_index" git diff --cached --binary ${quote(commit)} -- .`;

/** Operator capability, not a public route. No alternate prompt, tool loop or queue consumer. */
export async function openProductionEvaluation(
	machines: WorkspaceMachines,
	userId: string,
	task: EvaluationTask,
	protocol: EvaluationProtocol,
) {
	if (process.env.YTIMESY_HARNESS_EVALUATION_ENABLED !== "1")
		throw new Error("Deploy the evaluation guard before live evaluation.");
	const project = await projectForOwner(userId, task.projectId);
	if (!project || project.fullName !== task.repository)
		throw new Error("Evaluation repository is not owned by this operator.");
	const root = await openAgentSession({
		userId,
		projectId: project.id,
		harness: "codex",
		title: `Evaluation ${task.id}`,
	});
	try {
		// Pin this new chat only. Never switch the user's project or other chats.
		await database().query(
			"update agent_session set selected_branch=$3,working_branch=$3,base_branch=$3 where id=$1 and user_id=$2",
			[root.id, userId, task.branch],
		);
		await bindAgentSessionMachine(machines, {
			userId,
			projectId: project.id,
			sessionId: root.id,
			harness: "codex",
		});
		const bound = await agentSessionForOwner(userId, root.id);
		if (!bound?.providerRef)
			throw new Error("Evaluation checkout was not bound.");
		const head = await machines.exec(
			WorkspaceId(bound.providerRef),
			'cd "$(cat /tmp/ytimesy-project-cwd)" && git rev-parse HEAD && git status --porcelain',
			15000,
		);
		if (head.exitCode !== 0 || head.stdout.trim() !== task.commit)
			throw new Error(
				`Evaluation checkout is dirty or differs from the pinned commit: ${head.stdout.trim()}`,
			);
		const revision = subscriptionTurnRevision(protocol.reasoning, false);
		const registered = await database().query<{ id: string }>(
			`insert into harness_evaluation_run(user_id,root_session_id,model_id,connection_revision,deadline,max_requests,max_tokens)
			 values($1,$2,$3,$4,now()+$5*interval '1 second',$6,$7) returning id`,
			[
				userId,
				root.id,
				protocol.modelId,
				revision,
				protocol.limits.durationSeconds,
				protocol.limits.modelRequests,
				protocol.limits.tokens,
			],
		);
		return {
			rootId: root.id,
			runId: registered.rows[0].id,
			vmId: bound.providerRef,
			projectId: project.id,
		};
	} catch (error) {
		await deleteAgentSessionMachine(machines, {
			userId,
			projectId: project.id,
			sessionId: root.id,
		});
		throw error;
	}
}

export async function submitProductionEvaluation(
	machines: WorkspaceMachines,
	userId: string,
	attempt: Awaited<ReturnType<typeof openProductionEvaluation>>,
	task: EvaluationTask,
	protocol: EvaluationProtocol,
) {
	const view = await Effect.runPromise(
		sendHarnessWorkspaceTask(
			machines,
			{
				userId,
				projectId: attempt.projectId,
				sessionId: attempt.rootId,
				harnessId: "codex",
			},
			{
				text: task.prompt,
				modelId: protocol.modelId,
				variant: protocol.reasoning,
				fast: false,
			},
		),
	);
	if (view.connection.status === "failed")
		throw new Error("Production submission failed.");
}

/** Settled means the complete tree and notification outbox, not just the leader's first final message. */
export async function productionEvaluationSnapshot(
	userId: string,
	rootId: string,
) {
	const root = await agentSessionForOwner(userId, rootId);
	if (!root) throw new Error("Evaluation root disappeared.");
	const children = await descendantAgentSessions(userId, rootId);
	const ids = [rootId, ...children.map((child) => child.id)];
	const pending = await database().query<{ count: string }>(
		`select count(*) from api_turn where user_id=$1 and session_id=any($2::uuid[]) and state in ('queued','running')`,
		[userId, ids],
	);
	const notifications = await database().query<{ count: string }>(
		`select count(*) from agent_task_event where child_session_id=any($1::uuid[]) and status in ('pending','delivering')`,
		[ids],
	);
	return {
		root,
		children,
		settled:
			root.turnStatus !== "running" &&
			!Number(pending.rows[0].count) &&
			!Number(notifications.rows[0].count) &&
			children.every(
				(child) =>
					child.turnStatus !== "running" && child.taskState !== "working",
			),
	};
}

export async function exportReviewedEvaluationPatches(
	machines: WorkspaceMachines,
	userId: string,
	rootId: string,
	commit: string,
) {
	const snapshot = await productionEvaluationSnapshot(userId, rootId);
	if (!snapshot.settled || snapshot.root.turnStatus !== "completed")
		throw new Error("Production tree has not completed successfully.");
	const writers = snapshot.children.filter(
		(child) => child.taskAccess === "read_write",
	);
	if (!writers.length)
		throw new Error("Coding evaluation completed without a writable builder.");
	if (
		writers.some(
			(writer) =>
				writer.taskState !== "done" ||
				writer.taskReviewState !== "reviewed" ||
				!writer.providerRef,
		)
	)
		throw new Error(
			"Every builder must finish and be reviewed before grading.",
		);
	const vms = writers.map((writer) => writer.providerRef);
	if (
		new Set(vms).size !== vms.length ||
		vms.includes(snapshot.root.providerRef)
	)
		throw new Error(
			"Writable builders did not have distinct isolated execution machines.",
		);
	return Promise.all(
		writers.map(async (writer) => {
			const output = await machines.exec(
				WorkspaceId(writer.providerRef as string),
				evaluationPatchScript(commit),
				30000,
			);
			if (output.exitCode) throw new Error("Builder patch export failed.");
			return { taskId: writer.id, patch: output.stdout };
		}),
	);
}

/** Capture durable traces and guard counters before disposable-session deletion cascades them away. */
export async function productionEvaluationEvidence(
	userId: string,
	rootId: string,
) {
	const snapshot = await productionEvaluationSnapshot(userId, rootId);
	const ids = [rootId, ...snapshot.children.map((child) => child.id)];
	const turns = await database().query(
		"select id,session_id,model_id,connection_revision,state,items,created_at,updated_at from api_turn where user_id=$1 and session_id=any($2::uuid[]) order by created_at,id",
		[userId, ids],
	);
	const limits = await database().query(
		"select model_id,connection_revision,max_requests,max_tokens,requests,observed_tokens,deadline,state from harness_evaluation_run where user_id=$1 and root_session_id=$2",
		[userId, rootId],
	);
	return { ...snapshot, turns: turns.rows, limits: limits.rows[0] };
}

/** Stop the guard first so child completion cannot launch an unbounded follow-up during cleanup. */
export async function closeProductionEvaluation(
	machines: WorkspaceMachines,
	userId: string,
	attempt: Awaited<ReturnType<typeof openProductionEvaluation>>,
) {
	await database().query(
		"update harness_evaluation_run set state='stopped' where id=$1 and user_id=$2",
		[attempt.runId, userId],
	);
	const children = await descendantAgentSessions(userId, attempt.rootId);
	for (const session of [attempt.rootId, ...children.map((child) => child.id)])
		await cancelServerTurn(userId, session);
	// Deletion destroys only the disposable tree; the project template and other chats remain.
	await deleteAgentSessionMachine(machines, {
		userId,
		projectId: attempt.projectId,
		sessionId: attempt.rootId,
	});
}
