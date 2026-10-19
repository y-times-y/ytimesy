import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { isUserRequestMessage } from "./api-conversation";
import {
	alwaysApplies,
	annotateMemoryText,
	appendMemoryEntry,
	attachedMemory,
	chatIdFromSource,
	dreamReviewSection,
	droppedDetails,
	EMPTY_MEMORY,
	isNewFileRequest,
	likelySupersededPairs,
	memoryEntryPart,
	memoryLines,
	memoryLinks,
	memoryMatchesPart,
	memoryPath,
	memoryQueryText,
	parseMemoryLine,
	parseSaveHookAnswer,
	renderDreamInbox,
	selectMemoryMatches,
	supersedesLine,
	withMemoryParts,
	withoutExpired,
} from "./memory-repo";
import type { SessionItem } from "./session-item";

describe("memory entries", () => {
	it("parses one bullet with the spec's metadata and open keys", () => {
		const entry = parseMemoryLine(
			"- Payments and website share a launch deadline [source: https://app/?chat=1; added: 2026-09-03] [kind: inferred]",
			"projects.md",
			4,
		);
		expect(entry).toMatchObject({
			path: "projects.md",
			line: 4,
			text: "Payments and website share a launch deadline",
			meta: {
				source: "https://app/?chat=1",
				added: "2026-09-03",
				kind: "inferred",
			},
		});
		expect(parseMemoryLine("# Heading")).toBeNull();
		// Brackets that are not key/value metadata stay in the text.
		expect(parseMemoryLine("- Run [[tests]] first")?.text).toBe(
			"Run [[tests]] first",
		);
	});

	it("hides expired entries and flags entries whose paths are gone", () => {
		const text = [
			"- Freeze deploys until the audit [expires: 2026-01-01]",
			"- Config lives in app.config.ts [paths: app.config.ts]",
			"- Uses pnpm",
		].join("\n");
		expect(
			annotateMemoryText(text, {
				today: "2026-10-15",
				missingPaths: new Set(["app.config.ts"]),
			}),
		).toBe(
			"- Config lives in app.config.ts [paths: app.config.ts] (possibly stale: app.config.ts not found in this project)\n- Uses pnpm",
		);
		expect(
			withoutExpired({ "a.md": text, "b.md": "- kept" }, "2026-10-15"),
		).toEqual([
			{
				path: "a.md",
				content:
					"- Config lives in app.config.ts [paths: app.config.ts]\n- Uses pnpm",
			},
		]);
	});

	it("adds a topic file and links it from the index", () => {
		expect(
			appendMemoryEntry(
				{ "MEMORY.md": EMPTY_MEMORY },
				"tooling.md",
				"- Uses pnpm",
			),
		).toEqual([
			{ path: "tooling.md", content: "# tooling\n- Uses pnpm\n" },
			{ path: "MEMORY.md", content: "# Memory\n\n## Index\n- [[tooling]]\n" },
		]);
	});

	it("resolves links and refuses paths outside the repo", () => {
		expect(memoryLinks("see [[projects/payments]] and [[q.sql]]")).toEqual([
			"projects/payments.md",
			"q.sql",
		]);
		expect(memoryPath("~/memory/people/priya.md")).toBe("people/priya.md");
		expect(memoryPath("../etc/passwd")).toBeNull();
		expect(memoryPath(".git/config")).toBeNull();
		expect(
			chatIdFromSource(
				"https://ytimesy.com/?chat=1B4E28BA-2FA1-11D2-883F-0016D3CCA427",
			),
		).toBe("1b4e28ba-2fa1-11d2-883f-0016d3cca427");
	});
});

describe("memory on the request", () => {
	const items = [
		{ kind: "userMessage", id: "u1", text: "Add a date picker" },
	] as unknown as SessionItem[];

	it("appends parts to the same user message and keeps it a user request", () => {
		const message = { role: "user", content: "Add a date picker" } as const;
		const next = withMemoryParts(message, [memoryEntryPart("- Uses pnpm")]);
		expect(next.content).toEqual([
			{ type: "text", text: "Add a date picker" },
			{ type: "text", text: expect.stringContaining("- Uses pnpm") },
		]);
		expect(isUserRequestMessage(items, next as ModelMessage)).toBe(true);
		expect(attachedMemory([next])).toHaveLength(1);
		expect(withMemoryParts(message, [])).toBe(message);
	});

	it("skips short and command-like messages, as Supermemory's hook does", () => {
		expect(memoryQueryText("ok thanks")).toBeNull();
		expect(memoryQueryText("/compact the chat now")).toBeNull();
		expect(memoryQueryText("!ls -la in the root")).toBeNull();
		expect(memoryQueryText("install a date library")).toBe(
			"install a date library",
		);
	});

	it("selects at most eight lines above the cutoff, never twice", () => {
		const files = {
			"MEMORY.md": "- Prefers short answers",
			"tooling.md": Array.from(
				{ length: 12 },
				(_, index) => `- Rule ${index}`,
			).join("\n"),
			"other.md": "- Uses Go modules [project: acme/api]",
		};
		const lines = memoryLines(files);
		const scores = new Map(
			lines.map((entry, index) => [entry, 0.9 - index * 0.04]),
		);
		const picked = selectMemoryMatches({
			lines,
			scores,
			alreadyShown: (raw) => raw === "- Rule 0",
			today: "2026-10-15",
			project: "acme/web",
		});
		expect(picked.map((entry) => entry.text)).toEqual([
			"Rule 1",
			"Rule 2",
			"Rule 3",
			"Rule 4",
			"Rule 5",
			"Rule 6",
			"Rule 7",
			"Rule 8",
		]);
		expect(memoryMatchesPart(picked.slice(0, 1))).toContain(
			"tooling.md:2: - Rule 1",
		);
		const below = new Map(lines.map((entry) => [entry, 0.3]));
		expect(
			selectMemoryMatches({
				lines,
				scores: below,
				alreadyShown: () => false,
				today: "2026-10-15",
				project: null,
			}),
		).toEqual([]);
	});
});

describe("dream inbox and save hook", () => {
	it("keeps the newest chats within the budget", () => {
		const chat = (title: string) => ({
			url: `https://app/?chat=${title}`,
			title,
			updatedAt: "2026-10-15",
			userMessages: ["x".repeat(900)],
			agentReplies: [],
			failedCommands: [],
		});
		const inbox = renderDreamInbox([chat("new"), chat("old")], 1000);
		expect(inbox).toContain("Chat: new");
		expect(inbox).not.toContain("Chat: old");
	});

	it("parses bounded entries and drops anything unsafe", () => {
		expect(
			parseSaveHookAnswer(
				'Sure: {"entries":[{"file":"tooling","text":"Uses pnpm, never npm","project":""},{"file":"../x.md","text":"bad"}]}',
			),
		).toEqual([
			{ file: "tooling.md", text: "Uses pnpm, never npm", project: "" },
		]);
		expect(parseSaveHookAnswer("no json")).toEqual([]);
	});

	it("reads which shown line an entry replaces, and keeps brackets that are not metadata", () => {
		expect(
			parseSaveHookAnswer(
				'{"entries":[{"file":"tooling.md","text":"Use pnpm","project":"","replaces":"tooling.md:3"},{"file":"log.md","text":"Prefix logs with [orders]","replaces":"nonsense"},{"file":"x.md","text":"Ends in [key: value]"}]}',
			),
		).toEqual([
			{
				file: "tooling.md",
				text: "Use pnpm",
				project: "",
				replaces: { path: "tooling.md", line: 3 },
			},
			{ file: "log.md", text: "Prefix logs with [orders]", project: "" },
			{ file: "x.md", text: "Ends in key: value", project: "" },
		]);
		expect(
			parseSaveHookAnswer(
				'{"entries":[{"file":"y.md","text":"See [[other]]"}]}',
			),
		).toEqual([{ file: "y.md", text: "See other", project: "" }]);
	});
});

describe("superseded entries", () => {
	const text = [
		"- Use npm [source: a] [superseded-by: https://app/?chat=2]",
		"- Use pnpm [source: https://app/?chat=2]",
	].join("\n");

	it("are hidden like expired ones and removed by a dream's cleanup", () => {
		expect(annotateMemoryText(text, { today: "2026-10-15" })).toBe(
			"- Use pnpm [source: https://app/?chat=2]",
		);
		expect(withoutExpired({ "t.md": text }, "2026-10-15")).toEqual([
			{ path: "t.md", content: "- Use pnpm [source: https://app/?chat=2]" },
		]);
		const lines = memoryLines({ "t.md": text });
		expect(lines[0].meta["superseded-by"]).toBe("https://app/?chat=2");
		expect(
			selectMemoryMatches({
				lines,
				scores: new Map(lines.map((entry) => [entry, 0.9])),
				alreadyShown: () => false,
				today: "2026-10-15",
				project: null,
			}).map((entry) => entry.text),
		).toEqual(["Use pnpm"]);
	});
});

describe("rules a request must follow without naming them", () => {
	const files = {
		"style.md": [
			'- New source files start with the line "# Copyright (c) Acme Corp" [added: 2026-01-12]',
			'- License headers: replaced the copyright line with "# SPDX-License-Identifier: Apache-2.0" as the first line of new source files [added: 2026-05-30]',
			"- New JSON files use 4-space indentation [added: 2026-10-18]",
			"- Max line length is 100 [added: 2026-01-30]",
		].join("\n"),
		"tooling.md": [
			"- CLI scripts live in scripts/ and use argparse [added: 2026-02-06]",
			"- Renamed scripts/ to tools/: new CLI scripts go in tools/ [added: 2026-10-18]",
			"- Run the linter before committing [scope: always; added: 2026-03-01]",
		].join("\n"),
		"api.md": "- Routes live under /api/v2 [added: 2026-03-06]",
	};
	const lines = memoryLines(files);
	const byText = (part: string) =>
		lines.find((entry) => entry.text.includes(part)) as (typeof lines)[number];
	const select = (query: string, scores: Map<(typeof lines)[number], number>) =>
		selectMemoryMatches({
			lines,
			scores,
			alreadyShown: () => false,
			today: "2026-10-18",
			project: null,
			query,
		}).map((entry) => entry.text.slice(0, 20));

	it("tells a new file from an edit", () => {
		expect(isNewFileRequest("Add util/slug.py with slugify(text)")).toBe(true);
		expect(isNewFileRequest("Add a command-line script that prints 3")).toBe(
			true,
		);
		expect(isNewFileRequest("Add GET /users/<id> to routes.py")).toBe(false);
		expect(isNewFileRequest("Add event_to_json(event) in events.py")).toBe(
			false,
		);
		expect(
			alwaysApplies(byText("New JSON"), "Add config/limits.json with x"),
		).toBe(true);
		expect(alwaysApplies(byText("New JSON"), "Add util/text.py with x")).toBe(
			false,
		);
		expect(alwaysApplies(byText("Run the linter"), "Fix the bug")).toBe(true);
	});

	it("adds them without a similarity match, newest version only", () => {
		// Nothing scores: only the always-applicable rules ride along.
		expect(select("Add util/slug.py with slugify(text)", new Map())).toEqual([
			"License headers: rep",
			"Run the linter befor",
		]);
		expect(select("Fix the flaky test in orders", new Map())).toEqual([
			"Run the linter befor",
		]);
	});

	it("keeps one convention line just below the cut, and swaps an old decision for its change", () => {
		const scores = new Map([
			[byText("Routes live"), 0.6],
			[byText("CLI scripts live"), 0.5],
			[byText("Renamed scripts/"), 0.46],
		]);
		// The old scripts/ rule is shown as the line that changed it, once.
		expect(select("Fix the bug", scores)).toEqual([
			"Routes live under /a",
			"Renamed scripts/ to ",
			"Run the linter befor",
		]);
		// Past the top eight, a convention line still gets one extra slot.
		const crowded = memoryLines({
			"misc.md": Array.from(
				{ length: 8 },
				(_, index) => `- Rule ${index} [added: 2026-01-0${index + 1}]`,
			).join("\n"),
			"tooling.md": "- New CLI scripts go in tools/\n- Old CLI scripts stay\n",
		});
		const crowdedScores = (convention: number) =>
			new Map(
				crowded.map((entry) => [
					entry,
					entry.text.startsWith("Rule") ? 0.7 : convention,
				]),
			);
		const pick = (convention: number) =>
			selectMemoryMatches({
				lines: crowded,
				scores: crowdedScores(convention),
				alreadyShown: () => false,
				today: "2026-10-18",
				project: null,
			}).map((entry) => entry.text);
		expect(pick(0.5)).toHaveLength(9);
		expect(pick(0.5)).toContain("New CLI scripts go in tools/");
		expect(pick(0.4)).toHaveLength(8);
		expect(
			supersedesLine(byText("Renamed scripts/"), byText("CLI scripts live")),
		).toBe(true);
		expect(
			supersedesLine(byText("License headers"), byText("New source files")),
		).toBe(true);
		expect(
			supersedesLine(byText("New source files"), byText("License headers")),
		).toBe(false);
		expect(likelySupersededPairs(files)).toEqual([
			"style.md:1 -> style.md:2",
			"tooling.md:1 -> tooling.md:2",
		]);
		expect(dreamReviewSection(files)).toContain("style.md:1 -> style.md:2");
	});

	it("never retires an exception that names the rule it narrows", () => {
		const tooling = memoryLines({
			"tooling.md": [
				"- Switched the repo from npm to pnpm; use pnpm for installs [added: 2026-05-12]",
				"- pnpm everywhere, except legacy/, which still uses npm [added: 2026-07-02]",
			].join("\n"),
		});
		expect(supersedesLine(tooling[1], tooling[0])).toBe(false);
	});
});

describe("a replacement that loses details", () => {
	it("keeps the old shape when only one part of it changed", () => {
		const shape =
			'API errors now return {"error": {"code": "<snake_case_code>", "message": "<text>"}} with the HTTP status';
		expect(
			droppedDetails(
				shape,
				'API error codes must be UPPER_SNAKE_CASE from now on (e.g. "ITEMS_REQUIRED")',
				"Make POST /orders return 400 without items. Error codes are UPPER_SNAKE_CASE from now on, like ITEMS_REQUIRED.",
			),
		).toEqual([
			'{"error": {"code": "<snake_case_code>", "message": "<text>"}}',
		]);
		// The whole shape restated, or a user who asked to drop it: nothing lost.
		expect(
			droppedDetails(
				shape,
				'API errors return {"error": {"code": "<UPPER_SNAKE_CODE>", "message": "<text>"}}',
				"codes are upper case now",
			),
		).toEqual([]);
		expect(
			droppedDetails(
				shape,
				"API errors are plain strings",
				"Drop the error envelope; return plain strings instead",
			),
		).toEqual([]);
		expect(
			droppedDetails("Use npm for installs", "Use pnpm", "pnpm now"),
		).toEqual([]);
	});

	it("reads the always scope from the save hook's answer", () => {
		expect(
			parseSaveHookAnswer(
				'{"entries":[{"file":"style.md","text":"Every new file starts with an SPDX line","scope":"always"},{"file":"x.md","text":"Other","scope":"sometimes"}]}',
			),
		).toEqual([
			{
				file: "style.md",
				text: "Every new file starts with an SPDX line",
				project: "",
				scope: "always",
			},
			{ file: "x.md", text: "Other", project: "" },
		]);
	});
});

describe("embedding text", () => {
	it("embeds one line as its file and text, and queries with Qwen3's instruction", async () => {
		const { memoryLineEmbeddingText, memoryEmbeddingQuery } = await import(
			"./memory-repo"
		);
		const [entry] = memoryLines({
			"projects/web.md": "- Uses pnpm [source: x; added: 2026-10-15]",
		});
		expect(memoryLineEmbeddingText(entry)).toBe("projects/web: Uses pnpm");
		expect(memoryEmbeddingQuery("install a date library")).toBe(
			"Instruct: Given a user's request to a coding agent, retrieve relevant memories\nQuery: install a date library",
		);
		const long = `${"a".repeat(3000)}${"z".repeat(900)}`;
		const query = memoryQueryText(long) ?? "";
		expect(query.length).toBeLessThan(2100);
		expect(query.startsWith("aaa")).toBe(true);
		expect(query.endsWith("zzz")).toBe(true);
	});
});
