import { Effect } from "effect";
import { childTaskEventQueueText } from "#/domain/child-task-activity";
import { prRepairPrompt, prRepairSignal } from "#/domain/pr-repair-signal";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { database } from "../adapters/database";
import { currentPrRepairEvidence } from "../adapters/github/pr-repair-evidence";
import { sendHarnessWorkspaceTask } from "./harness-workspace-session";
import { deliverPullRequestWakes } from "./pull-request-wake";
import type { WorkspaceMachines } from "./workspace-machines";

type RepairEvent = {
	delivery_id: string;
	session_id: string;
	head_sha: string;
	signal: unknown;
	counted: boolean;
	failures: number;
	user_id: string;
	installation_id: string;
};

async function claimRepairEvent(): Promise<RepairEvent | null> {
	const result = await database().query<RepairEvent>(`with next as (
		select e.delivery_id,e.session_id from agent_pr_repair_event e where e.status in ('pending','dispatching') and e.available_at<=now()
		order by e.created_at for update skip locked limit 1
	) update agent_pr_repair_event e set status='dispatching',available_at=now()+interval '90 seconds'
	from next,agent_session s,project p,project_repository r where e.delivery_id=next.delivery_id and e.session_id=next.session_id and s.id=e.session_id and p.id=s.project_id and p.user_id=s.user_id
	and r.project_id=p.id and r.repository_id::text=e.signal->>'repositoryId'
	returning e.*,s.user_id,r.installation_id`);
	return result.rows[0] ?? null;
}

async function recordRepairState(
	event: RepairEvent,
	state: "pending" | "delivered" | "ignored" | "blocked",
	error: string | null = null,
) {
	await database().query(
		"update agent_pr_repair_event set status=$3,last_error=$4,available_at=now()+interval '15 seconds' where delivery_id=$1 and session_id=$2",
		[event.delivery_id, event.session_id, state, error],
	);
}

async function reserveRepairAttempt(
	event: RepairEvent,
): Promise<number | null> {
	const client = await database().connect();
	try {
		await client.query("begin");
		await client.query(
			"insert into agent_pr_repair_control(session_id) values($1) on conflict do nothing",
			[event.session_id],
		);
		const control = await client.query<{ attempts: number; paused: boolean }>(
			"select attempts,paused from agent_pr_repair_control where session_id=$1 for update",
			[event.session_id],
		);
		const current = control.rows[0];
		const receipt = await client.query<{ counted: boolean }>(
			"select counted from agent_pr_repair_event where delivery_id=$1 and session_id=$2 for update",
			[event.delivery_id, event.session_id],
		);
		const counted = receipt.rows[0]?.counted;
		if (
			!current ||
			counted === undefined ||
			current.paused ||
			(!counted && current.attempts >= 3)
		) {
			await client.query(
				"update agent_pr_repair_control set paused=true,updated_at=now() where session_id=$1",
				[event.session_id],
			);
			await client.query("commit");
			return null;
		}
		const attempt = current.attempts + (counted ? 0 : 1);
		if (!counted) {
			await client.query(
				"update agent_pr_repair_control set attempts=$2,updated_at=now() where session_id=$1",
				[event.session_id, attempt],
			);
			await client.query(
				"update agent_pr_repair_event set counted=true where delivery_id=$1 and session_id=$2",
				[event.delivery_id, event.session_id],
			);
		}
		await client.query("commit");
		return attempt;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

/**
 * Task PR repair, then chat wake-ups for pull requests ytimesy opened
 * (src/server/services/pull-request-wake.ts); both run from the pr-repair job.
 */
export async function deliverPrRepairEvents(machines: WorkspaceMachines) {
	if (process.env.YTIMESY_PR_REPAIR_ENABLED !== "1") return;
	await deliverTaskRepairEvents(machines);
	await deliverPullRequestWakes(machines);
}

/** Queued turns have unique repair IDs, so a lost delivery acknowledgement cannot dispatch twice. */
async function deliverTaskRepairEvents(machines: WorkspaceMachines) {
	for (let index = 0; index < 10; index++) {
		const event = await claimRepairEvent();
		if (!event) return;
		try {
			const session = await agentSessionForOwner(
				event.user_id,
				event.session_id,
			);
			if (
				!session?.taskPullRequestUrl ||
				!session.parentSessionId ||
				session.taskAccess !== "read_write" ||
				!["api", "codex"].includes(session.harness)
			) {
				await recordRepairState(event, "ignored");
				continue;
			}
			const idempotencyKey = `pr-repair:${event.delivery_id}:${event.session_id}`;
			const existing = await database().query(
				"select id from api_turn where session_id=$1 and user_id=$2 and idempotency_key=$3",
				[session.id, session.userId, idempotencyKey],
			);
			if (existing.rows.length) {
				await recordRepairState(event, "delivered");
				continue;
			}
			if (session.turnStatus === "running") {
				await recordRepairState(event, "pending");
				continue;
			}
			const signal = prRepairSignal.parse(event.signal);
			const evidence = await currentPrRepairEvidence(
				signal,
				session.taskPullRequestUrl,
				event.installation_id,
			);
			if (evidence === null) {
				await recordRepairState(event, "ignored");
				continue;
			}
			if (!session.listedModelId) {
				await recordRepairState(
					event,
					"blocked",
					"The task needs a selected model. No fallback was used.",
				);
				continue;
			}
			const attempt = await reserveRepairAttempt(event);
			if (attempt === null) {
				await recordRepairState(
					event,
					"blocked",
					"Automatic PR repair is paused after at most three attempts; manual review is needed.",
				);
				continue;
			}
			const view = await Effect.runPromise(
				sendHarnessWorkspaceTask(
					machines,
					{
						userId: session.userId,
						projectId: session.projectId,
						sessionId: session.id,
						harnessId: session.harness,
						createNew: false,
					},
					{
						modelId: session.listedModelId,
						text: childTaskEventQueueText(event.delivery_id),
						runtimeText: prRepairPrompt(signal, evidence, attempt),
						idempotencyKey,
					},
				),
			);
			if (view.connection.status === "failed" || view.turnStatus === "failed")
				throw new Error(
					"Repair wakeup was not accepted. Check the task connection and model access.",
				);
			await recordRepairState(event, "delivered");
		} catch {
			await database().query(
				"update agent_pr_repair_event set failures=least(failures+1,5),status=case when failures>=4 then 'blocked' else 'pending' end,last_error='Repair delivery failed; inspect connection, GitHub permissions and task availability. No fallback was used.',available_at=now()+interval '30 seconds' where delivery_id=$1 and session_id=$2",
				[event.delivery_id, event.session_id],
			);
		}
	}
}
