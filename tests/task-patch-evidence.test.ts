import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	acceptTaskPatch,
	recordTaskImport,
	taskPatchEvidence,
} from "../src/server/adapters/task-patch-evidence";
import { recordCompletedVerification } from "../src/server/adapters/turn-verification";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, args: unknown[]) => {
			const result = await db.query(sql, args);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));
const parent = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
const destination = "33333333-3333-4333-8333-333333333333";
const patch = { taskId: source, sha256: "a".repeat(64), base: "b".repeat(40) };
beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create role anon; create role authenticated; create table agent_session(id uuid primary key,user_id text,parent_session_id uuid,task_state text,task_review_state text,updated_at timestamptz default now());",
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20260923010000_agent_task_command_receipts.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20260923013000_agent_task_command_heartbeat.sql",
			"utf8",
		),
	);
	await db.query(
		"insert into agent_session(id,user_id,parent_session_id,task_state,task_review_state) values ($1,'owner',null,'done','pending'),($2,'owner',$1,'done','pending'),($3,'owner',$1,'working','pending')",
		[parent, source, destination],
	);
});
afterAll(() => db.close());
it("atomically accepts the exact hash using the existing command journal", async () => {
	await expect(acceptTaskPatch("owner", parent, patch)).rejects.toThrow(
		"lacks authoritative",
	);
	await recordCompletedVerification("owner", source, {
		type: "completion-verification",
		directory: "/repo",
		turn: "c".repeat(64),
		base: patch.base,
		tree: "d".repeat(40),
		patchSha256: patch.sha256,
		checks: [
			{
				command: "npm test",
				reference: crypto.randomUUID(),
				exitCode: 0,
				stopped: null,
			},
		],
	});
	await acceptTaskPatch("owner", parent, patch);
	expect(
		(
			await db.query<{ task_review_state: string }>(
				"select task_review_state from agent_session where id=$1",
				[source],
			)
		).rows[0].task_review_state,
	).toBe("reviewed");
	await recordTaskImport("owner", destination, patch);
	await recordTaskImport("owner", destination, patch);
	const evidence = await taskPatchEvidence("owner", [parent, destination]);
	expect(evidence.reviews.get(source)).toMatchObject(patch);
	expect(evidence.imports).toHaveLength(1);
	expect(await taskPatchEvidence("other-owner", [parent, destination])).toEqual(
		{ reviews: new Map(), imports: [] },
	);
});
it("rejects cross-owner acceptance and changed task state", async () => {
	await expect(acceptTaskPatch("other-owner", parent, patch)).rejects.toThrow(
		"changed",
	);
	await db.query(
		"update agent_session set task_state='working',task_review_state='pending' where id=$1",
		[source],
	);
	await expect(acceptTaskPatch("owner", parent, patch)).rejects.toThrow(
		"changed",
	);
	expect(
		(
			await db.query<{ task_review_state: string }>(
				"select task_review_state from agent_session where id=$1",
				[source],
			)
		).rows[0].task_review_state,
	).toBe("pending");
});

it("rolls back review state if its durable receipt cannot be saved", async () => {
	await db.query(
		"update agent_session set task_state='done',task_review_state='pending' where id=$1",
		[source],
	);
	await db.exec(
		"alter table agent_task_command_receipt add constraint refuse_review check (request_id not like 'patch-review:%') not valid",
	);
	try {
		await expect(acceptTaskPatch("owner", parent, patch)).rejects.toThrow();
		expect(
			(
				await db.query<{ task_review_state: string }>(
					"select task_review_state from agent_session where id=$1",
					[source],
				)
			).rows[0].task_review_state,
		).toBe("pending");
		await expect(
			recordTaskImport("other-owner", destination, patch),
		).rejects.toThrow("no longer available");
	} finally {
		await db.exec(
			"alter table agent_task_command_receipt drop constraint refuse_review",
		);
	}
});
