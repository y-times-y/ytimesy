import {
	MODEL_WORKFLOW_DEADLINE_MS,
	type WorkflowStep,
	type WorkflowStepOutcome,
} from "#/domain/model-workflow";
import type { ApiTurn } from "./api-turns";
import { database } from "./database";

/** Claim before any inference or tool side effect. Unknown outcomes never authorize replay. */
export async function claimModelWorkflowStep(
	request: WorkflowStep,
): Promise<
	| { kind: "claimed"; turn: ApiTurn; remainingMs: number }
	| { kind: "done"; outcome: WorkflowStepOutcome }
	| { kind: "cancelled"; turn: ApiTurn }
	| { kind: "unavailable" }
> {
	const client = await database().connect();
	let committed = false;
	try {
		await client.query("begin");
		const turn = (
			await client.query<
				ApiTurn & { alive: boolean; fresh: boolean; cancel_requested: boolean }
			>(
				`select *,heartbeat_at>=now()-interval '45 seconds' as fresh,
				 state='running' and not cancel_requested and heartbeat_at>=now()-interval '45 seconds' as alive
			 from api_turn where id=$1 and lease_id=$2 and executor='node' for update`,
				[request.turnId, request.leaseId],
			)
		).rows[0];
		if (!turn) return { kind: "unavailable" };
		if (
			turn.state === "completed" ||
			turn.state === "failed" ||
			turn.state === "cancelled"
		)
			return { kind: "done", outcome: turn.state };
		const existing = (
			await client.query<{ state: string; outcome: WorkflowStepOutcome }>(
				"select state,outcome from model_workflow_step where turn_id=$1 and lease_id=$2 and step_index=$3",
				[request.turnId, request.leaseId, request.index],
			)
		).rows[0];
		if (existing?.state === "done")
			return { kind: "done", outcome: existing.outcome };
		if (existing) return { kind: "unavailable" };
		if (turn.state === "running" && turn.cancel_requested && turn.fresh)
			return { kind: "cancelled", turn };
		if (!turn.alive) return { kind: "unavailable" };
		if (request.index > 1) {
			const predecessor = await client.query(
				`select 1 from model_workflow_step where turn_id=$1 and lease_id=$2 and step_index=$3
				 and state='done' and outcome='continue'`,
				[request.turnId, request.leaseId, request.index - 1],
			);
			if (!predecessor.rows.length) return { kind: "unavailable" };
		}
		const inserted = await client.query<{ remaining_ms: number }>(
			`insert into model_workflow_step(turn_id,lease_id,step_index,state) values($1,$2,$3,'processing')
			 returning $4::bigint - extract(epoch from (now()-coalesce(
			 (select min(started_at) from model_workflow_step where turn_id=$1 and lease_id=$2),now())))*1000 as remaining_ms`,
			[
				request.turnId,
				request.leaseId,
				request.index,
				MODEL_WORKFLOW_DEADLINE_MS,
			],
		);
		await client.query("commit");
		committed = true;
		return {
			kind: "claimed",
			turn,
			remainingMs: Math.max(
				0,
				Math.floor(Number(inserted.rows[0].remaining_ms)),
			),
		};
	} finally {
		// Early returns must release the row lock, not leave an idle transaction in the pool.
		try {
			if (!committed) await client.query("rollback");
		} finally {
			client.release();
		}
	}
}

export async function completeModelWorkflowStep(
	request: WorkflowStep,
	outcome: WorkflowStepOutcome,
) {
	const saved = await database().query(
		`update model_workflow_step set state='done',outcome=$4,completed_at=now()
		 where turn_id=$1 and lease_id=$2 and step_index=$3 and state='processing' returning turn_id`,
		[request.turnId, request.leaseId, request.index, outcome],
	);
	if (!saved.rowCount) throw new Error("Durable step receipt was not saved.");
}
