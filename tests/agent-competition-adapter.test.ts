import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	claimCompetitionJudge,
	competitionForCandidate,
	competitionForOwner,
	competitionsForOwner,
	createAgentCompetition,
	selectCompetitionWinner,
} from "../src/server/adapters/agent-competitions";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params?: unknown[]) => db.query(sql, params),
		connect: async () => ({
			query: (sql: string, params?: unknown[]) => db.query(sql, params),
			release: () => {},
		}),
	}),
}));

const projectId = "00000000-0000-4000-8000-000000000001";
const rootId = "00000000-0000-4000-8000-000000000002";
const firstId = "00000000-0000-4000-8000-000000000003";
const secondId = "00000000-0000-4000-8000-000000000004";

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated");
	await db.exec(
		"create table auth_user(id text primary key); create table project(id uuid primary key)",
	);
	await db.exec(`create table agent_session(id uuid primary key,user_id text,project_id uuid,parent_session_id uuid,harness text,
	 items jsonb not null default '[]',listed_model_id text,turn_status text not null default 'idle',task_state text,
	 task_review_state text,task_summary text,task_access text,updated_at timestamptz not null default now())`);
	await db.exec(`create table agent_task_command_receipt(
	 parent_session_id uuid, status text, response jsonb, created_at timestamptz not null default now())`);
	await db.exec(
		await readFile(
			"supabase/migrations/20260927220000_agent_competitions.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20260927233000_agent_competitions_per_turn.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20260928160000_competition_attempt_models.sql",
			"utf8",
		),
	);
	await db.exec(`insert into auth_user values('alice'),('bob'); insert into project values('${projectId}');
	 insert into agent_session(id,user_id,project_id) values('${rootId}','alice','${projectId}')`);
});
afterAll(() => db.close());

it("waits for every candidate of this message before judging", async () => {
	await expect(
		createAgentCompetition({
			userId: "bob",
			projectId,
			rootSessionId: rootId,
			prompt: "Task",
			harness: "api",
			modelId: "test",
			leaderCount: 2,
		}),
	).rejects.toThrow();
	const group = await createAgentCompetition({
		userId: "alice",
		projectId,
		rootSessionId: rootId,
		prompt: "Task",
		harness: "api",
		modelId: "test",
		leaderCount: 2,
	});
	expect(group.status).toBe("queued");
	expect(
		(await db.query("select harness from agent_session where id=$1", [rootId]))
			.rows[0],
	).toEqual({ harness: "api" });
	expect(await competitionForOwner("bob", rootId)).toBeNull();
	await expect(
		createAgentCompetition({
			userId: "alice",
			projectId,
			rootSessionId: rootId,
			prompt: "Again",
			harness: "api",
			modelId: "test",
			leaderCount: 2,
		}),
	).rejects.toThrow();
	await db.exec(`update agent_competition set status='working' where id='${group.id}';
	 insert into agent_session(id,user_id,project_id,parent_session_id,competition_id,candidate_index,task_state,task_review_state) values
	 ('${firstId}','alice','${projectId}','${rootId}','${group.id}',1,'done','pending'),
	 ('${secondId}','alice','${projectId}','${rootId}','${group.id}',2,'working','pending')`);
	expect(await claimCompetitionJudge("alice", rootId)).toBeNull();
	await db.query("update agent_session set task_state='failed' where id=$1", [
		secondId,
	]);
	expect(
		(
			await db.query("select turn_status from agent_session where id=$1", [
				rootId,
			])
		).rows[0],
	).toEqual({ turn_status: "running" });
	expect(await claimCompetitionJudge("alice", rootId)).toMatchObject({
		leader_count: 2,
	});
	await db.query("update agent_session set task_state='done' where id=$1", [
		secondId,
	]);
	await expect(
		selectCompetitionWinner("alice", rootId, firstId),
	).rejects.toThrow();
	await db.query(
		"update agent_session set task_review_state='reviewed' where id=$1",
		[firstId],
	);
	await expect(
		selectCompetitionWinner("alice", rootId, firstId),
	).rejects.toThrow("Inspect every completed candidate");
	await db.query(
		`insert into agent_task_command_receipt(parent_session_id,status,response,created_at)
		 values($1,'done',$2::jsonb,now()+interval '1 second')`,
		[
			rootId,
			JSON.stringify({
				ok: true,
				result: {
					taskId: firstId,
					diff: "diff --git a/a b/a",
					truncated: false,
				},
			}),
		],
	);
	await expect(
		selectCompetitionWinner("alice", rootId, firstId),
	).rejects.toThrow("Inspect every completed candidate");
	await db.query(
		`insert into agent_task_command_receipt(parent_session_id,status,response,created_at)
		 values($1,'done',$2::jsonb,now()+interval '1 second')`,
		[
			rootId,
			JSON.stringify({
				ok: true,
				result: { taskId: secondId, diff: "", truncated: false },
			}),
		],
	);
	await selectCompetitionWinner("alice", rootId, firstId);
	expect(await competitionForOwner("alice", rootId)).toMatchObject({
		status: "complete",
		winnerSessionId: firstId,
	});
	await db.query(
		"update agent_session set turn_status='completed' where id=$1",
		[rootId],
	);
	const followUp = await createAgentCompetition({
		userId: "alice",
		projectId,
		rootSessionId: rootId,
		prompt: "Next task",
		harness: "api",
		modelId: "test",
		leaderCount: 3,
	});
	expect(followUp.attemptModelIds).toEqual(["test", "test", "test"]);
	expect(followUp.id).not.toBe(group.id);
	await db.query("update agent_competition set status='complete' where id=$1", [
		followUp.id,
	]);
	await db.query(
		"update agent_session set turn_status='completed' where id=$1",
		[rootId],
	);
	const mixed = await createAgentCompetition({
		userId: "alice",
		projectId,
		rootSessionId: rootId,
		prompt: "Mixed models",
		harness: "api",
		modelId: "alpha",
		modelIds: ["alpha", "alpha", "beta"],
		leaderCount: 3,
		userMessageId: "00000000-0000-4000-8000-000000000099",
	});
	expect(mixed.attemptModelIds).toEqual(["alpha", "alpha", "beta"]);
	expect(await competitionsForOwner("bob", rootId)).toEqual([]);
	expect(
		(await competitionsForOwner("alice", rootId)).map((item) => item.id),
	).toEqual([group.id, followUp.id, mixed.id]);
	expect(await competitionForCandidate("alice", firstId)).toMatchObject({
		id: group.id,
	});
	expect(
		(await db.query("select items from agent_session where id=$1", [rootId]))
			.rows[0],
	).toMatchObject({
		items: [{ text: "Task" }, { text: "Next task" }, { text: "Mixed models" }],
	});
}, 15_000);
