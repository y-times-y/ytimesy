import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "../src/domain/ids";
import type { AgentSessionRecord } from "../src/server/adapters/agent-sessions";
import {
	loadCloudProjectKnowledge,
	recordCloudProjectReport,
	rememberCloudProjectKnowledge,
} from "../src/server/services/project-knowledge";

let db: PGlite;
const projectId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const session = {
	id: sessionId,
	projectId,
	userId: "alice",
	parentSessionId: null,
	candidateIndex: null,
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
});
beforeEach(() =>
	db.exec("delete from project_briefing; delete from project_trace"),
);
afterAll(() => db.close());

it("makes maintained Markdown available to a new root and relevant children", async () => {
	await rememberCloudProjectKnowledge(session, entry);
	expect(await loadCloudProjectKnowledge(session, "New chat")).toContain(
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
	).toBe("");
	await rememberCloudProjectKnowledge(session, {
		...entry,
		content: "Corrected path",
		sources: ["repo/src/new-branches.ts"],
	});
	const loaded = await loadCloudProjectKnowledge(session, "New chat");
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
	for (const forbidden of [
		{ ...session, parentSessionId: "parent" },
		{ ...session, candidateIndex: 1 },
	])
		await expect(
			rememberCloudProjectKnowledge(forbidden, entry),
		).rejects.toThrow("only non-competing leads");
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
	).rejects.toThrow("full");
	expect(await loadCloudProjectKnowledge(session, "branches")).toContain(
		"Use the vault",
	);
});
