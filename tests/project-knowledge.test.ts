import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "../src/domain/ids";
import type { AgentSessionRecord } from "../src/server/adapters/agent-sessions";
import {
	consolidateCloudProjectMemory,
	loadCloudProjectKnowledge,
	readCloudProjectMemory,
	readCloudProjectMemoryHistory,
	recordCloudProjectReport,
	rememberCloudProjectKnowledge,
	searchCloudProjectMemory,
} from "../src/server/services/project-knowledge";
import { projectMemoryTools } from "../src/server/services/project-memory-tools";

let db: PGlite;
const projectId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const session = {
	id: sessionId,
	projectId,
	userId: "alice",
	parentSessionId: null,
	title: "Fix branches",
} as AgentSessionRecord;
const entry = {
	key: "branches",
	title: "Branch selection",
	content: "Implemented in the branch picker; check the current revision.",
	sources: ["repo/src/branches.ts"],
	status: "tested" as const,
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params?: unknown[]) => db.query(sql, params),
		connect: async () => ({
			query: (sql: string, params?: unknown[]) => db.query(sql, params),
			release: () => {},
		}),
	}),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create table project(id uuid primary key,user_id text);
	 create table agent_session(id uuid primary key,user_id text,parent_session_id uuid,candidate_index integer);
	 create table project_briefing(project_id uuid primary key references project(id),text text,updated_at timestamptz);
	 create table project_trace(id uuid primary key,project_id uuid references project(id),session_id uuid references agent_session(id),area text,summary text,created_at timestamptz default now());
	 insert into project values('${projectId}','alice');
	 insert into agent_session values('${sessionId}','alice',null,null);`);
	await db.exec("create role anon; create role authenticated;");
	await db.exec(
		await readFile(
			"supabase/migrations/20261005200000_project_memory_revisions.sql",
			"utf8",
		),
	);
});
beforeEach(() =>
	db.exec(
		"delete from project_briefing; delete from project_trace; delete from project_memory_revision",
	),
);
afterAll(() => db.close());

it("makes maintained Markdown available to a new root and relevant children", async () => {
	await rememberCloudProjectKnowledge(session, entry);
	expect((await readCloudProjectMemory(session, "branches")).text).toContain(
		"repo/src/branches.ts",
	);
	expect(
		await loadCloudProjectKnowledge(
			{ ...session, parentSessionId: "parent" },
			"Fix branch selection",
		),
	).toContain("Branch selection");
	expect(
		await loadCloudProjectKnowledge(
			{ ...session, parentSessionId: "parent" },
			"Change avatar",
		),
	).toContain("[[memory/branches]]");
	await rememberCloudProjectKnowledge(session, {
		...entry,
		content: "Corrected path",
		sources: ["repo/src/new-branches.ts"],
	});
	const loaded = (await readCloudProjectMemory(session, "branches")).text;
	expect(loaded).toContain("new-branches.ts");
	expect(loaded).not.toContain("repo/src/branches.ts");
});

it("enforces ownership and prevents children and competing leads from publishing knowledge", async () => {
	await rememberCloudProjectKnowledge(session, entry);
	const other = { ...session, userId: "bob" };
	expect(await loadCloudProjectKnowledge(other, "branches")).toBe("");
	await expect(rememberCloudProjectKnowledge(other, entry)).rejects.toThrow(
		"not available",
	);
	await expect(
		rememberCloudProjectKnowledge(
			{ ...session, parentSessionId: "parent" },
			entry,
		),
	).rejects.toThrow("only root chats");
	expect(await loadCloudProjectKnowledge(session, "branches")).toContain(
		"Branch selection",
	);
});

it("records completed reports idempotently without replacing curated knowledge", async () => {
	await rememberCloudProjectKnowledge(session, entry);
	const items = [
		{
			kind: "userMessage" as const,
			id: SessionItemId("user"),
			text: "Fix repo/src/branches.ts",
		},
		{
			kind: "agentMessage" as const,
			id: SessionItemId("reply"),
			text: "Reviewed the implementation and its tests.",
		},
	];
	await recordCloudProjectReport(session, turnId, items);
	await recordCloudProjectReport(session, turnId, items);
	expect((await db.query("select * from project_trace")).rows).toHaveLength(1);
	expect(await loadCloudProjectKnowledge(session, "branches")).toContain(
		"Recent agent reports (not verified implementation facts)",
	);
	expect(await loadCloudProjectKnowledge(session, "branches")).toContain(
		"Branch selection",
	);
	expect(
		await loadCloudProjectKnowledge(
			{ ...session, parentSessionId: "parent" },
			"branches",
		),
	).not.toContain("Reviewed the implementation");
});

it("redacts credential-shaped strings and leaves knowledge intact after overflow", async () => {
	await rememberCloudProjectKnowledge(session, {
		...entry,
		content: "Use the vault, never sk-or-v1-abcdefghijklmnopqrstuv",
	});
	expect(await loadCloudProjectKnowledge(session, "branches")).not.toContain(
		"sk-or-v1-",
	);
	await expect(
		rememberCloudProjectKnowledge(session, {
			...entry,
			key: "too-large",
			content: "x".repeat(12000),
		}),
	).rejects.toThrow("concise");
	expect(await loadCloudProjectKnowledge(session, "branches")).toContain(
		"Use the vault",
	);
});

it("retrieves linked topics across fresh chats with owner-scoped revision history", async () => {
	await rememberCloudProjectKnowledge(session, entry);
	const fresh = { ...session, title: "Fresh conversation" };
	const found = await searchCloudProjectMemory(fresh, "branch picker");
	expect(found.entries[0].key).toBe("branches");
	expect(
		await loadCloudProjectKnowledge(fresh, "new unrelated task"),
	).toContain("[[memory/branches]]");
	await rememberCloudProjectKnowledge(
		session,
		{ ...entry, content: "Follow [[memory/routing]]; new evidence." },
		found.revision,
	);
	const history = await readCloudProjectMemoryHistory(fresh, "branches");
	expect(history.entries).toHaveLength(2);
	expect(history.entries[0].previous).toContain("branch picker");
	expect(history.entries[0].next).toContain("[[memory/routing]]");
	expect(
		(await searchCloudProjectMemory({ ...session, userId: "bob" }, "")).entries,
	).toEqual([]);
	expect(
		(
			await readCloudProjectMemoryHistory(
				{ ...session, userId: "bob" },
				"branches",
			)
		).entries,
	).toEqual([]);
});

it("consolidates atomically and rejects stale concurrent writes without losing notes or history", async () => {
	await rememberCloudProjectKnowledge(session, entry);
	const old = await searchCloudProjectMemory(session, "");
	await rememberCloudProjectKnowledge(
		session,
		{ ...entry, key: "duplicate", content: "Duplicate branch note" },
		old.revision,
	);
	await expect(
		rememberCloudProjectKnowledge(
			session,
			{ ...entry, content: "Stale overwrite" },
			old.revision,
		),
	).rejects.toThrow("changed");
	await expect(
		consolidateCloudProjectMemory(session, {
			entries: [],
			removeKeys: ["branches"],
			expectedRevision: old.revision,
		}),
	).rejects.toThrow("changed");
	const current = await searchCloudProjectMemory(session, "");
	await consolidateCloudProjectMemory(session, {
		entries: [{ ...entry, content: "Consolidated findings" }],
		removeKeys: ["duplicate"],
		expectedRevision: current.revision,
	});
	expect((await readCloudProjectMemory(session, "branches")).text).toContain(
		"Consolidated findings",
	);
	expect((await readCloudProjectMemory(session, "duplicate")).found).toBe(
		false,
	);
	expect(
		(await readCloudProjectMemoryHistory(session, "duplicate")).entries[0]
			.previous,
	).toContain("Duplicate branch note");
	expect(
		(await readCloudProjectMemoryHistory(session, "duplicate")).entries[0].next,
	).toBe("");
});

it("rejects broken-link removals and invalid consolidation without partial history", async () => {
	await rememberCloudProjectKnowledge(session, entry);
	await rememberCloudProjectKnowledge(session, {
		...entry,
		key: "routing",
		content: "See [[memory/branches]]",
	});
	const before = await searchCloudProjectMemory(session, "");
	await expect(
		consolidateCloudProjectMemory(session, {
			expectedRevision: before.revision,
			entries: [],
			removeKeys: ["branches"],
		}),
	).rejects.toThrow("linked");
	await expect(
		consolidateCloudProjectMemory(session, {
			expectedRevision: before.revision,
			entries: [{ ...entry, content: "x".repeat(4001) }],
			removeKeys: ["routing"],
		}),
	).rejects.toThrow("concise");
	expect((await searchCloudProjectMemory(session, "")).revision).toBe(
		before.revision,
	);
	expect(
		(await db.query("select * from project_memory_revision")).rows,
	).toHaveLength(2);
});

it("paginates all topics and revisions without booting a VM; children cannot mutate", async () => {
	for (let index = 0; index < 15; index++)
		await rememberCloudProjectKnowledge(session, {
			...entry,
			key: `note-${index}`,
		});
	const first = await searchCloudProjectMemory(session, "");
	expect(first.entries).toHaveLength(12);
	expect(first.nextOffset).toBe(12);
	expect(
		(await searchCloudProjectMemory(session, "", 12)).entries,
	).toHaveLength(3);
	const workspace = vi.fn(async () => {
		throw new Error("VM unavailable");
	});
	const tools = projectMemoryTools({
		session,
		workspace,
		once: async (_id, run) => run(),
	});
	if (!tools.search_project_memory.execute) throw new Error("Missing tool");
	expect(
		await tools.search_project_memory.execute(
			{ query: "branches", offset: 0 },
			{ toolCallId: "memory", messages: [], context: {} },
		),
	).toMatchObject({ total: 15 });
	expect(workspace).not.toHaveBeenCalled();
	for (const restricted of [{ ...session, parentSessionId: "parent" }]) {
		const childTools = projectMemoryTools({
			session: restricted,
			workspace,
			once: async (_id, run) => run(),
		});
		expect(childTools.remember_project).toBeUndefined();
		expect(childTools.consolidate_project_memory).toBeUndefined();
		expect(childTools.read_project_memory).toBeDefined();
	}
});

it("keeps memory revisions private to the server database role", async () => {
	expect(
		(
			await db.query(
				"select relrowsecurity from pg_class where relname='project_memory_revision'",
			)
		).rows[0],
	).toMatchObject({ relrowsecurity: true });
	for (const role of ["anon", "authenticated"]) {
		await db.exec(`set role ${role}`);
		try {
			await expect(
				db.query("select * from project_memory_revision"),
			).rejects.toThrow();
		} finally {
			await db.exec("reset role");
		}
	}
});

it("returns small history previews and retrieves the complete owner-scoped revision", async () => {
	const text = "Historical evidence ".repeat(100);
	await rememberCloudProjectKnowledge(session, { ...entry, content: text });
	const timeline = await readCloudProjectMemoryHistory(session, "branches");
	expect(timeline.entries[0].next.length).toBe(600);
	expect(timeline.entries[0].abbreviated).toBe(true);
	const full = await readCloudProjectMemoryHistory(
		session,
		"branches",
		0,
		timeline.entries[0].id,
	);
	expect(full.entries[0].next).toContain(text.trim());
	expect(full.entries[0].sessionId).toBe(session.id);
	expect(
		(
			await readCloudProjectMemoryHistory(
				{ ...session, userId: "bob" },
				"branches",
				0,
				timeline.entries[0].id,
			)
		).entries,
	).toEqual([]);
});

import { readFile } from "node:fs/promises";
