import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	evaluationProtocolSchema,
	pairedEvaluationSchedule,
} from "../src/domain/harness-evaluation";
import { subscriptionTurnRevision } from "../src/domain/subscription-turn";
import { inheritedSubscriptionSettings } from "../src/server/adapters/api-turns";
import {
	evaluationRunForTask,
	recordEvaluationUsage,
	reserveEvaluationRequest,
} from "../src/server/adapters/harness-evaluation";

let db: PGlite;
const query = async (sql: string, params: unknown[] = []) => {
	const result = await db.query(sql, params);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));
const root = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const turn = "33333333-3333-4333-8333-333333333333";
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table public.auth_user(id text primary key);
	 create table agent_session(id uuid primary key,user_id text,parent_session_id uuid);
	 create table api_turn(id uuid primary key,session_id uuid,user_id text,model_id text,connection_id uuid,connection_revision text,created_at timestamptz default now());
	 ${await readFile("supabase/migrations/20261003010000_harness_evaluation_limits.sql", "utf8")}`);
});
beforeEach(async () => {
	await db.exec(`truncate public.auth_user,agent_session,api_turn,harness_evaluation_run,harness_evaluation_usage cascade;
	insert into public.auth_user values('alice');
	insert into agent_session values('${root}','alice',null),('${child}','alice','${root}');
	insert into api_turn(id) values('${turn}');
	insert into harness_evaluation_run(user_id,root_session_id,model_id,connection_revision,deadline,max_requests,max_tokens)
	values('alice','${root}','model','subscription',now()+interval '1 minute',2,1000);`);
});
afterAll(async () => {
	await db.close();
});

it("inherits the nearest same-model subscription selection without crossing owners or API billing", async () => {
	await query(
		"update api_turn set session_id=$1,user_id='alice',model_id='model',connection_revision=$2 where id=$3",
		[root, subscriptionTurnRevision("medium", false), turn],
	);
	expect(await inheritedSubscriptionSettings("alice", child, "model")).toEqual({
		reasoning: "medium",
		fast: false,
	});
	expect(await inheritedSubscriptionSettings("bob", child, "model")).toBeNull();
	expect(
		await inheritedSubscriptionSettings("alice", child, "other"),
	).toBeNull();
	await query(
		"insert into api_turn(id,session_id,user_id,model_id,connection_revision) values($1,$2,'alice','model',$3)",
		[
			"44444444-4444-4444-8444-444444444444",
			child,
			subscriptionTurnRevision("high", true),
		],
	);
	expect(await inheritedSubscriptionSettings("alice", child, "model")).toEqual({
		reasoning: "high",
		fast: true,
	});
});

it("shares atomic admission across leaders, descendants and retries", async () => {
	const lead = await evaluationRunForTask("alice", root);
	const builder = await evaluationRunForTask("alice", child);
	expect(builder?.id).toBe(lead?.id);
	if (!lead || !builder) throw new Error("Fixture run missing");
	await reserveEvaluationRequest(lead, "model", "subscription");
	await reserveEvaluationRequest(builder, "model", "subscription");
	await expect(
		reserveEvaluationRequest(builder, "model", "subscription"),
	).rejects.toThrow("limit reached");
	expect(await evaluationRunForTask("bob", child)).toBeNull();
});

it("rejects model/billing changes and expired runs before sending", async () => {
	const run = await evaluationRunForTask("alice", child);
	if (!run) throw new Error("Fixture run missing");
	await expect(
		reserveEvaluationRequest(run, "other", "subscription"),
	).rejects.toThrow("changed");
	await expect(reserveEvaluationRequest(run, "model", "api")).rejects.toThrow(
		"changed",
	);
	await query(
		"update harness_evaluation_run set deadline=now()-interval '1 second'",
	);
	await expect(
		reserveEvaluationRequest(run, "model", "subscription"),
	).rejects.toThrow("limit reached");
});

it("counts cumulative usage once and fails closed on unknown telemetry", async () => {
	const run = await evaluationRunForTask("alice", child);
	if (!run) throw new Error("Fixture run missing");
	const usage = {
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: null,
		cacheWriteTokens: null,
		uncachedInputTokens: null,
	};
	await recordEvaluationUsage(run, turn, usage);
	await recordEvaluationUsage(run, turn, usage);
	await recordEvaluationUsage(run, turn, { ...usage, inputTokens: 200 });
	expect(
		Number(
			(
				(await query("select observed_tokens from harness_evaluation_run"))
					.rows[0] as { observed_tokens: number }
			).observed_tokens,
		),
	).toBe(220);
	await expect(
		recordEvaluationUsage(run, turn, { ...usage, inputTokens: null }),
	).rejects.toThrow("unknown");
	await expect(
		reserveEvaluationRequest(run, "model", "subscription"),
	).rejects.toThrow("limit reached");
});

const protocol = {
	version: 1,
	phase: "development",
	baseline: "a".repeat(40),
	modelId: "model",
	reasoning: "medium",
	seed: 1,
	repetitions: 2,
	graderImage: `node@sha256:${"a".repeat(64)}`,
	limits: { durationSeconds: 60, modelRequests: 4, tokens: 10000 },
	tasks: [
		{
			id: "task",
			benchmark: "development",
			datasetRevision: "b".repeat(40),
			projectId: root,
			repository: "owner/repo",
			branch: "main",
			commit: "c".repeat(40),
			prompt: "Fix parser",
			allowedPaths: ["src/parser.ts"],
			verifier: {
				command: ["/protected/verifier", "node"],
				sha256: "d".repeat(64),
			},
		},
	],
};
it("pins inputs, rejects traversal/duplicates, and counterbalances paired runs", () => {
	const parsed = evaluationProtocolSchema.parse(protocol);
	expect(pairedEvaluationSchedule(parsed).map((row) => row.arms[0])).toEqual([
		"native-codex",
		"ytimesy",
	]);
	expect(() =>
		evaluationProtocolSchema.parse({
			...protocol,
			tasks: [...protocol.tasks, ...protocol.tasks],
		}),
	).toThrow("unique");
	expect(() =>
		evaluationProtocolSchema.parse({
			...protocol,
			tasks: [{ ...protocol.tasks[0], allowedPaths: ["../secret"] }],
		}),
	).toThrow("traversal");
});
