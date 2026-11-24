import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parsePeerMessage } from "../src/domain/thread-peer";
import { insertAgentSession } from "../src/server/adapters/agent-sessions";
import { saveProject } from "../src/server/adapters/projects";
import {
	NO_PEER_THREAD,
	readPeerThread,
	sendPeerMessage,
} from "../src/server/services/thread-peer-read";

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
vi.mock("../src/server/config", () => {
	const serverConfig = () => ({
		APP_URL: "[REDACTED]",
		BETTER_AUTH_SECRET: "test-only-secret-longer-than-thirty-two-characters",
	});
	return {
		serverConfig,
		databaseConfig: serverConfig,
		vaultConfig: serverConfig,
	};
});

const MIGRATIONS = [
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
	"20261029200000_archive.sql",
	"20261003020000_infrastructure_usage.sql",
	"20261003021000_infrastructure_vm_identity.sql",
	"20261026100000_agent_session_item.sql",
	"20261112120000_y_mode.sql",
	"20261118120000_thread_number.sql",
];

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	await db.exec(
		"create table api_turn(session_id uuid,state text); create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now())",
	);
	for (const file of MIGRATIONS)
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		"alter table agent_session drop constraint agent_session_harness_check; alter table agent_session add constraint agent_session_harness_check check (harness in ('codex','claude','opencode','api'))",
	);
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

async function project(user: string, name: string) {
	const saved = await saveProject(
		user,
		{
			installationId: 1,
			repositoryId: Math.floor(Math.random() * 1_000_000),
			fullName: `test/${name}`,
			defaultBranch: "main",
		},
		"main",
	);
	const workspaceId = crypto.randomUUID();
	await db.query(
		`insert into workspace(id,user_id,project_id,status,provider_ref,template_snapshot_id)
		 values($1,$2,$3,'ready','vm-template','snap-1')`,
		[workspaceId, user, saved.id],
	);
	return { id: saved.id, workspaceId };
}

async function thread(
	user: string,
	p: { id: string; workspaceId: string },
	title: string,
	reply?: string,
) {
	const session = await insertAgentSession({
		userId: user,
		projectId: p.id,
		workspaceId: p.workspaceId,
		harness: "api",
	});
	await db.query("update agent_session set title=$2 where id=$1", [
		session.id,
		title,
	]);
	if (reply)
		await db.query(
			`insert into agent_session_item(session_id,position,kind,item_id,starts_turn,item) values
			 ($1,0,'userMessage','u0',true,$2),($1,1,'agentMessage','a1',false,$3)`,
			[
				session.id,
				JSON.stringify({ kind: "userMessage", id: "u0", text: "do it" }),
				JSON.stringify({ kind: "agentMessage", id: "a1", text: reply }),
			],
		);
	return session.id;
}

it("reads and messages threads against the real schema, refusing everything else", async () => {
	const main = await project("alice", "peer-main");
	const other = await project("alice", "peer-other");
	const bobs = await project("bob", "peer-bob");
	const a = await thread("alice", main, "Reader");
	const b = await thread("alice", main, "Fix login", "PR #12 is ready");
	const elsewhere = await thread("alice", other, "Other project", "secret?");
	const bobThread = await thread("bob", bobs, "Bob's", "bob reply");
	const helper = await thread("alice", main, "Helper", "helper reply");
	await db.query(
		"update agent_session set parent_session_id=$2, agent_role='writer' where id=$1",
		[helper, b],
	);
	const y2 = await thread("alice", main, "Y2", "y2 reply");
	await db.query("update project set y_enabled=true where id=$1", [main.id]);
	await db.query("update agent_session set chat_role='y2' where id=$1", [y2]);

	const self = { userId: "alice", projectId: main.id, selfId: a };
	const read = (id: string, user = "alice") =>
		readPeerThread({ ...self, userId: user, id });

	expect(await read(b)).toContain("PR #12 is ready");
	expect(await read(b)).toContain('Thread "Fix login"');
	for (const id of [elsewhere, helper, y2, a, crypto.randomUUID()])
		expect(await read(id)).toBe(NO_PEER_THREAD);
	expect(await read(bobThread)).toBe(NO_PEER_THREAD);
	expect(await read(b, "bob")).toBe(NO_PEER_THREAD);

	const sent: { text: string }[] = [];
	const send = async (...args: unknown[]) => {
		sent.push(args[2] as { text: string });
		return { turnStatus: "running" };
	};
	const message = (id: string) =>
		sendPeerMessage(
			{
				...self,
				id,
				text: "Please rebase",
				mode: "queue",
				turnId: "turn-1",
				machines: {} as never,
			},
			{ send: send as never },
		);
	expect(await message(b)).toContain("its turn started");
	expect(sent).toHaveLength(1);
	expect(parsePeerMessage(sent[0]?.text ?? "")).toEqual({
		from: "Reader",
		body: "Please rebase",
	});
	for (const id of [elsewhere, helper, y2, bobThread])
		expect(await message(id)).toBe(NO_PEER_THREAD);
	expect(sent).toHaveLength(1);
});
