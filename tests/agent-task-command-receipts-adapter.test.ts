import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	claimAgentTaskCommand,
	completeAgentTaskCommand,
	renewAgentTaskCommandClaim,
} from "../src/server/adapters/agent-task-command-receipts";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated");
	await db.exec("create table agent_session(id uuid primary key)");
	await db.exec(
		await readFile(
			"supabase/migrations/20260923010000_agent_task_command_receipts.sql",
			"utf8",
		),
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20260923013000_agent_task_command_heartbeat.sql",
			"utf8",
		),
	);
	await db.exec(
		"insert into agent_session(id) values('00000000-0000-4000-8000-000000000001')",
	);
});
afterAll(() => db.close());

const parent = "00000000-0000-4000-8000-000000000001";

it("returns a completed response on repeated observation without rerunning the command", async () => {
	expect(await claimAgentTaskCommand(parent, "call-1")).toEqual({
		kind: "claimed",
	});
	expect(await claimAgentTaskCommand(parent, "call-1")).toEqual({
		kind: "processing",
	});
	await completeAgentTaskCommand(parent, {
		id: "call-1",
		ok: true,
		result: { taskId: "task-1" },
	});
	expect(await claimAgentTaskCommand(parent, "call-1")).toEqual({
		kind: "done",
		response: { id: "call-1", ok: true, result: { taskId: "task-1" } },
	});
});

it("reports an uncertain stale outcome instead of repeating its side effect", async () => {
	expect(await claimAgentTaskCommand(parent, "call-stale")).toEqual({
		kind: "claimed",
	});
	await db.query(
		"update agent_task_command_receipt set updated_at=now()-interval '200 seconds' where parent_session_id=$1 and request_id=$2",
		[parent, "call-stale"],
	);
	const receipt = await claimAgentTaskCommand(parent, "call-stale");
	expect(receipt.kind).toBe("done");
	if (receipt.kind === "done") {
		expect(receipt.response.ok).toBe(false);
		expect(receipt.response.error).toContain("outcome is uncertain");
	}
	await completeAgentTaskCommand(parent, {
		id: "call-stale",
		ok: true,
		result: { taskId: "task-late" },
	});
	expect(await claimAgentTaskCommand(parent, "call-stale")).toEqual({
		kind: "done",
		response: { id: "call-stale", ok: true, result: { taskId: "task-late" } },
	});
});

it("keeps a long-running command leased while its owner is alive", async () => {
	expect(await claimAgentTaskCommand(parent, "call-slow")).toEqual({
		kind: "claimed",
	});
	await db.query(
		"update agent_task_command_receipt set updated_at=now()-interval '200 seconds' where parent_session_id=$1 and request_id=$2",
		[parent, "call-slow"],
	);
	await renewAgentTaskCommandClaim(parent, "call-slow");
	expect(await claimAgentTaskCommand(parent, "call-slow")).toEqual({
		kind: "processing",
	});
});
