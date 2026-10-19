import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	chatHoldingSend,
	claimChatForSend,
	releasingChatClaimOnFailure,
	reusableEmptyChat,
	titleUntitledAgentSession,
} from "./agent-sessions";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const project = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,candidate_index int,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_execution text,depends_on_session_id uuid,task_summary text,task_review_state text,task_branch text,task_pull_request_url text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,idempotency_key text);`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

async function chat(fields: {
	title?: string;
	items?: unknown[];
	user?: string;
	parent?: string;
}) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items,parent_session_id) values($1,$2,$3,'codex',$4,$5,$6)",
		[
			id,
			fields.user ?? "alice",
			project,
			fields.title ?? "New session",
			JSON.stringify(fields.items ?? []),
			fields.parent ?? null,
		],
	);
	return id;
}

it("reopens the owner's unused chat instead of creating another", async () => {
	const used = await chat({
		items: [{ kind: "userMessage", id: "m", text: "hi" }],
	});
	const ran = await chat({});
	await db.query("insert into api_turn values($1,$2)", [randomUUID(), ran]);
	await chat({ user: "bob" });
	await chat({ parent: used, title: "New session" });
	const machine = await chat({});
	await db.query("update agent_session set provider_ref='vm-1' where id=$1", [
		machine,
	]);
	expect(await reusableEmptyChat("alice", project, "api")).toBeNull();
	const empty = await chat({});
	const reused = await reusableEmptyChat("alice", project, "api");
	expect(reused?.id).toBe(empty);
	expect(reused?.harness).toBe("api");
});

it("names an untitled chat after its first message and keeps chosen titles", async () => {
	const untitled = await chat({});
	const named = await chat({ title: "Billing rework" });
	await titleUntitledAgentSession("alice", untitled, "Fix the login redirect");
	await titleUntitledAgentSession("alice", named, "Something else");
	await titleUntitledAgentSession("bob", untitled, "Not theirs");
	const titles = await db.query<{ id: string; title: string }>(
		"select id,title from agent_session",
	);
	const byId = Object.fromEntries(
		titles.rows.map((row) => [row.id, row.title]),
	);
	expect(byId[untitled]).toBe("Fix the login redirect");
	expect(byId[named]).toBe("Billing rework");
});

it("never reuses a chat whose first send is still on its way", async () => {
	// The send claims its chat before storing files or committing.
	const sending = await chat({});
	await claimChatForSend("alice", sending, "Fix the login redirect\nmore");
	expect(await reusableEmptyChat("alice", project, "api")).toBeNull();
	// A draft send reuses and claims a chat in one step.
	const empty = await chat({});
	const claimed = await reusableEmptyChat(
		"alice",
		project,
		"codex",
		"Add dark mode",
	);
	expect(claimed?.id).toBe(empty);
	expect(claimed?.title).toBe("Add dark mode");
	expect(await reusableEmptyChat("alice", project, "api")).toBeNull();
	const titles = await db.query<{ title: string }>(
		"select title from agent_session where id=$1",
		[sending],
	);
	expect(titles.rows[0]?.title).toBe("Fix the login redirect");
});

it("hands a chat back to New chat when its first send is rejected", async () => {
	const rejected = await chat({});
	expect(await claimChatForSend("alice", rejected, "Use the gone model")).toBe(
		true,
	);
	await expect(
		releasingChatClaimOnFailure("alice", rejected, "Use the gone model", () =>
			Promise.reject(new Error("The selected model is no longer available.")),
		),
	).rejects.toThrow(/no longer available/);
	expect((await reusableEmptyChat("alice", project, "api"))?.id).toBe(rejected);

	// A send that stored its message, or a chat already named, keeps its title.
	const stored = await chat({});
	await claimChatForSend("alice", stored, "Add dark mode");
	await expect(
		releasingChatClaimOnFailure("alice", stored, "Add dark mode", async () => {
			await db.query("update agent_session set items=$2 where id=$1", [
				stored,
				JSON.stringify([
					{ kind: "userMessage", id: "m", text: "Add dark mode" },
				]),
			]);
			throw new Error("Later failure");
		}),
	).rejects.toThrow();
	const named = await chat({ title: "Billing rework" });
	expect(await claimChatForSend("alice", named, "Billing rework")).toBe(false);
	const titles = await db.query<{ id: string; title: string }>(
		"select id,title from agent_session",
	);
	const byId = Object.fromEntries(
		titles.rows.map((row) => [row.id, row.title]),
	);
	expect(byId[stored]).toBe("Add dark mode");
	expect(byId[named]).toBe("Billing rework");
});

it("finds the chat a new chat's first send landed in by its message id", async () => {
	const landed = await chat({ title: "Fix the login redirect" });
	const message = randomUUID();
	await db.query("insert into api_turn values($1,$2,$3)", [
		randomUUID(),
		landed,
		message,
	]);
	expect(await chatHoldingSend("alice", project, message)).toBe(landed);
	expect(await chatHoldingSend("bob", project, message)).toBeNull();
	expect(await chatHoldingSend("alice", randomUUID(), message)).toBeNull();
	expect(await chatHoldingSend("alice", project, randomUUID())).toBeNull();
});
