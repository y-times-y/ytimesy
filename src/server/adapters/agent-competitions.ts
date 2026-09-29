import {
	type AgentCompetition,
	competitionCandidatePublicItems,
} from "#/domain/agent-competition";
import type { SessionItem } from "#/domain/session-item";
import { database } from "./database";

type CompetitionRow = {
	id: string;
	root_session_id: string;
	user_message_id: string;
	prompt: string;
	leader_count: number;
	attempt_model_ids: string[] | null;
	status: AgentCompetition["status"];
	winner_session_id: string | null;
	error_message: string | null;
};

function toCompetition(row: CompetitionRow): AgentCompetition {
	return {
		id: row.id,
		rootSessionId: row.root_session_id,
		userMessageId: row.user_message_id,
		prompt: row.prompt,
		leaderCount: row.leader_count,
		attemptModelIds: row.attempt_model_ids ?? undefined,
		status: row.status,
		winnerSessionId: row.winner_session_id,
		errorMessage: row.error_message,
		candidates: [],
	};
}

type CandidateRow = {
	id: string;
	competition_id: string;
	candidate_index: number;
	task_state: AgentCompetition["candidates"][number]["status"];
	task_summary: string | null;
	items: SessionItem[];
};

const competitionColumns =
	"id,root_session_id,user_message_id,prompt,leader_count,attempt_model_ids,status,winner_session_id,error_message";

export async function competitionsForOwner(
	userId: string,
	rootSessionId: string,
) {
	const result = await database().query<CompetitionRow>(
		`select ${competitionColumns} from agent_competition where user_id=$1 and root_session_id=$2 order by created_at,id`,
		[userId, rootSessionId],
	);
	if (result.rows.length === 0) return [];
	const candidates = await database().query<CandidateRow>(
		`select s.id,s.competition_id,s.candidate_index,s.task_state,s.task_summary,s.items
		 from agent_session s join agent_competition c on c.id=s.competition_id
		 where c.user_id=$1 and c.root_session_id=$2 and s.user_id=$1
		 order by s.candidate_index`,
		[userId, rootSessionId],
	);
	return result.rows.map((row) => ({
		...toCompetition(row),
		candidates: candidates.rows
			.filter((candidate) => candidate.competition_id === row.id)
			.map((candidate) => ({
				id: candidate.id,
				index: candidate.candidate_index,
				status: candidate.task_state,
				summary: candidate.task_summary,
				items: competitionCandidatePublicItems(candidate.items, row.prompt),
			})),
	}));
}

export async function competitionForOwner(
	userId: string,
	rootSessionId: string,
) {
	const result = await database().query<CompetitionRow>(
		`select ${competitionColumns} from agent_competition where user_id=$1 and root_session_id=$2 order by created_at desc,id desc limit 1`,
		[userId, rootSessionId],
	);
	return result.rows[0] ? toCompetition(result.rows[0]) : null;
}

export async function competitionForCandidate(
	userId: string,
	candidateId: string,
) {
	const result = await database().query<CompetitionRow>(
		`select c.id,c.root_session_id,c.user_message_id,c.prompt,c.leader_count,c.attempt_model_ids,c.status,c.winner_session_id,c.error_message from agent_competition c
		 join agent_session s on s.competition_id=c.id
		 where c.user_id=$1 and s.user_id=$1 and s.id=$2`,
		[userId, candidateId],
	);
	return result.rows[0] ? toCompetition(result.rows[0]) : null;
}

export async function createAgentCompetition(input: {
	userId: string;
	projectId: string;
	rootSessionId: string;
	prompt: string;
	harness: "codex" | "claude" | "api";
	modelId: string;
	leaderCount: number;
	attemptModelIds: readonly string[];
	userMessageId?: string;
}) {
	const client = await database().connect();
	try {
		await client.query("begin");
		const userMessageId = input.userMessageId ?? crypto.randomUUID();
		const result = await client.query<CompetitionRow>(
			`insert into agent_competition(root_session_id,user_id,project_id,user_message_id,prompt,harness,model_id,leader_count,attempt_model_ids)
			 select $3,$1,$2,$8,$4,$5,$6,$7,$9::text[] from agent_session
			 where id=$3 and user_id=$1 and project_id=$2 and parent_session_id is null
			   and turn_status<>'running'
			 on conflict do nothing
			 returning ${competitionColumns}`,
			[
				input.userId,
				input.projectId,
				input.rootSessionId,
				input.prompt,
				input.harness,
				input.modelId,
				input.leaderCount,
				userMessageId,
				input.attemptModelIds,
			],
		);
		if (!result.rows[0])
			throw new Error(
				"Wait for the current turn to finish before starting agents.",
			);
		await client.query(
			"update agent_session set listed_model_id=$3,items=items || $4::jsonb,turn_status='running',task_access='read_only',harness=$5,updated_at=now() where id=$1 and user_id=$2",
			[
				input.rootSessionId,
				input.userId,
				input.modelId,
				JSON.stringify([
					{
						kind: "userMessage",
						id: userMessageId,
						text: input.prompt,
					},
				]),
				input.harness,
			],
		);
		await client.query("commit");
		return toCompetition(result.rows[0]);
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

export async function competitionRuntime(rootSessionId: string) {
	const result = await database().query<{
		id: string;
		root_session_id: string;
		user_id: string;
		project_id: string;
		prompt: string;
		harness: "codex" | "claude" | "api";
		model_id: string;
		leader_count: number;
		attempt_model_ids: string[] | null;
		status: AgentCompetition["status"];
	}>(
		"select id,root_session_id,user_id,project_id,prompt,harness,model_id,leader_count,attempt_model_ids,status from agent_competition where root_session_id=$1 and status in ('queued','working','judging') order by created_at desc limit 1",
		[rootSessionId],
	);
	return result.rows[0] ?? null;
}

export async function competitionCandidate(
	userId: string,
	competitionId: string,
	position: number,
) {
	const result = await database().query<{ id: string; task_state: string }>(
		"select id,task_state from agent_session where user_id=$1 and competition_id=$2 and candidate_index=$3",
		[userId, competitionId, position],
	);
	return result.rows[0]
		? { id: result.rows[0].id, taskState: result.rows[0].task_state }
		: null;
}

export async function markCompetitionStatus(
	rootSessionId: string,
	status: AgentCompetition["status"],
	errorMessage?: string,
) {
	await database().query(
		"update agent_competition set status=$2,error_message=$3,updated_at=now() where root_session_id=$1 and status in ('queued','working','judging')",
		[rootSessionId, status, errorMessage?.slice(0, 500) ?? null],
	);
	if (status === "failed" || status === "complete")
		await database().query(
			"update agent_session set turn_status=$2,updated_at=now() where id=$1",
			[rootSessionId, status === "complete" ? "completed" : "failed"],
		);
}

export async function resetCompetitionJudge(rootSessionId: string) {
	await database().query(
		"update agent_competition set status='working',updated_at=now() where root_session_id=$1 and status='judging' and winner_session_id is null",
		[rootSessionId],
	);
	await database().query(
		"update agent_session set turn_status='running',updated_at=now() where id=$1",
		[rootSessionId],
	);
}

/** A worker can die after claiming the comparison but before submitting its turn. */
export async function recoverInterruptedCompetitionJudge(
	userId: string,
	rootSessionId: string,
) {
	await database().query(
		`update agent_competition c set status='working',updated_at=now()
		 from agent_session s where c.root_session_id=s.id
		 and c.user_id=$1 and c.root_session_id=$2 and c.status='judging'
		 and c.winner_session_id is null and s.turn_status='idle'
		 and c.updated_at < now() - interval '4 minutes'`,
		[userId, rootSessionId],
	);
}

export async function claimCompetitionJudge(
	userId: string,
	rootSessionId: string,
) {
	const client = await database().connect();
	try {
		await client.query("begin");
		const result = await client.query<{
			id: string;
			prompt: string;
			leader_count: number;
		}>(
			`update agent_competition c set status='judging',updated_at=now()
			 where c.user_id=$1 and c.root_session_id=$2 and c.status='working'
			 and (select count(*) from agent_session s where s.competition_id=c.id)=c.leader_count
			 and not exists (select 1 from agent_session s where s.competition_id=c.id and coalesce(s.task_state,'draft') not in ('done','failed'))
			 returning c.id,c.prompt,c.leader_count`,
			[userId, rootSessionId],
		);
		if (result.rows[0])
			await client.query(
				"update agent_session set turn_status='idle',updated_at=now() where id=$1 and user_id=$2 and turn_status='running'",
				[rootSessionId, userId],
			);
		await client.query("commit");
		return result.rows[0] ?? null;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

export async function selectCompetitionWinner(
	userId: string,
	rootSessionId: string,
	candidateId: string,
) {
	const result = await database().query(
		`update agent_competition c set winner_session_id=$3,status='complete',updated_at=now()
		 where c.user_id=$1 and c.root_session_id=$2 and c.status='judging'
		 and exists (select 1 from agent_session s where s.id=$3 and s.competition_id=c.id and s.parent_session_id=$2 and s.user_id=$1 and s.candidate_index is not null and s.task_state='done' and s.task_review_state='reviewed')
		 and not exists (
		  select 1 from agent_session candidate
		  where candidate.competition_id=c.id and candidate.candidate_index is not null
		    and candidate.task_state='done'
		    and not exists (
		      select 1 from agent_task_command_receipt receipt
		      where receipt.parent_session_id=$2 and receipt.created_at >= c.updated_at
		        and receipt.status='done' and receipt.response->>'ok'='true'
		        and receipt.response->'result'->>'taskId'=candidate.id::text
		        and jsonb_typeof(receipt.response->'result'->'diff')='string'
		        and receipt.response->'result'->>'truncated'='false'
		    )
		 )
		 returning c.root_session_id`,
		[userId, rootSessionId, candidateId],
	);
	if (!result.rows[0])
		throw new Error(
			"Inspect every completed candidate's full diff in this comparison turn, then review the chosen candidate before selecting a winner.",
		);
}

export async function reconcileFinishedCompetitionJudges() {
	await database().query(
		`update agent_competition c set status=case when s.turn_status='failed' then 'failed' else 'complete' end,
		 error_message=case when s.turn_status='failed' then 'Comparison failed; review the agent results.' else null end,
		 updated_at=now()
		 from agent_session s where c.root_session_id=s.id and c.status='judging'
		 and s.turn_status in ('completed','failed')`,
	);
}

export async function competitionCandidateIds(competitionId: string) {
	const result = await database().query<{ id: string }>(
		"select id from agent_session where competition_id=$1 order by candidate_index",
		[competitionId],
	);
	return new Set(result.rows.map((row) => row.id));
}
