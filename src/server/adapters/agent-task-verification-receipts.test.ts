import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { retainedTaskCheckResults } from "./agent-task-command-receipts";

const state = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => ({ query: state.query }) }));
let db: PGlite;
const reference = "00000000-0000-4000-8000-000000000001";
beforeAll(async () => {
	db = new PGlite();
	state.query.mockImplementation((sql, parameters) =>
		db.query(sql, parameters),
	);
	await db.exec(
		"create table agent_session(id text primary key,user_id text,project_id text,parent_session_id text); create table agent_task_command_receipt(parent_session_id text,request_id text,status text,response jsonb);",
	);
	await db.exec(
		"insert into agent_session values ('lead','owner','project',null),('child','owner','project','lead');",
	);
	const insert = (session: string, id: string, result: unknown) =>
		db.query(
			"insert into agent_task_command_receipt values ($1,$2,'done',$3)",
			[session, id, JSON.stringify({ ok: true, result })],
		);
	await insert("child", "turn:check", [
		{
			command: "pnpm test src/a.test.ts",
			reference,
			exitCode: 0,
			stopped: null,
			stdout: "should-not-return",
			verification: { privateSourceBody: "should-not-return" },
		},
	]);
});
afterAll(async () => {
	await db?.close();
});

it("retrieves only check identities from the exact owner/project journal call", async () => {
	const input = {
		userId: "owner",
		projectId: "project",
		sessionId: "child",
		requestIds: ["turn:check"],
	};
	const results = await retainedTaskCheckResults(input);
	expect(results.get("turn:check")).toEqual([
		{
			command: "pnpm test src/a.test.ts",
			reference,
			exitCode: 0,
			stopped: null,
		},
	]);
	expect(await retainedTaskCheckResults({ ...input, userId: "other" })).toEqual(
		new Map(),
	);
	expect(
		await retainedTaskCheckResults({ ...input, projectId: "other" }),
	).toEqual(new Map());
	await expect(
		retainedTaskCheckResults({
			...input,
			requestIds: Array(65).fill("turn:check"),
		}),
	).rejects.toThrow("bounded");
});
