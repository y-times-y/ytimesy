import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	readBuilderWorkState,
	saveBuilderWorkState,
} from "./builder-work-state";

const holder = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
let db: PGlite;
const sessionId = randomUUID();
const update = {
	expectedRevision: 0,
	objective: "Fix and verify the parser",
	steps: [{ step: "Inspect parser", status: "in_progress" }],
	evidence: ["command-id: output reference"],
	remaining: ["Run regression"],
};
beforeEach(async () => {
	db = new PGlite();
	await db.exec(
		"create table agent_session(id uuid primary key,user_id text); create table agent_task_command_receipt(parent_session_id uuid references agent_session(id),request_id text,status text,response jsonb,completed_at timestamptz,updated_at timestamptz default now(),primary key(parent_session_id,request_id));",
	);
	await db.query("insert into agent_session values($1,'alice')", [sessionId]);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
	holder.connect.mockResolvedValue({ query: holder.query, release() {} });
});
afterEach(() => db.close());

it("persists across readers, fences stale updates and denies cross-owner access", async () => {
	expect(await readBuilderWorkState("alice", sessionId)).toBeNull();
	await expect(saveBuilderWorkState("bob", sessionId, update)).rejects.toThrow(
		"unavailable",
	);
	const state = await saveBuilderWorkState("alice", sessionId, update);
	expect(state.revision).toBe(1);
	expect(await readBuilderWorkState("alice", sessionId)).toEqual(state);
	expect(await readBuilderWorkState("bob", sessionId)).toBeNull();
	await expect(
		saveBuilderWorkState("alice", sessionId, update),
	).rejects.toThrow("changed");
	expect(
		(
			await saveBuilderWorkState("alice", sessionId, {
				...update,
				expectedRevision: 1,
			})
		).revision,
	).toBe(2);
});
