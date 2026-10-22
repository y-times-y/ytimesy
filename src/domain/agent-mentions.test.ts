import { describe, expect, it } from "vitest";
import {
	activeMention,
	insertMention,
	mentionAgents,
	mentionedHelperNames,
	mentionMatches,
	mentionNote,
	mentionSegments,
	withoutMentionNote,
} from "./agent-mentions";
import { isUserRequestMessage } from "./api-conversation";
import { helperIdentitiesOf } from "./helper-names";
import { SessionItemId } from "./ids";

const identities = helperIdentitiesOf([
	{
		id: "a",
		createdAt: "2026-10-21T10:00:00Z",
		kind: "writer",
		title: "Fix pricing rounding",
	},
	{
		id: "b",
		createdAt: "2026-10-21T10:01:00Z",
		kind: "researcher",
		title: "Find the export API",
	},
]);
const agents = mentionAgents(identities);

describe("@mentions in the composer", () => {
	it("lists Main first, then the helpers by short name with their task", () => {
		expect(agents.map((agent) => [agent.name, agent.task])).toEqual([
			["Main", undefined],
			["build-1", "Fix pricing rounding"],
			["research-1", "Find the export API"],
		]);
	});

	it("finds the @query at the caret, not inside a word or an address", () => {
		expect(activeMention("ask @bu", 7)).toEqual({ start: 4, query: "bu" });
		expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
		expect(activeMention("mail me@host", 12)).toBeNull();
		expect(activeMention("ask @build now", 7)).toBeNull();
	});

	it("filters by name prefix first, then by task", () => {
		expect(mentionMatches(agents, "re").map((agent) => agent.name)).toEqual([
			"research-1",
		]);
		expect(
			mentionMatches(agents, "pricing").map((agent) => agent.name),
		).toEqual(["build-1"]);
		expect(mentionMatches(agents, "")).toHaveLength(3);
	});

	it("replaces the query with the name and a space", () => {
		expect(insertMention("ask @bu", { start: 4 }, 7, "build-1")).toEqual({
			text: "ask @build-1 ",
			caret: 13,
		});
		expect(
			insertMention("ask @bu about it", { start: 4 }, 7, "build-1"),
		).toEqual({ text: "ask @build-1 about it", caret: 13 });
	});

	it("splits a sent message into text and known mentions", () => {
		expect(
			mentionSegments("is @build-1 done? cc @nobody, @Main", (name) =>
				["build-1", "main"].includes(name.toLowerCase()),
			),
		).toEqual([
			{ kind: "text", text: "is " },
			{ kind: "mention", name: "build-1" },
			{ kind: "text", text: " done? cc @nobody, " },
			{ kind: "mention", name: "Main" },
		]);
	});

	it("reads only helper names from a message, once each", () => {
		expect(
			mentionedHelperNames(
				"@build-1 and @Main, then @review-2 and @build-1; me@build-3",
			),
		).toEqual(["build-1", "review-2"]);
	});
});

describe("the lead's mention note", () => {
	const note = mentionNote([
		{
			name: "build-1",
			id: "1",
			role: "writer",
			state: "working",
			task: "Fix pricing rounding",
		},
	]);

	it("names each helper's agent id, role, state and task", () => {
		expect(note).toBe(
			`[@mentions in the user's message: @build-1 = agent 1 (writer, working, "Fix pricing rounding")]`,
		);
		expect(mentionNote([])).toBeNull();
	});

	it("leaves a queued request recognisable as the person's own", () => {
		const text = "check @build-1";
		expect(withoutMentionNote(`${text}\n\n${note}`)).toBe(text);
		expect(
			isUserRequestMessage(
				[{ kind: "userMessage", id: SessionItemId("u1"), text }],
				{ role: "user", content: `${text}\n\n${note}` },
			),
		).toBe(true);
	});
});
