import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import { subagentTree } from "#/domain/subagent-tree";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	type MentionDeps,
	type MentionedThread,
	mentionNoteFor,
	mentionNoteFromTree,
	withMentionNote,
} from "./agent-mentions";

vi.mock("../adapters/database", () => ({ database: () => ({}) }));

function row(
	id: string,
	parentSessionId: string | null,
	extra: Partial<AgentSessionRecord> = {},
) {
	return {
		id,
		parentSessionId,
		userId: "owner",
		projectId: "p",
		title: id,
		harness: "api",
		listedModelId: "model",
		turnStatus: "running",
		createdAt: "2026-10-21T10:00:00Z",
		updatedAt: "2026-10-21T10:00:00Z",
		items: [],
		agentRole: parentSessionId ? "writer" : null,
		taskState: "working",
		...extra,
	} as AgentSessionRecord;
}

function deps(sessions: AgentSessionRecord[]) {
	return {
		session: vi.fn(
			async (_userId: string, id: string) =>
				sessions.find((session) => session.id === id) ?? null,
		),
		descendants: vi.fn(async (_userId: string, rootId: string) =>
			sessions.filter((session) => session.parentSessionId === rootId),
		),
		now: () => Date.parse("2026-10-21T10:05:00Z"),
	} satisfies MentionDeps;
}

const chat = [
	row("root", null),
	row("w", "root", { title: "Fix pricing rounding" }),
	row("r", "root", {
		title: "Find the export API",
		agentRole: "researcher",
		createdAt: "2026-10-21T10:01:00Z",
		turnStatus: "completed",
		taskState: "done",
	}),
];

describe("a message that @mentions helpers", () => {
	it("tells the lead each mentioned helper's agent id and state", async () => {
		expect(
			await mentionNoteFor(
				"owner",
				"root",
				"Is @research-1 done? Tell @build-1 to wait. @build-9 @Main",
				deps(chat),
			),
		).toBe(
			`[@mentions in the user's message: @research-1 = agent 2 (researcher, done, "Find the export API"); @build-1 = agent 1 (writer, working, "Fix pricing rounding")]`,
		);
	});

	it("tells a helper who Main and the other helpers are, never itself", () => {
		const nodes = subagentTree("root", chat, Date.now()).nodes;
		expect(
			mentionNoteFromTree(
				"@Main asked; @build-1 check @research-1",
				nodes,
				"w",
			),
		).toBe(
			`[@mentions in the user's message: @Main = the lead agent; @research-1 = agent 2 (researcher, done, "Find the export API")]`,
		);
		expect(mentionNoteFromTree("@build-1 go", nodes, "w")).toBeNull();
	});

	it("reads nothing without a helper mention", async () => {
		const fake = deps(chat);
		expect(await mentionNoteFor("owner", "root", "hi @Main", fake)).toBeNull();
		expect(fake.session).not.toHaveBeenCalled();
	});

	it("follows the request that started the turn, not a report's wake-up", async () => {
		const items: SessionItem[] = [
			{ kind: "userMessage", id: SessionItemId("u1"), text: "ask @build-1" },
		];
		const request: ModelMessage[] = [{ role: "user", content: "ask @build-1" }];
		const input = {
			userId: "owner",
			session: { id: "root", parentSessionId: null },
			items,
		};
		const noted = await withMentionNote(
			{ ...input, messages: request },
			deps(chat),
		);
		expect(noted).toHaveLength(2);
		expect(noted[1]?.content).toContain("@build-1 = agent 1");
		const woken: ModelMessage[] = [
			...request,
			{ role: "assistant", content: "Started." },
			{ role: "user", content: "[agent 1 writer finished]" },
		];
		expect(
			await withMentionNote({ ...input, messages: woken }, deps(chat)),
		).toBe(woken);
		// A resumed step already has its note last.
		expect(
			await withMentionNote({ ...input, messages: noted }, deps(chat)),
		).toBe(noted);
	});
});

describe("a message that @mentions threads of the project", () => {
	const thread = (name: string, extra: Partial<MentionedThread> = {}) => ({
		id: "7d4e0a10-0000-4000-8000-00000000000c",
		title: "Fix login redirect",
		turnStatus: "running",
		archived: false,
		projectName: name,
		...extra,
	});
	const withThreads = (
		lookup: (number: number) => MentionedThread | null,
		sessions = chat,
	) => ({
		...deps(sessions),
		thread: vi.fn(async (_user: string, _project: string, number: number) =>
			lookup(number),
		),
	});

	it("tells the lead which thread is meant, with the id its tools take", async () => {
		const fake = withThreads((number) =>
			number === 12 ? thread("ytimesy") : null,
		);
		const note = await mentionNoteFor(
			"owner",
			"root",
			"Look at @ytimesy-12, not @ytimesy-99 or @alice-12.",
			fake,
		);
		expect(note).toBe(
			`[@mentions in the user's message: @ytimesy-12 = thread "Fix login redirect" (id 7d4e0a10-0000-4000-8000-00000000000c, working)]`,
		);
		// Only this project's threads, found by number in this project.
		expect(fake.thread).toHaveBeenCalledWith("owner", "p", 12);
	});

	it("names an archived or idle thread's state", async () => {
		const archived = withThreads(() => thread("ytimesy", { archived: true }));
		expect(
			await mentionNoteFor("owner", "root", "see @ytimesy-3", archived),
		).toContain("archived)");
		const idle = withThreads(() =>
			thread("ytimesy", { turnStatus: "completed" }),
		);
		expect(
			await mentionNoteFor("owner", "root", "see @ytimesy-3", idle),
		).toContain("idle)");
	});

	it("reads an agent's name as the agent, and a thread's name beside it", async () => {
		const fake = withThreads((number) =>
			number === 7 ? thread("ytimesy") : thread("build"),
		);
		const note = await mentionNoteFor(
			"owner",
			"root",
			"@build-1 should read @ytimesy-7",
			fake,
		);
		expect(note).toContain("@build-1 = agent 1 (writer, working");
		expect(note).toContain("@ytimesy-7 = thread");
		// build-1 is the helper, never a thread named "build" number 1.
		expect(note?.match(/@build-1/g)).toHaveLength(1);
	});

	it("is quiet when the message names no thread and no helper", async () => {
		const fake = withThreads(() => thread("ytimesy"));
		expect(
			await mentionNoteFor("owner", "root", "ytimesy-12 alone", fake),
		).toBeNull();
		expect(fake.session).not.toHaveBeenCalled();
		expect(fake.thread).not.toHaveBeenCalled();
	});
});
