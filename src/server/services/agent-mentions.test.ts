import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	type MentionDeps,
	mentionNoteFor,
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
