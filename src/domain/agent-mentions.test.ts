import { describe, expect, it } from "vitest";
import {
	activeMention,
	agentNameInCode,
	agentNameSegments,
	insertMention,
	MAIN_MENTION_ID,
	mentionAgents,
	mentionedAgentNames,
	mentionedThreads,
	mentionMatches,
	mentionNote,
	mentionSegments,
	threadMentionAgents,
	withoutMentionNote,
} from "./agent-mentions";
import { parseSteering, steeringTexts } from "./agent-steering";
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
// A helper's composer: Main and the other helpers.
const agents = mentionAgents(identities, "none");

describe("@mentions in the composer", () => {
	it("never lists the agent whose composer it is", () => {
		expect(
			mentionAgents(identities, MAIN_MENTION_ID).map((agent) => agent.name),
		).toEqual(["build-1", "research-1"]);
		expect(mentionAgents(new Map(), MAIN_MENTION_ID)).toEqual([]);
		expect(mentionAgents(identities, "a").map((agent) => agent.name)).toEqual([
			"Main",
			"research-1",
		]);
	});

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

	it("reads agent names from a message, once each", () => {
		expect(
			mentionedAgentNames(
				"@build-1 and @Main, then @review-2 and @build-1; me@build-3 @bob",
			),
		).toEqual(["build-1", "main", "review-2"]);
	});
});

describe("the lead's mention note", () => {
	const note = mentionNote([
		{
			name: "build-1",
			is: 'agent 1 (writer, working, "Fix pricing rounding")',
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

	it("rides on a helper's steering for the model only", () => {
		const { text, runtimeText } = steeringTexts({
			sender: { kind: "user" },
			message: "ask @Main",
			messageId: "m1",
			context: note ?? "",
		});
		expect(text).not.toContain("@mentions");
		expect(runtimeText).toContain(note);
		expect(parseSteering(runtimeText)?.text).toBe("ask @Main");
	});
});

describe("agent names in replies", () => {
	const names = new Set(["build-1", "research-1", "Main"]);
	it("finds exact whole names, with or without @", () => {
		expect(
			agentNameSegments("build-1 and @research-1, then Main.", names),
		).toEqual([
			{ kind: "mention", name: "build-1" },
			{ kind: "text", text: " and " },
			{ kind: "mention", name: "research-1" },
			{ kind: "text", text: ", then " },
			{ kind: "mention", name: "Main" },
			{ kind: "text", text: "." },
		]);
	});
	it("skips longer names, paths, URLs, addresses and other case", () => {
		for (const text of [
			"build-10",
			"rebuild-1",
			"docs/build-1.md",
			"x.dev/build-1",
			"me@build-1",
			"build-1.ts",
			"the main branch",
		])
			expect(agentNameSegments(text, names), text).toEqual([
				{ kind: "text", text },
			]);
	});
	it("reads inline code that is exactly a name", () => {
		expect(agentNameInCode("build-1", names)).toBe("build-1");
		expect(agentNameInCode("@research-1", names)).toBe("research-1");
		expect(agentNameInCode("build-1 --fix", names)).toBeNull();
	});
});

it("folds a quoted task echoed after an agent's name into its chip", () => {
	const names = new Set(["review-2"]);
	expect(
		agentNameSegments(
			"review-2 (“Audit chat lifecycle”) found two issues.",
			names,
		),
	).toEqual([
		{ kind: "mention", name: "review-2" },
		{ kind: "text", text: " found two issues." },
	]);
	expect(agentNameSegments('Ask review-2 ("Audit") again', names)).toEqual([
		{ kind: "text", text: "Ask " },
		{ kind: "mention", name: "review-2" },
		{ kind: "text", text: " again" },
	]);
	// A parenthesis that is not a quoted task stays.
	expect(agentNameSegments("review-2 (done)", names)).toEqual([
		{ kind: "mention", name: "review-2" },
		{ kind: "text", text: " (done)" },
	]);
});

describe("threads in the @ popover", () => {
	const threads = [
		{ id: "t1", name: "ytimesy-12", title: "Fix login redirect" },
		{ id: "t2", name: "ytimesy-13", title: "Speed up search" },
		{ id: "self", name: "ytimesy-14", title: "This chat" },
	];

	it("offers the project's threads by name and title, never the open one", () => {
		const offered = threadMentionAgents(threads, "self");
		expect(offered.map((agent) => agent.name)).toEqual([
			"ytimesy-12",
			"ytimesy-13",
		]);
		expect(offered[0]).toMatchObject({
			id: "t1",
			threadId: "t1",
			task: "Fix login redirect",
		});
	});

	it("finds a thread by its number or a word of its title, agents first", () => {
		const list = [
			...mentionAgents(identities, MAIN_MENTION_ID),
			...threadMentionAgents(threads),
		];
		expect(mentionMatches(list, "ytimesy-1").map((a) => a.name)).toEqual([
			"ytimesy-12",
			"ytimesy-13",
			"ytimesy-14",
		]);
		expect(mentionMatches(list, "login").map((a) => a.name)).toEqual([
			"ytimesy-12",
		]);
		const typed = activeMention("see @ytimesy-1", 14);
		expect(typed?.query).toBe("ytimesy-1");
		expect(
			insertMention("see @ytimesy-1", { start: 4 }, 14, "ytimesy-12").text,
		).toBe("see @ytimesy-12 ");
	});

	it("reads the threads a message names, once each, in order", () => {
		expect(
			mentionedThreads(
				"a @ytimesy-12, (@web-app-3) @YTIMESY-12 x@ytimesy-5 @ytimesy-0",
			),
		).toEqual([
			{ name: "ytimesy-12", slug: "ytimesy", number: 12 },
			{ name: "web-app-3", slug: "web-app", number: 3 },
		]);
	});
});
