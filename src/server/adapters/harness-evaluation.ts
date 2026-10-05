import type { ApiTokenUsage } from "#/domain/api-token-usage";
import { database } from "./database";

export type EvaluationRun = {
	id: string;
	user_id: string;
	root_session_id: string;
	model_id: string;
	connection_revision: string;
	deadline: Date;
	max_requests: number;
	max_tokens: number;
	requests: number;
	observed_tokens: number;
	state: "active" | "stopped" | "completed";
};

/** All descendants, retries and internal wakeups share their root's durable guard. */
export async function evaluationRunForTask(userId: string, sessionId: string) {
	const result = await database().query<EvaluationRun>(
		`with recursive ancestors as (
		 select id,parent_session_id,0 as depth from agent_session where id=$1 and user_id=$2
		 union all select p.id,p.parent_session_id,a.depth+1 from agent_session p
		 join ancestors a on p.id=a.parent_session_id where p.user_id=$2 and a.depth<4
		) select e.* from harness_evaluation_run e join ancestors a on e.root_session_id=a.id where e.user_id=$2`,
		[sessionId, userId],
	);
	return result.rows[0] ?? null;
}

export async function reserveEvaluationRequest(
	run: EvaluationRun,
	modelId: string,
	revision: string,
) {
	if (modelId !== run.model_id || revision !== run.connection_revision)
		throw new Error(
			"Evaluation model, reasoning or billing source changed. No request was sent.",
		);
	const result = await database().query(
		`update harness_evaluation_run set requests=requests+1
		 where id=$1 and user_id=$2 and state='active' and deadline>clock_timestamp()
		 and requests<max_requests and observed_tokens<max_tokens returning id`,
		[run.id, run.user_id],
	);
	if (!result.rowCount)
		throw new Error(
			"Evaluation request, token or time limit reached. No request was sent.",
		);
}

/** Cumulative per-turn checkpoints are idempotent; unknown provider usage stops further requests. */
export async function recordEvaluationUsage(
	run: EvaluationRun,
	turnId: string,
	usage: ApiTokenUsage,
) {
	if (usage.inputTokens === null || usage.outputTokens === null) {
		await database().query(
			"update harness_evaluation_run set state='stopped' where id=$1 and user_id=$2",
			[run.id, run.user_id],
		);
		throw new Error(
			"Evaluation provider usage is unknown; further requests stopped.",
		);
	}
	const total = usage.inputTokens + usage.outputTokens;
	const client = await database().connect();
	try {
		await client.query("begin");
		await client.query(
			"select id from harness_evaluation_run where id=$1 and user_id=$2 for update",
			[run.id, run.user_id],
		);
		const previous = await client.query<{ observed_tokens: string | number }>(
			"select observed_tokens from harness_evaluation_usage where run_id=$1 and turn_id=$2",
			[run.id, turnId],
		);
		const old = Number(previous.rows[0]?.observed_tokens ?? 0);
		if (total < old)
			throw new Error("Evaluation usage decreased unexpectedly.");
		await client.query(
			`insert into harness_evaluation_usage(run_id,turn_id,observed_tokens) values($1,$2,$3)
		 on conflict(run_id,turn_id) do update set observed_tokens=excluded.observed_tokens`,
			[run.id, turnId, total],
		);
		await client.query(
			"update harness_evaluation_run set observed_tokens=observed_tokens+$3 where id=$1 and user_id=$2",
			[run.id, run.user_id, total - old],
		);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

export async function assertEvaluationActive(run: EvaluationRun) {
	const result = await database().query(
		"select 1 from harness_evaluation_run where id=$1 and user_id=$2 and state='active' and deadline>clock_timestamp()",
		[run.id, run.user_id],
	);
	if (!result.rowCount) throw new Error("Evaluation stopped or expired.");
}
