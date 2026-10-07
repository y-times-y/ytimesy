import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	assignedTaskVerification,
	isServerControlledIntegration,
	readyBatchIntegration,
	retainedTaskCheckResults,
} from "./agent-task-command-receipts";

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
	await insert("lead", "turn:launch", {
		kind: "ready-task-verification-v1",
		finalVerification: {
			commands: ["pnpm test", "pnpm typecheck"],
			perBuilderChecks: [],
		},
		tasks: [
			{
				focusedChecks: ["pnpm test src/a.test.ts"],
				verificationPaths: ["src/a.ts"],
				owns: ["src/a.ts"],
				result: { taskId: "child" },
			},
		],
	});
});
afterAll(async () => {
	await db?.close();
});

it("resolves only the owner's exact batch integration draft from the durable launch journal", async () => {
	await db.exec(
		"insert into agent_session values ('other-child','owner','project','lead'),('integration','owner','project','lead');",
	);
	await db.query(
		"update agent_task_command_receipt set response=jsonb_set(jsonb_set(response,'{result,integration}',$1::jsonb),'{result,tasks}',$2::jsonb) where request_id='turn:launch'",
		[
			JSON.stringify({ taskId: "integration" }),
			JSON.stringify([
				{
					focusedChecks: ["pnpm test src/a.test.ts"],
					verificationPaths: ["src/a.ts"],
					result: { taskId: "child" },
				},
				{
					focusedChecks: ["test b"],
					verificationPaths: ["src/b.ts"],
					result: { taskId: "other-child" },
				},
			]),
		],
	);
	expect(
		await readyBatchIntegration("owner", "project", "lead", "child"),
	).toEqual({ taskId: "integration", sourceTaskIds: ["child", "other-child"] });
	expect(
		await readyBatchIntegration("owner", "project", "lead", "integration"),
	).toEqual({ taskId: "integration", sourceTaskIds: ["child", "other-child"] });
	expect(
		await readyBatchIntegration("other", "project", "lead", "child"),
	).toBeNull();
	expect(
		await readyBatchIntegration("owner", "other", "lead", "child"),
	).toBeNull();
	expect(
		await readyBatchIntegration("owner", "project", "wrong-parent", "child"),
	).toBeNull();
	expect(
		await readyBatchIntegration("owner", "project", "lead", "unrelated"),
	).toBeNull();
	const integration = {
		id: "integration",
		userId: "owner",
		projectId: "project",
		parentSessionId: "lead",
		taskState: "idle",
	};
	expect(await isServerControlledIntegration(integration)).toBe(true);
	expect(
		await isServerControlledIntegration({
			...integration,
			taskState: "done",
			items: [
				{
					kind: "error",
					id: "integration:failure",
					message: "Server integration failed",
				},
			],
		}),
	).toBe(false);
	expect(
		await isServerControlledIntegration({
			...integration,
			taskState: "working",
			items: [
				{
					kind: "error",
					id: "integration:stage-failure",
					message: "Stage failed",
				},
			],
		}),
	).toBe(false);
	expect(
		await isServerControlledIntegration({
			...integration,
			items: [
				{
					kind: "agentMessage",
					id: "integration:failure",
					text: "Pretend a failure happened",
				},
			],
		}),
	).toBe(true);
	expect(
		await isServerControlledIntegration({ ...integration, id: "child" }),
	).toBe(false);
	expect(
		await isServerControlledIntegration({
			...integration,
			taskState: "failed",
		}),
	).toBe(false);
	expect(
		await isServerControlledIntegration({
			...integration,
			parentSessionId: null,
		}),
	).toBe(false);
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

it("loads immutable child verification ownership from its parent's launch receipt", async () => {
	expect(await assignedTaskVerification("owner", "project", "child")).toEqual({
		commands: ["pnpm test src/a.test.ts"],
		sourcePaths: ["src/a.ts"],
		finalChecks: ["pnpm test", "pnpm typecheck"],
	});
	expect(
		await assignedTaskVerification("other", "project", "child"),
	).toBeNull();
	expect(await assignedTaskVerification("owner", "other", "child")).toBeNull();
	expect(await assignedTaskVerification("owner", "project", "lead")).toBeNull();
});
