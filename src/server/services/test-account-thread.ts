import { randomUUID } from "node:crypto";
import { noteSessionsChanged } from "../adapters/list-change-notes";
import type { TestAccountDb } from "./test-account";

const SEEDED_THREAD_TITLE = "Seeded thread (live-update check)";

/**
 * Mimics what Y² does with start_thread, without a model turn: a root thread
 * row appears already running, then settles. Only the test user's own
 * project, and `reset` removes it with the project's data. Each change tells
 * the user's hub the way the real paths do.
 */
export async function seedTestThread(
	db: TestAccountDb,
	userId: string,
	step: "start" | "settle",
): Promise<{ threadId: string; status: "running" | "completed" }> {
	if (step === "start") {
		const target = (
			await db.query<{ project_id: string; workspace_id: string }>(
				`select p.id as project_id, w.id as workspace_id from project p
				 join workspace w on w.project_id=p.id and w.user_id=p.user_id
				 where p.user_id=$1 and p.archived_at is null order by p.created_at limit 1`,
				[userId],
			)
		).rows[0];
		if (!target)
			throw new Error("The test account has no project: run seed first.");
		const threadId = randomUUID();
		await db.query(
			`insert into agent_session(id,user_id,project_id,workspace_id,harness,title,status,turn_status)
			 values($1,$2,$3,$4,'api',$5,'ready','running') returning id`,
			[
				threadId,
				userId,
				target.project_id,
				target.workspace_id,
				SEEDED_THREAD_TITLE,
			],
		);
		noteSessionsChanged(userId, target.project_id);
		return { threadId, status: "running" };
	}
	const row = (
		await db.query<{ id: string; project_id: string }>(
			`update agent_session set turn_status='completed',updated_at=now()
			 where user_id=$1 and title=$2 and parent_session_id is null returning id,project_id`,
			[userId, SEEDED_THREAD_TITLE],
		)
	).rows[0];
	if (!row)
		throw new Error("There is no seeded thread to settle: start one first.");
	noteSessionsChanged(userId, row.project_id);
	return { threadId: row.id, status: "completed" };
}
