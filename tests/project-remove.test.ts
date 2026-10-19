import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { insertAgentSession } from "../src/server/adapters/agent-sessions";
import { listProjects, saveProject } from "../src/server/adapters/projects";
import { removeProjectMachine } from "../src/server/services/projects";

let db: PGlite;
const storage = vi.hoisted(() => ({
	configured: vi.fn(() => true),
	removed: [] as string[],
	fail: false,
}));
vi.mock("../src/server/adapters/checkpoints/storage", () => ({
	checkpointStorageConfigured: storage.configured,
	removeChatObjects: async (userId: string, sessionId: string) => {
		if (storage.fail) throw new Error("R2 unavailable");
		storage.removed.push(`${userId}/${sessionId}`);
	},
}));
beforeEach(() => {
	storage.removed.length = 0;
	storage.fail = false;
});
function machines(
	destroy: (id: string) => Promise<void> = async () => {},
	destroySnapshot: (id: string) => Promise<void> = async () => {},
) {
	return { destroy, destroySnapshot } as never;
}
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({
		APP_URL: "[REDACTED]",
		BETTER_AUTH_SECRET: "test-only-secret-longer-than-thirty-two-characters",
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations")).sort())
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

async function readyProject(userId: string, repositoryId: number) {
	const project = await saveProject(
		userId,
		{
			installationId: 1,
			repositoryId,
			fullName: `test/remove-${repositoryId}`,
			defaultBranch: "main",
		},
		"main",
	);
	const workspaceId = crypto.randomUUID();
	await db.query(
		`insert into workspace(id,user_id,project_id,status,provider_ref,template_snapshot_id)
		 values($1,$2,$3,'ready','vm-template','snap-1')`,
		[workspaceId, userId, project.id],
	);
	return { project, workspaceId };
}

it("destroys session and template VMs, then drops the project row", async () => {
	const { project, workspaceId } = await readyProject("alice", 21);
	const parent = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-agent",
	});
	await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-side",
		parentSessionId: parent.id,
	});
	const destroyed: string[] = [];
	await removeProjectMachine(
		machines(async (workspaceId) => {
			destroyed.push(workspaceId);
		}),
		{ userId: "alice", projectId: project.id },
	);
	expect(destroyed.sort()).toEqual(["vm-agent", "vm-side", "vm-template"]);
	expect(await listProjects("alice")).toEqual([]);
	const sessions = await db.query(
		"select id from agent_session where project_id=$1",
		[project.id],
	);
	expect(sessions.rows).toEqual([]);
	const workspace = await db.query("select id from workspace where id=$1", [
		workspaceId,
	]);
	expect(workspace.rows).toEqual([]);
});

it("does not let another user remove a project", async () => {
	const { project } = await readyProject("alice", 22);
	await expect(
		removeProjectMachine(
			machines(async () => {
				throw new Error("destroy must not run");
			}),
			{ userId: "bob", projectId: project.id },
		),
	).rejects.toThrow("Project is not available.");
	expect(await listProjects("alice")).toEqual([
		expect.objectContaining({ id: project.id }),
	]);
});

it("still removes the project when Freestyle destroy fails", async () => {
	const { project } = await readyProject("alice", 23);
	await removeProjectMachine(
		machines(
			async () => {
				throw new Error("LIMIT_EXCEEDED");
			},
			async () => {
				throw new Error("snapshot delete failed");
			},
		),
		{ userId: "alice", projectId: project.id },
	);
	expect(
		(await listProjects("alice")).find((row) => row.id === project.id),
	).toBeUndefined();
});

it("deletes the project's chat files and private snapshots, sparing shared ones", async () => {
	const { project, workspaceId } = await readyProject("alice", 24);
	const chat = await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-chat-24",
	});
	await db.query(
		`insert into environment_build(id,workspace_id,status,input_hash,sources,snapshot_id,provider_ref)
		 values(gen_random_uuid(),$1,'ready','h','[]','snap-build-24','vm-build-24')`,
		[workspaceId],
	);
	await db.query(
		`insert into workspace_retention(session_id,user_id,vm_id,slug,resources,snapshot_id)
		 values($1,'alice','vm-retired-24','slug-24','{}','snap-retained-24')`,
		[chat.id],
	);
	// Another project of the same user shares the template snapshot snap-1.
	const other = await readyProject("alice", 25);
	const destroyed: string[] = [];
	const snapshots: string[] = [];
	await removeProjectMachine(
		machines(
			async (id) => {
				destroyed.push(id);
			},
			async (id) => {
				snapshots.push(id);
			},
		),
		{ userId: "alice", projectId: project.id },
	);
	expect(storage.removed).toEqual([`alice/${chat.id}`]);
	expect(destroyed.sort()).toEqual([
		"vm-build-24",
		"vm-chat-24",
		"vm-retired-24",
		"vm-template",
	]);
	expect(snapshots.sort()).toEqual(["snap-build-24", "snap-retained-24"]);
	expect(
		(
			await db.query("select 1 from workspace_retention where session_id=$1", [
				chat.id,
			])
		).rows,
	).toEqual([]);
	expect((await listProjects("alice")).map((row) => row.id)).toContain(
		other.project.id,
	);
});

it("keeps the project and its machines when chat files cannot be deleted", async () => {
	const { project, workspaceId } = await readyProject("alice", 26);
	await insertAgentSession({
		userId: "alice",
		projectId: project.id,
		workspaceId,
		harness: "codex",
		providerRef: "vm-chat-26",
	});
	storage.fail = true;
	const destroy = vi.fn(async () => {});
	await expect(
		removeProjectMachine(machines(destroy), {
			userId: "alice",
			projectId: project.id,
		}),
	).rejects.toBeInstanceOf(Response);
	expect(destroy).not.toHaveBeenCalled();
	expect((await listProjects("alice")).map((row) => row.id)).toContain(
		project.id,
	);
});
