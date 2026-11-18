import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { USER_MESSAGE_BULK_KEYS } from "#/domain/session-item-projection";
import {
	agentSessionById,
	agentSessionItemsOfKindsForOwner,
	agentSessionMetadataForOwner,
	backgroundCommandItemsForOwner,
	childAgentSession,
	descendantAgentSessionMetadata,
	descendantTokenUsageItemsForOwner,
	listAgentSessions,
	listSidebarAgentSessions,
	reusableEmptyChat,
	saveAgentSessionProviderRef,
	saveAgentTaskState,
	saveAgentWorkingBranch,
	saveSessionWorkingBranch,
	selectAgentSessionHarness,
	sessionItemForOwner,
	sideChatForParent,
	userMessageAttachmentsForOwner,
} from "./agent-sessions";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

/** Every statement's rows, as the database returned them (what egress is made of). */
type Captured = { sql: string; rows: Record<string, unknown>[] };
let captured: Captured[] = [];

let db: PGlite;
const project = randomUUID();
beforeEach(async () => {
	captured = [];
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now());`);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		captured.push({ sql, rows: result.rows as Record<string, unknown>[] });
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

const BIG = "x".repeat(5000);

function turn(n: number) {
	return [
		{
			kind: "userMessage",
			id: `u${n}`,
			text: `ask ${n}`,
			attachments: [{ id: `file-${n}`, name: "a.txt", kind: "pastedText" }],
			memory: { notes: [BIG] },
			contextUsage: { context: 1 },
			apiUsage: {
				inputTokens: 10,
				outputTokens: 1,
				uncachedInputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		},
		{
			kind: "dynamicToolCall",
			id: `u${n}-bg`,
			tool: "run_command",
			status: "completed",
			input: BIG,
			output: BIG,
			background: { id: `bg${n}`, label: "dev", startedAt: 1 },
		},
		{ kind: "canvas", id: `u${n}-canvas`, title: "c", html: BIG },
		{ kind: "agentMessage", id: `u${n}-reply`, text: `reply ${n}` },
	];
}

async function chat(
	items: readonly unknown[],
	fields: { parent?: string; branch?: string; sideChat?: boolean } = {},
) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items,parent_session_id,working_branch,agent_budget) values($1,'alice',$2,'api','chat',$3::jsonb,$4,$5,$6::jsonb)",
		[
			id,
			project,
			JSON.stringify(items),
			fields.parent ?? null,
			fields.branch ?? null,
			fields.sideChat ? JSON.stringify({ sideChat: "true" }) : null,
		],
	);
	return id;
}

const lastRows = () => captured.at(-1)?.rows ?? [];
const hasTranscript = (rows: Record<string, unknown>[]) =>
	rows.some((row) => row.items !== null && row.items !== undefined);

it("rows that update a chat return its row without the transcript", async () => {
	const items = [...turn(0), ...turn(1)];
	const root = await chat(items, { branch: "chat/a" });
	const child = await chat(items, { parent: root });

	const reads = [
		await saveSessionWorkingBranch("alice", root, "chat/b", "main"),
		await saveAgentWorkingBranch("alice", root, "chat/c"),
		await selectAgentSessionHarness("alice", project, root, "codex"),
		await saveAgentSessionProviderRef(root, "vm-1"),
		await saveAgentTaskState(child, "working"),
	];
	for (const row of captured) expect(hasTranscript(row.rows)).toBe(false);
	for (const session of reads) {
		expect(session?.items).toBeNull();
		expect(session?.userId).toBe("alice");
	}
	// The fields callers use are the row's own.
	expect(reads[0]).toMatchObject({
		workingBranch: "chat/b",
		baseBranch: "main",
	});
	expect(reads[1]).toMatchObject({ workingBranch: "chat/c" });
	expect(reads[2]).toMatchObject({ harness: "codex", listedModelId: null });
	expect(reads[3]).toMatchObject({ providerRef: "vm-1", status: "ready" });
	expect(reads[4]).toMatchObject({
		taskState: "working",
		turnStatus: "running",
	});
	// The transcript itself is untouched.
	const stored = await db.query<{ n: number }>(
		"select jsonb_array_length(items) as n from agent_session where id=$1",
		[root],
	);
	expect(stored.rows[0]?.n).toBe(items.length);
});

it("a reused empty chat still reports an empty transcript, not an unknown one", async () => {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,provider_ref) values($1,'alice',$2,'api','New session',null)",
		[id, project],
	);
	const reused = await reusableEmptyChat("alice", project, "codex");
	expect(reused?.id).toBe(id);
	expect(reused?.items).toEqual([]);
});

it("side chat, by-id and child reads carry no transcript", async () => {
	const root = await chat(turn(0));
	const side = await chat(turn(1), { parent: root, sideChat: true });
	expect(await sideChatForParent("alice", root)).toMatchObject({ id: side });
	expect(hasTranscript(lastRows())).toBe(false);
	expect(await agentSessionById(side)).toMatchObject({
		id: side,
		title: "chat",
	});
	expect(hasTranscript(lastRows())).toBe(false);
	expect((await childAgentSession("alice", root))?.id).toBe(side);
	expect(hasTranscript(lastRows())).toBe(false);
});

it("kinds reads leave out what callers do not read", async () => {
	const a = await chat([...turn(0), ...turn(1)]);
	const read = async (
		kinds: string[],
		projection?: Parameters<typeof agentSessionItemsOfKindsForOwner>[3],
	) =>
		(
			await agentSessionItemsOfKindsForOwner("alice", [a], kinds, projection)
		).get(a) as Record<string, unknown>[];

	const full = await read(["userMessage"]);
	expect(full[0]).toHaveProperty("memory");

	const slim = await read(["userMessage"], { omit: USER_MESSAGE_BULK_KEYS });
	expect(slim.map((item) => item.text)).toEqual(["ask 0", "ask 1"]);
	for (const item of slim) {
		expect(item).not.toHaveProperty("attachments");
		expect(item).not.toHaveProperty("memory");
		expect(item).not.toHaveProperty("contextUsage");
		expect(item).toHaveProperty("apiUsage");
	}
	expect(JSON.stringify(slim).length).toBeLessThan(
		JSON.stringify(full).length / 5,
	);

	const ids = await read(["userMessage"], { only: "ids" });
	expect(ids).toEqual([
		{ kind: "userMessage", id: "u0", text: "" },
		{ kind: "userMessage", id: "u1", text: "" },
	]);

	const noTool = await read(["dynamicToolCall"], { omit: ["input", "output"] });
	expect(noTool[0]).toMatchObject({ tool: "run_command", status: "completed" });
	expect(noTool[0]).not.toHaveProperty("output");
});

it("the token-use read carries each turn's recorded usage and nothing else", async () => {
	const root = await chat([]);
	const child = await chat(turn(0), { parent: root });
	const rows = await descendantTokenUsageItemsForOwner("alice", root);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.id).toBe(child);
	expect(rows[0]?.usageItems).toEqual([
		{
			kind: "userMessage",
			id: "u0",
			text: "",
			apiUsage: {
				inputTokens: 10,
				outputTokens: 1,
				uncachedInputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		},
	]);
});

it("background command cards come without their output", async () => {
	const a = await chat(turn(0));
	const full = (await backgroundCommandItemsForOwner("alice", [a])).get(a) as {
		output?: unknown;
		background: { id: string };
		input?: string;
	}[];
	expect(full[0]?.background.id).toBe("bg0");
	expect(full[0]).not.toHaveProperty("output");
	expect(full[0]?.input).toBe(BIG);
	const records = (
		await backgroundCommandItemsForOwner("alice", [a], { records: true })
	).get(a) as { input?: string }[];
	expect(records[0]).not.toHaveProperty("input");
});

it("reads one card by id and the files attached to messages, not the transcript", async () => {
	const a = await chat([
		...turn(0),
		{ kind: "pushApproval", id: "push-1", requestId: "r1" },
	]);
	expect(
		await sessionItemForOwner("alice", a, "push-1", "pushApproval"),
	).toMatchObject({
		requestId: "r1",
	});
	expect(
		await sessionItemForOwner("alice", a, "nope", "pushApproval"),
	).toBeNull();
	expect(
		await sessionItemForOwner("mallory", a, "push-1", "pushApproval"),
	).toBeNull();
	expect(await userMessageAttachmentsForOwner("alice", a)).toEqual([
		{ id: "file-0", name: "a.txt", kind: "pastedText" },
	]);
	expect(await userMessageAttachmentsForOwner("mallory", a)).toEqual([]);
	for (const row of captured) expect(hasTranscript(row.rows)).toBe(false);
});

it("regression guard: hot-path reads never return a chat's `items`", async () => {
	const root = await chat([...turn(0), ...turn(1)]);
	const child = await chat(turn(0), { parent: root });
	const side = await chat(turn(1), { parent: root, sideChat: true });
	const hot: [string, () => Promise<unknown>][] = [
		[
			"agentSessionMetadataForOwner",
			() => agentSessionMetadataForOwner("alice", root),
		],
		["listAgentSessions", () => listAgentSessions("alice", project)],
		[
			"listSidebarAgentSessions",
			() => listSidebarAgentSessions("alice", project),
		],
		["childAgentSession", () => childAgentSession("alice", root)],
		["sideChatForParent", () => sideChatForParent("alice", root)],
		["agentSessionById", () => agentSessionById(child)],
		[
			"descendantAgentSessionMetadata",
			() => descendantAgentSessionMetadata("alice", root),
		],
		[
			"saveSessionWorkingBranch",
			() => saveSessionWorkingBranch("alice", root, "b", "main"),
		],
		[
			"saveAgentSessionProviderRef",
			() => saveAgentSessionProviderRef(side, "vm"),
		],
		["saveAgentTaskState", () => saveAgentTaskState(child, "idle")],
		[
			"selectAgentSessionHarness",
			() => selectAgentSessionHarness("alice", project, root, "api"),
		],
	];
	for (const [name, run] of hot) {
		captured = [];
		await run();
		expect(captured.length, name).toBeGreaterThan(0);
		for (const query of captured)
			expect(hasTranscript(query.rows), name).toBe(false);
	}
});

it("regression guard: hot-path functions do not select the transcript column", () => {
	const source = readFileSync("src/server/adapters/agent-sessions.ts", "utf8");
	const body = (name: string) => {
		const start = source.search(new RegExp(`export async function ${name}\\b`));
		expect(start, name).toBeGreaterThanOrEqual(0);
		const rest = source.slice(start + 10);
		const end = rest.search(/\n(export )?(async )?function |\n\/\*\*\n/);
		return source.slice(start, start + 10 + (end < 0 ? rest.length : end));
	};
	const hot = [
		"selectAgentSessionHarness",
		"listAgentSessions",
		"listSidebarAgentSessions",
		"agentSessionMetadataForOwner",
		"latestAgentSessionMetadata",
		"chatToOpenMetadata",
		"saveSessionBranchSelection",
		"saveSessionWorkingBranch",
		"adoptChatPublicationBranch",
		"saveAgentWorkingBranch",
		"agentSessionById",
		"childAgentSession",
		"sideChatForParent",
		"saveAgentTaskState",
		"saveAgentSessionProviderRef",
		"descendantAgentSessionMetadata",
		"agentSessionAncestorMetadata",
		"agentSessionPageForOwner",
	];
	for (const name of hot) {
		const text = body(name);
		// `${SESSION_COLUMNS}` bare selects `items`; only the replaced forms are allowed.
		const bare = text.match(/\$\{SESSION_COLUMNS\}/g) ?? [];
		expect(bare, `${name} selects the whole row`).toEqual([]);
	}
});
