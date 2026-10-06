import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DurableWorkPlan } from "#/domain/durable-work-plan";
import {
	claimWorkPlan,
	insertWorkPlan,
	notifyBlockedWorkPlan,
	readWorkPlan,
	renewWorkPlanClaim,
	saveClaimedWorkPlan,
	setWorkPlanStatus,
} from "./work-plans";

const holder = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
let db: PGlite;
const parent = randomUUID();
function plan(id = "a".repeat(64)): DurableWorkPlan {
	return {
		type: "work-plan",
		id,
		status: "active",
		lease: null,
		nodes: [
			{
				id: "first",
				taskId: randomUUID(),
				kind: "task",
				objective: "Implement first",
				estimatedSeconds: 10,
				owns: ["src/first.ts"],
				dependsOn: [],
				contract: "b".repeat(64),
				priority: 10,
				state: "pending",
				message: null,
			},
		],
	};
}
beforeEach(async () => {
	db = new PGlite();
	await db.exec(
		"create table agent_session(id uuid primary key,user_id text,parent_session_id uuid); create table agent_task_command_receipt(parent_session_id uuid references agent_session(id) on delete cascade,request_id text,status text,response jsonb,completed_at timestamptz,updated_at timestamptz default now(),primary key(parent_session_id,request_id));",
	);
	await db.query("insert into agent_session values($1,'alice',null)", [parent]);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
	holder.connect.mockResolvedValue({ query: holder.query, release() {} });
});
afterEach(() => db.close());

it("persists owner-scoped plans idempotently and refuses concurrent plans", async () => {
	const initial = plan();
	await expect(insertWorkPlan("bob", parent, initial)).rejects.toThrow("lead");
	await insertWorkPlan("alice", parent, initial);
	expect(await insertWorkPlan("alice", parent, initial)).toEqual(initial);
	await expect(
		insertWorkPlan("alice", parent, plan("c".repeat(64))),
	).rejects.toThrow("existing plan");
	await expect(readWorkPlan("bob", parent, initial.id)).rejects.toThrow(
		"not available",
	);
	expect(await readWorkPlan("alice", parent, initial.id)).toEqual(initial);
});

it("claims exclusively, retains interrupted dispatch, and rejects stale worker writes", async () => {
	await insertWorkPlan("alice", parent, plan());
	const attempts = await Promise.all([claimWorkPlan(), claimWorkPlan()]);
	expect(attempts.filter(Boolean)).toHaveLength(1);
	const first = attempts.find(Boolean);
	if (!first) throw new Error("Missing claim");
	first.plan.nodes[0].state = "dispatching";
	await saveClaimedWorkPlan(parent, first.token, first.plan);
	await renewWorkPlanClaim(parent, first.plan.id, first.token);
	await db.query(
		"update agent_task_command_receipt set response=jsonb_set(response,'{result,lease,until}','0'::jsonb)",
	);
	const recovered = await claimWorkPlan();
	expect(recovered?.plan.nodes[0].state).toBe("dispatching");
	if (!recovered) throw new Error("Missing recovery");
	await expect(
		saveClaimedWorkPlan(parent, first.token, first.plan),
	).rejects.toThrow("claim was lost");
	recovered.plan.nodes[0].state = "uncertain";
	recovered.plan.status = "blocked";
	await saveClaimedWorkPlan(parent, recovered.token, recovered.plan, true);
	expect(await claimWorkPlan()).toBeNull();
	await expect(
		setWorkPlanStatus("alice", parent, recovered.plan.id, "resume"),
	).rejects.toThrow("cannot");
	await expect(
		setWorkPlanStatus("alice", parent, recovered.plan.id, "pause"),
	).rejects.toThrow("cannot");
});

it("pause/cancel fences future writes without deleting children or replaying dispatches", async () => {
	const initial = plan();
	await insertWorkPlan("alice", parent, initial);
	const claim = await claimWorkPlan();
	if (!claim) throw new Error("Missing claim");
	claim.plan.nodes[0].state = "dispatching";
	await saveClaimedWorkPlan(parent, claim.token, claim.plan);
	await setWorkPlanStatus("alice", parent, initial.id, "pause");
	await expect(
		renewWorkPlanClaim(parent, initial.id, claim.token),
	).rejects.toThrow();
	expect(await claimWorkPlan()).toBeNull();
	await setWorkPlanStatus("alice", parent, initial.id, "resume");
	expect((await claimWorkPlan())?.plan.nodes[0].state).toBe("dispatching");
	await setWorkPlanStatus("alice", parent, initial.id, "cancel");
	expect(await claimWorkPlan()).toBeNull();
	await insertWorkPlan("alice", parent, plan("c".repeat(64)));
	await db.query("delete from agent_session where id=$1", [parent]);
	expect(
		(await db.query("select * from agent_task_command_receipt")).rows,
	).toHaveLength(0);
});

it("deduplicates owner-scoped blocked notifications without changing child runtime state", async () => {
	const initial = plan();
	await db.exec(
		"alter table agent_session add column task_state text; create table agent_task_event(id uuid,user_id text,parent_session_id uuid,child_session_id uuid,event_type text,dedupe_key text unique,payload jsonb)",
	);
	await db.query(
		"insert into agent_session(id,user_id,parent_session_id,task_state) values($1,'alice',$2,'working')",
		[initial.nodes[0].taskId, parent],
	);
	initial.status = "blocked";
	initial.nodes[0].state = "uncertain";
	expect(await notifyBlockedWorkPlan("bob", parent, initial)).toBeUndefined();
	expect(await notifyBlockedWorkPlan("alice", parent, initial)).toEqual(
		expect.any(String),
	);
	expect(await notifyBlockedWorkPlan("alice", parent, initial)).toBeUndefined();
	expect((await db.query("select * from agent_task_event")).rows).toHaveLength(
		1,
	);
	expect(
		(
			await db.query("select task_state from agent_session where id=$1", [
				initial.nodes[0].taskId,
			])
		).rows,
	).toEqual([{ task_state: "working" }]);
});
