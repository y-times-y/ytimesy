import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	adoptChatPublicationBranch,
	insertAgentSession,
	projectBranchHeldByOtherSession,
	saveSessionBranchSelection,
	saveSessionWorkingBranch,
	selectAgentSessionHarness,
} from "../src/server/adapters/agent-sessions";
import { saveProject } from "../src/server/adapters/projects";
import {
	bindAgentSessionMachine,
	deleteAgentSessionMachine,
	openAgentSession,
	openAgentTask,
	prepareAgentTaskStart,
} from "../src/server/services/agent-session-machine";

let db: PGlite;
const query = async (sql: string, params?: unknown[]) => {
	const result = await db.query(sql, params);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query,
		connect: async () => ({ query, release() {} }),
	}),
}));
const storage = vi.hoisted(() => ({
	configured: false,
	removed: [] as string[],
}));
vi.mock(
	"../src/server/adapters/checkpoints/storage",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../src/server/adapters/checkpoints/storage")
		>()),
		checkpointStorageConfigured: () => storage.configured,
		removeChatObjects: async (_userId: string, sessionId: string) => {
			storage.removed.push(sessionId);
		},
	}),
);
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({
		APP_URL: "[REDACTED]",
		BETTER_AUTH_SECRET: "test-only-secret-longer-than-thirty-two-characters",
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	await db.exec("create table api_turn(session_id uuid,state text)");
	for (const file of [
		"20260913010000_enable_automatic_rls.sql",
		"20260913193000_identity_and_projects.sql",
		"20260913221500_workspaces_jobs_agent_accounts.sql",
		"20260913234500_auth_email_outbox.sql",
		"20260914010000_auth_email_reset_password.sql",
		"20260915053000_agent_sessions_and_snapshots.sql",
		"20260915060000_agent_session_parent.sql",
		"20260915083000_product_setting.sql",
		"20260915103000_agent_session_listed_model.sql",
		"20260915110000_agent_session_turn_status.sql",
		"20260921230000_agent_task_lifecycle.sql",
		"20260921231000_agent_task_events.sql",
		"20260923010000_agent_task_command_receipts.sql",
		"20260923013000_agent_task_command_heartbeat.sql",
		"20260919161500_workspace_snapshot_source.sql",
		"20260927210000_project_environments.sql",
		"20260927220000_agent_competitions.sql",
		"20260930220000_chat_branches.sql",
		"20261018010000_builder_subagents.sql",
		"20261003022000_workspace_retention.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	// The harness constraint from 20260927203000_api_turns (this schema builds api_turn itself).
	await db.exec(
		"alter table agent_session drop constraint agent_session_harness_check; alter table agent_session add constraint agent_session_harness_check check (harness in ('codex','claude','opencode','api'))",
	);
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

it("persists branch drafts independently across chats and protects ownership", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const a = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
	});
	const b = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
	});
	await db.query(
		"insert into agent_task_command_receipt(parent_session_id,request_id,status) values($1,'verification-baseline:/repo','processing'),($1,'completion-verification:turn:/repo','processing'),($1,'other-operation','processing'),($2,'verification-baseline:/repo','processing')",
		[a.id, b.id],
	);
	await saveSessionBranchSelection("alice", a.id, "feature");
	expect(
		(
			await db.query(
				"select request_id from agent_task_command_receipt where parent_session_id=$1",
				[a.id],
			)
		).rows,
	).toEqual([{ request_id: "other-operation" }]);
	expect(
		(
			await db.query(
				"select request_id from agent_task_command_receipt where parent_session_id=$1",
				[b.id],
			)
		).rows,
	).toHaveLength(1);
	const rows = await db.query<{
		id: string;
		selected_branch: string | null;
		working_branch: string | null;
	}>(
		"select id,selected_branch,working_branch from agent_session where id in ($1,$2)",
		[a.id, b.id],
	);
	expect(rows.rows.find((row) => row.id === a.id)?.selected_branch).toBe(
		"feature",
	);
	expect(rows.rows.find((row) => row.id === b.id)?.selected_branch).toBeNull();
	expect(rows.rows.every((row) => row.working_branch === null)).toBe(true);
	expect(
		(
			await db.query<{ branch: string }>(
				"select branch from project where id=$1",
				[project.id],
			)
		).rows[0].branch,
	).toBe("main");
	await expect(
		saveSessionBranchSelection("bob", a.id, "main"),
	).rejects.toThrow();
	await db.query("update agent_session set turn_status='running' where id=$1", [
		a.id,
	]);
	await expect(
		saveSessionWorkingBranch("alice", a.id, "main"),
	).rejects.toThrow();
});

async function readyWorkspace() {
	const project = await saveProject(
		"alice",
		{
			installationId: 1,
			repositoryId: Math.floor(Math.random() * 100000),
			fullName: `test/delete-${Date.now()}`,
			defaultBranch: "main",
		},
		"main",
	);
	const workspaceId = crypto.randomUUID();
	await db.query(
		`insert into workspace(id,user_id,project_id,status,provider_ref,template_snapshot_id)
		 values($1,'alice',$2,'ready','vm-template','snap-1')`,
		[workspaceId, project.id],
	);
	return { project, workspaceId };
}

it("starts a new root chat with no task access: it publishes as a chat", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
	});
	expect(session.taskAccess).toBeNull();
	expect(session.parentSessionId).toBeNull();
});

it("persists the selected runtime before a reused chat starts polling", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-agent",
		listedModelId: "claude-old",
	});
	const bound = await bindAgentSessionMachine(
		{ ensureRunning: async () => {} } as never,
		{
			userId: "alice",
			projectId: project.id,
			sessionId: session.id,
			harness: "codex",
		},
	);
	expect(bound.session.harness).toBe("codex");
	expect(
		(
			await db.query(
				"select harness,listed_model_id from agent_session where id=$1",
				[session.id],
			)
		).rows,
	).toEqual([{ harness: "codex", listed_model_id: null }]);
});

it.each(["codex", "api"] as const)(
	"gives a %s root chat whose VM is gone a fresh copy, never a child",
	async (harness) => {
		const { project, workspaceId } = await readyWorkspace();
		const root = await insertAgentSession({
			userId: "alice",
			projectId: project.id,
			workspaceId,
			harness,
			providerRef: "vm-gone",
		});
		const child = await insertAgentSession({
			userId: "alice",
			projectId: project.id,
			workspaceId,
			harness,
			providerRef: "vm-gone",
			parentSessionId: root.id,
		});
		const machines = {
			ensureRunning: async (id: string) => {
				if (id === "vm-gone") throw new Error("VM not found");
				return id;
			},
			provisionSession: async () => "vm-fresh",
			exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			writeTextFile: async () => {},
		} as never;
		const bound = await bindAgentSessionMachine(machines, {
			userId: "alice",
			projectId: project.id,
			sessionId: root.id,
			harness,
		});
		expect(bound.providerRef).toBe("vm-fresh");
		await expect(
			bindAgentSessionMachine(machines, {
				userId: "alice",
				projectId: project.id,
				sessionId: child.id,
				harness,
			}),
		).rejects.toThrow("VM not found");
	},
);

it("does not switch a running turn or another owner's runtime", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-agent",
	});
	await expect(
		selectAgentSessionHarness("bob", project.id, session.id, "codex"),
	).rejects.toThrow();
	await db.query("update agent_session set turn_status='running' where id=$1", [
		session.id,
	]);
	await expect(
		selectAgentSessionHarness("alice", project.id, session.id, "codex"),
	).rejects.toThrow();
	expect(
		(
			await db.query("select harness from agent_session where id=$1", [
				session.id,
			])
		).rows,
	).toEqual([{ harness: "api" }]);
});

it("destroys agent copies and side-chat copies, never the template VM", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const parent = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-copy-agent",
	});
	await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-copy-side",
		parentSessionId: parent.id,
	});
	const destroyed: string[] = [];
	await deleteAgentSessionMachine(
		{
			destroy: async (workspaceId) => {
				destroyed.push(workspaceId);
			},
			destroySnapshot: async () => {},
		},
		{ userId: "alice", projectId: project.id, sessionId: parent.id },
	);
	expect(destroyed.sort()).toEqual(["vm-copy-agent", "vm-copy-side"]);
	const remaining = await db.query(
		"select id from agent_session where project_id=$1",
		[project.id],
	);
	expect(remaining.rows).toEqual([]);
	const template = await db.query<{ provider_ref: string }>(
		"select provider_ref from workspace where id=$1",
		[workspaceId],
	);
	expect(template.rows[0]?.provider_ref).toBe("vm-template");
});

it("deletes every stored file and the retained snapshots only the deleted chats used", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const parent = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-chat",
	});
	const child = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: null,
		parentSessionId: parent.id,
	});
	const sibling = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-sibling",
	});
	// The child was retained (its VM is gone); its snapshot is the parent's too,
	// and the sibling shares another snapshot that must survive.
	await db.query(
		`insert into workspace_retention(session_id,user_id,vm_id,slug,resources,snapshot_id,phase,expires_at,verified_at) values
		 ($1,'alice','vm-chat','slug-parent','{}','snap-chat','active',null,null),
		 ($2,'alice','vm-child-retained','slug-child','{}','snap-child','retained',now()+interval '90 days',now()),
		 ($3,'alice','vm-sibling','slug-sibling','{}','snap-shared','retained',now()+interval '90 days',now())`,
		[parent.id, child.id, sibling.id],
	);
	await db.query(
		"update workspace_retention set snapshot_id='snap-shared' where session_id=$1",
		[parent.id],
	);
	storage.configured = true;
	storage.removed.length = 0;
	const destroyed: string[] = [];
	const snapshots: string[] = [];
	try {
		await deleteAgentSessionMachine(
			{
				destroy: async (id) => {
					destroyed.push(id);
				},
				destroySnapshot: async (id) => {
					snapshots.push(id);
				},
			},
			{ userId: "alice", projectId: project.id, sessionId: parent.id },
		);
	} finally {
		storage.configured = false;
	}
	expect(storage.removed.sort()).toEqual([parent.id, child.id].sort());
	expect(destroyed.sort()).toEqual(["vm-chat", "vm-child-retained"]);
	expect(snapshots).toEqual(["snap-child"]);
	expect(
		(
			await db.query(
				"select session_id from workspace_retention where session_id in ($1,$2)",
				[parent.id, child.id],
			)
		).rows,
	).toEqual([]);
});

it("drops a leftover template-bound session row without deleting the template VM", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-template",
	});
	const destroyed: string[] = [];
	await deleteAgentSessionMachine(
		{
			destroy: async (workspaceId) => {
				destroyed.push(workspaceId);
			},
			destroySnapshot: async () => {},
		},
		{ userId: "alice", projectId: project.id, sessionId: session.id },
	);
	expect(destroyed).toEqual([]);
	const remaining = await db.query("select id from agent_session where id=$1", [
		session.id,
	]);
	expect(remaining.rows).toEqual([]);
});

it("deletes a shared child session without destroying its parent's machine", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const parent = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-parent",
		listedModelId: "codex/gpt-test",
	});
	const child = await openAgentTask({
		userId: "alice",
		projectId: project.id,
		parentSessionId: parent.id,
		title: "Read-only audit",
		harness: "codex",
		modelId: "codex/gpt-test",
		prompt: "Inspect the current working tree without editing it.",
		placement: "shared",
		access: "read_only",
	});
	await db.query(
		"update agent_session set provider_ref='vm-parent',agent_role='researcher' where id=$1",
		[child.id],
	);
	const destroyed: string[] = [];
	await deleteAgentSessionMachine(
		{
			destroy: async (workspaceId) => {
				destroyed.push(workspaceId);
			},
			destroySnapshot: async () => {},
		},
		{ userId: "alice", projectId: project.id, sessionId: child.id },
	);
	expect(destroyed).toEqual([]);
	expect(
		(await db.query("select id from agent_session where id=$1", [parent.id]))
			.rows,
	).toEqual([{ id: parent.id }]);
});

it("never destroys a parent VM its reader shares, deleting the reader alone or a legacy role-less shared child", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const parent = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-shared-parent",
		listedModelId: "codex/gpt-test",
	});
	const reader = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-shared-parent",
		parentSessionId: parent.id,
		task: { prompt: "Read", placement: "shared", access: "read_only" },
	});
	const legacy = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-shared-parent",
		parentSessionId: parent.id,
		task: { prompt: "Old child", placement: "shared", access: "read_only" },
	});
	await db.query(
		"update agent_session set agent_role='researcher' where id=$1",
		[reader.id],
	);
	const destroyed: string[] = [];
	const machines = {
		destroy: async (vm: string) => {
			destroyed.push(vm);
		},
		destroySnapshot: async () => {},
	};
	for (const child of [reader, legacy])
		await deleteAgentSessionMachine(machines, {
			userId: "alice",
			projectId: project.id,
			sessionId: child.id,
		});
	expect(destroyed).toEqual([]);
	// Deleting the chat itself destroys its VM exactly once.
	const another = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-shared-parent",
		parentSessionId: parent.id,
		task: { prompt: "Read", placement: "shared", access: "read_only" },
	});
	await db.query("update agent_session set agent_role='reviewer' where id=$1", [
		another.id,
	]);
	await deleteAgentSessionMachine(machines, {
		userId: "alice",
		projectId: project.id,
		sessionId: parent.id,
	});
	expect(destroyed).toEqual(["vm-shared-parent"]);
});

it("does not let another user delete a session", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-agent",
	});
	await expect(
		deleteAgentSessionMachine(
			{
				destroy: async () => {
					throw new Error("destroy must not run");
				},
				destroySnapshot: async () => {
					throw new Error("destroySnapshot must not run");
				},
			},
			{ userId: "bob", projectId: project.id, sessionId: session.id },
		),
	).rejects.toThrow("Agent session is not available.");
	const remaining = await db.query("select id from agent_session where id=$1", [
		session.id,
	]);
	expect(remaining.rows).toEqual([{ id: session.id }]);
});

it("stores the listed model last submitted on an agent session", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const session = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-agent",
		listedModelId: "opencode/big-pickle",
	});
	expect(session.listedModelId).toBe("opencode/big-pickle");
	const stored = await db.query<{ listed_model_id: string | null }>(
		"select listed_model_id from agent_session where id=$1",
		[session.id],
	);
	expect(stored.rows[0]?.listed_model_id).toBe("opencode/big-pickle");
});

it("opens a new chat without copying a VM and inherits the last listed model", async () => {
	const { project, workspaceId } = await readyWorkspace();
	await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
		providerRef: "vm-sibling",
		listedModelId: "opencode/big-pickle",
	});
	const opened = await openAgentSession({
		userId: "alice",
		projectId: project.id,
		harness: "api",
	});
	expect(opened.providerRef).toBeNull();
	expect(opened.title).toBe("New session");
	expect(opened.listedModelId).toBe("opencode/big-pickle");
	expect(opened.turnStatus).toBe("idle");
	const stored = await db.query<{
		provider_ref: string | null;
		listed_model_id: string | null;
	}>("select provider_ref, listed_model_id from agent_session where id=$1", [
		opened.id,
	]);
	expect(stored.rows[0]?.provider_ref).toBeNull();
	expect(stored.rows[0]?.listed_model_id).toBe("opencode/big-pickle");
});

it("stores a subagent draft without compute and starts it once", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const root = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		listedModelId: "codex/gpt-test",
	});
	const draft = await openAgentTask({
		userId: "alice",
		projectId: project.id,
		parentSessionId: root.id,
		title: "Schema",
		harness: "codex",
		modelId: "codex/gpt-test",
		prompt: "Implement and verify the schema.",
		placement: "fresh",
		access: "read_write",
	});
	expect(draft.taskState).toBe("draft");
	expect(draft.providerRef).toBeNull();
	const started = await prepareAgentTaskStart({
		userId: "alice",
		projectId: project.id,
		taskSessionId: draft.id,
	});
	expect(started.task.taskState).toBe("working");
	await expect(
		prepareAgentTaskStart({
			userId: "alice",
			projectId: project.id,
			taskSessionId: draft.id,
		}),
	).rejects.toThrow("new or idle");
});

it("gives a branchless root chat its publication branch once, during a running turn, and never renames it", async () => {
	const { project, workspaceId } = await readyWorkspace();
	const chat = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
	});
	await db.query("update agent_session set turn_status='running' where id=$1", [
		chat.id,
	]);
	const adopted = await adoptChatPublicationBranch(
		"alice",
		chat.id,
		"ytimesy/fix-parser-0c4a1e",
		"main",
	);
	expect(adopted).toMatchObject({
		workingBranch: "ytimesy/fix-parser-0c4a1e",
		selectedBranch: "ytimesy/fix-parser-0c4a1e",
		baseBranch: "main",
	});
	const again = await adoptChatPublicationBranch(
		"alice",
		chat.id,
		"ytimesy/renamed-0c4a1e",
		"develop",
	);
	expect(again.workingBranch).toBe("ytimesy/fix-parser-0c4a1e");
	expect(again.baseBranch).toBe("main");
	const other = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "api",
	});
	await expect(
		projectBranchHeldByOtherSession(
			"alice",
			project.id,
			other.id,
			"ytimesy/fix-parser-0c4a1e",
		),
	).resolves.toBe(true);
	await expect(
		projectBranchHeldByOtherSession(
			"alice",
			project.id,
			chat.id,
			"ytimesy/fix-parser-0c4a1e",
		),
	).resolves.toBe(false);
});
