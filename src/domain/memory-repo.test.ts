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
	hasDurableCue,
	isNearDuplicate,
	isNewFileRequest,
	likelySupersededPairs,
	looksProjectSpecific,
	memoryEntryPart,
	memoryInstructions,
	memoryLineShown,
	memoryLines,
	memoryLinks,
	memoryMatchesPart,
	memoryPath,
	memoryQueryText,
	memoryRerankPool,
	memoryRulesPart,
	PROJECT_RULES_CHARS,
	PROJECT_RULES_LIMIT,
	parseMemoryLine,
	parseSaveHookAnswer,
	projectRules,
	projectRulesShown,
	renderDreamInbox,
	SAVE_HOOK_INSTRUCTIONS,
	saveHookPrompt,
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

	it("selects lines above the floor and near the best one, at most the limit, never twice", () => {
		const files = {
			"MEMORY.md": "- Prefers short answers",
			"tooling.md": Array.from(
				{ length: 12 },
				(_, index) => `- Rule ${index}`,
			).join("\n"),
		};
		const lines = memoryLines(files);
		const rule = (text: string) => Number(/Rule (\d+)/.exec(text)?.[1] ?? 99);
		const scores = new Map(
			lines.map((entry) => [entry, 0.9 - 0.045 * rule(entry.text)]),
		);
		const select = (limit?: number) =>
			selectMemoryMatches({
				lines,
				scores,
				alreadyShown: (raw) => raw === "- Rule 0",
				today: "2026-10-15",
				limit,
			}).map((entry) => entry.text);
		// Best shown line 0.855: lines down to 0.655 stay, the 0.63 tail does not.
		expect(select()).toEqual([
			"Rule 1",
			"Rule 2",
			"Rule 3",
			"Rule 4",
			"Rule 5",
		]);
		expect(select(4)).toEqual(["Rule 1", "Rule 2", "Rule 3", "Rule 4"]);
		expect(
			memoryMatchesPart(
				memoryLines(files).filter((entry) => entry.text === "Rule 1"),
			),
		).toContain("tooling.md:2: - Rule 1");
		const below = new Map(lines.map((entry) => [entry, 0.36]));
		expect(
			selectMemoryMatches({
				lines,
				scores: below,
				alreadyShown: () => false,
				today: "2026-10-15",
			}),
		).toEqual([]);
		// Only weak hits: no strong line to be near, so all of them above the floor stay.
		const weak = new Map(
			lines.map((entry) => [entry, rule(entry.text) < 3 ? 0.4 : 0.3]),
		);
		expect(
			selectMemoryMatches({
				lines,
				scores: weak,
				alreadyShown: () => false,
				today: "2026-10-15",
			}).map((entry) => entry.text),
		).toEqual(["Rule 0", "Rule 1", "Rule 2"]);
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
				'Sure: {"entries":[{"file":"tooling","text":"Uses pnpm, never npm","personal":""},{"file":"..","text":"bad"},{"file":"projects/acme--1/style.md","text":"Prefers tabs","personal":"how they write code everywhere"}]}',
			),
		).toEqual([
			{ file: "tooling.md", text: "Uses pnpm, never npm" },
			// A topic name only: any folder the model wrote is dropped.
			{
				file: "style.md",
				text: "Prefers tabs",
				personal: "how they write code everywhere",
			},
		]);
		expect(parseSaveHookAnswer("no json")).toEqual([]);
	});

	it("reads which shown line an entry replaces, and keeps brackets that are not metadata", () => {
		expect(
			parseSaveHookAnswer(
				'{"entries":[{"file":"tooling.md","text":"Use pnpm","replaces":"projects/acme--1/tooling.md:3"},{"file":"log.md","text":"Prefix logs with [orders]","replaces":"nonsense"},{"file":"x.md","text":"Ends in [key: value]"}]}',
			),
		).toEqual([
			{
				file: "tooling.md",
				text: "Use pnpm",
				replaces: { path: "projects/acme--1/tooling.md", line: 3 },
			},
			{ file: "log.md", text: "Prefix logs with [orders]" },
			{ file: "x.md", text: "Ends in key: value" },
		]);
		expect(
			parseSaveHookAnswer(
				'{"entries":[{"file":"y.md","text":"See [[other]]"}]}',
			),
		).toEqual([{ file: "y.md", text: "See other" }]);
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
			}).map((entry) => entry.text),
		).toEqual(["Use pnpm"]);
	});
});

describe("rules a request must follow without naming them", () => {
	const style = "projects/acme--1/style.md";
	const tooling = "projects/acme--1/tooling.md";
	const files = {
		"personal/editor.md":
			"- New Python files use tabs, everywhere [added: 2026-10-19]",
		[style]: [
			'- New source files start with the line "# Copyright (c) Acme Corp" [added: 2026-01-12]',
			'- License headers: replaced the copyright line with "# SPDX-License-Identifier: Apache-2.0" as the first line of new source files [added: 2026-05-30]',
			"- New JSON files use 4-space indentation [added: 2026-10-18]",
			"- Max line length is 100 [added: 2026-01-30]",
		].join("\n"),
		[tooling]: [
			"- CLI scripts live in scripts/ and use argparse [added: 2026-02-06]",
			"- Renamed scripts/ to tools/: new CLI scripts go in tools/ [added: 2026-10-18]",
			"- Run the linter before committing [scope: always; added: 2026-03-01]",
		].join("\n"),
		"projects/acme--1/api.md":
			"- Routes live under /api/v2 [added: 2026-03-06]",
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

	it("adds them without a similarity match, newest version only, for the project's lines alone", () => {
		// Nothing scores: only the always-applicable project rules ride along;
		// personal/'s new-file rule is recalled only by a match.
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
		// Within the limit, a convention line keeps the last slot.
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
			}).map((entry) => entry.text);
		expect(pick(0.5)).toHaveLength(6);
		expect(pick(0.5).at(-1)).toBe("New CLI scripts go in tools/");
		expect(pick(0.4)).toHaveLength(6);
		expect(pick(0.4)).not.toContain("New CLI scripts go in tools/");
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
			`${style}:1 -> ${style}:2`,
			`${tooling}:1 -> ${tooling}:2`,
		]);
		expect(dreamReviewSection(files)).toContain(`${style}:1 -> ${style}:2`);
	});

	it("keeps only the lines the reranker finds relevant, best reranked first, and the rules whatever it says", () => {
		const scores = new Map([
			[byText("Routes live"), 0.6],
			[byText("Max line length"), 0.55],
			[byText("Renamed scripts/"), 0.46],
		]);
		const match = {
			lines,
			scores,
			alreadyShown: () => false,
			today: "2026-10-18",
		};
		// The pool: the hybrid's picks and the convention line.
		const pool = memoryRerankPool(match);
		expect(pool.map((entry) => entry.text.slice(0, 20))).toEqual([
			"Routes live under /a",
			"Max line length is 1",
			"Renamed scripts/ to ",
		]);
		const rerank = (relevant: Record<string, number>) =>
			selectMemoryMatches({
				...match,
				query: "Fix the bug",
				rerank: new Map(
					pool.map((entry) => [
						entry,
						relevant[entry.text.slice(0, 20)] ?? 1e-5,
					]),
				),
			}).map((entry) => entry.text.slice(0, 20));
		expect(
			rerank({ "Routes live under /a": 0.01, "Max line length is 1": 0.4 }),
		).toEqual([
			"Max line length is 1",
			"Routes live under /a",
			"Run the linter befor",
		]);
		// The convention line passes the reranker too.
		expect(rerank({ "Renamed scripts/ to ": 0.2 })).toEqual([
			"Renamed scripts/ to ",
			"Run the linter befor",
		]);
		// Nothing relevant: nothing matched, however the hybrid scored it.
		expect(rerank({})).toEqual(["Run the linter befor"]);
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

describe("project rules", () => {
	const lines = memoryLines({
		"MEMORY.md": "# Memory\n\n- Never deploy on Fridays\n",
		"api.md": [
			"# api",
			"- Errors are JSON with a code field [scope: always; added: 2026-10-01]",
			"- The orders API returns 50 rows per page",
			"- Always run pnpm check before saying done [added: 2026-10-02]",
			"- New entity IDs use ULIDs [scope: always; added: 2026-10-03]",
			"- Switched new entity IDs from ULIDs to UUIDv7 [added: 2026-10-09]",
			"- Old webhook flags must stay [scope: always; expires: 2026-01-01]",
			"- Inferred: every file ends in a newline [scope: always; kind: inferred; added: 2026-10-10]",
		].join("\n"),
	});

	it("takes only scope: always rules, the user's first, swapped for their later change", () => {
		const rules = projectRules({ lines, today: "2026-10-15" });
		expect(rules.map((entry) => entry.text)).toEqual([
			"Switched new entity IDs from ULIDs to UUIDv7",
			"Errors are JSON with a code field",
			"Inferred: every file ends in a newline",
		]);
		// A standing do or don't without the key is recalled by match, not always on.
		expect(rules.map((entry) => entry.text)).not.toContain(
			"Always run pnpm check before saying done",
		);
	});

	it("leaves out personal/ lines: a misfiled one would ride on every project's chats", () => {
		const scoped = memoryLines({
			"personal/reporting.md":
				"- Customer summaries count rows, not quantities [scope: always; added: 2026-10-20]",
			"projects/acme--1/http.md":
				"- Every HTTP call goes through lib/http.ts [scope: always; added: 2026-10-01]",
		});
		expect(
			projectRules({ lines: scoped, today: "2026-10-21" }).map(
				(entry) => entry.path,
			),
		).toEqual(["projects/acme--1/http.md"]);
	});

	it("keeps the section to a few short lines", () => {
		const many = memoryLines({
			"rules.md": Array.from(
				{ length: 9 },
				(_, index) =>
					`- Rule ${index} ${"x".repeat(150)} [scope: always; added: 2026-10-0${index + 1}]`,
			).join("\n"),
		});
		const rules = projectRules({ lines: many, today: "2026-10-15" });
		expect(rules.length).toBeLessThanOrEqual(PROJECT_RULES_LIMIT);
		expect(
			rules.reduce((total, entry) => total + entry.text.length, 0),
		).toBeLessThanOrEqual(PROJECT_RULES_CHARS);
		expect(rules[0].text.startsWith("Rule 8")).toBe(true);
	});

	it("is recognised as shown, so the read hook does not repeat a rule", () => {
		const rules = projectRules({ lines, today: "2026-10-15" });
		const part = memoryRulesPart(rules);
		expect(projectRulesShown(part)).toBe(true);
		expect(projectRulesShown(memoryEntryPart("- x"))).toBe(false);
		const last = rules.at(-1);
		if (!last) throw new Error("rules expected");
		expect(memoryLineShown(last.raw, part)).toBe(true);
		expect(
			memoryLineShown("- The orders API returns 50 rows per page", part),
		).toBe(false);
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
				scope: "always",
			},
			{ file: "x.md", text: "Other" },
		]);
	});
});

describe("embedding text", () => {
	it("embeds one line as its topic and text, whatever its folder, and queries with Qwen3's instruction", async () => {
		const { memoryLineEmbeddingText, memoryEmbeddingQuery } = await import(
			"./memory-repo"
		);
		const [legacy, moved] = memoryLines({
			"web.md": "- Uses pnpm [source: x; added: 2026-10-15]",
			"projects/acme-web--12/web.md":
				"- Uses pnpm [source: x; added: 2026-10-15]",
		});
		expect(memoryLineEmbeddingText(legacy)).toBe("web: Uses pnpm");
		// A line the layout moved keeps its vector.
		expect(memoryLineEmbeddingText(moved)).toBe("web: Uses pnpm");
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

describe("keys written outside the metadata brackets", () => {
	const inside =
		"- Use pnpm, never npm [scope: always; kind: stated; source: /?chat=1; added: 2026-10-02]";
	const outside =
		"- Use pnpm, never npm. scope: always. kind: stated. [source: /?chat=1; added: 2026-10-02]";

	it("reads scope and kind from either place and drops the key text from the line", () => {
		for (const raw of [inside, outside]) {
			const entry = parseMemoryLine(raw);
			expect(entry?.meta).toMatchObject({
				scope: "always",
				kind: "stated",
				added: "2026-10-02",
			});
			expect(entry?.text).toMatch(/^Use pnpm, never npm\.?$/);
		}
		expect(
			parseMemoryLine("- Counts rows, not quantities. kind: inferred.")?.meta,
		).toEqual({ kind: "inferred" });
	});

	it("keeps ordinary prose that only looks like a key", () => {
		const entry = parseMemoryLine(
			"- The deploy scope: staging first [added: 2026-10-02]",
		);
		expect(entry?.text).toBe("The deploy scope: staging first");
		expect(entry?.meta.scope).toBeUndefined();
	});

	it("attaches an outside-bracket scope: always line as a project rule", () => {
		const rules = projectRules({
			lines: memoryLines({ "rules.md": `# Rules\n\n${outside}\n` }),
			today: "2026-10-20",
		});
		expect(rules.map((rule) => rule.text)).toEqual(["Use pnpm, never npm."]);
	});
});

describe("where saves go and when they run", () => {
	it("tells the agent the layout and to search only this chat's folders", () => {
		const project = memoryInstructions("full", {
			url: "https://app/?chat=1",
			project: "acme/web",
			folder: "projects/acme-web--7",
		});
		expect(project).toContain(
			"~/memory/personal/<topic>.md holds notes about the user for every project",
		);
		expect(project).toContain(
			"~/memory/projects/acme-web--7/<topic>.md holds this project's",
		);
		expect(project).toContain(
			"`grep -rn <term> ~/memory/personal ~/memory/projects/acme-web--7`",
		);
		expect(project).not.toContain("`project: <name>`");
		const none = memoryInstructions("full", {
			url: "https://app/?chat=1",
			project: null,
		});
		expect(none).toContain(
			"this chat has no project: ignore ~/memory/projects/",
		);
		expect(none).toContain("`grep -rn <term> ~/memory/personal`");
	});

	it("files what a project chat learns about its code or data under the project", () => {
		const project = memoryInstructions("full", {
			url: "https://app/?chat=1",
			project: "acme/web",
			folder: "projects/acme-web--7",
		});
		expect(project).toContain(
			"projects/acme-web--7/<topic>.md for anything learned here about this project's code, data or domain",
		);
		expect(project).toContain(
			"personal/<topic>.md only for something about the user themself",
		);
		expect(SAVE_HOOK_INSTRUCTIONS).toContain(
			"data, reports, customers or domain belongs to the project even when it sounds general",
		);
		// The two lines dev filed under personal/ (2026-11-02), and lines that belong there.
		for (const text of [
			"In customer summaries, `orders` counts input rows per customer, not item quantities; keep order counts distinct from quantity totals.",
			"Config lives in settings/app.yaml",
			"Never deploy on Fridays",
			"The orders table keys on customer_id",
		])
			expect([text, looksProjectSpecific(text)]).toEqual([text, true]);
		for (const text of [
			"Prefers short replies without preamble",
			"Writes commit messages in the imperative mood",
			"Works on a Mac with zsh",
			"Prefers small functions in every repo",
			"From the Notion page on startup strategy: talk to users every week",
		])
			expect([text, looksProjectSpecific(text)]).toEqual([text, false]);
	});

	it("tells the save hook the chat's folder, or personal entries only", () => {
		const base = { message: "m", memory: "", files: [] };
		expect(
			saveHookPrompt({
				...base,
				project: "acme/web",
				folder: "projects/acme-web--7",
			}),
		).toContain(
			'Project of this chat: acme/web (entries go to projects/acme-web--7/ unless "personal" is set)',
		);
		expect(saveHookPrompt({ ...base, project: null })).toContain(
			"Project of this chat: (none): save only personal entries, each with its reason",
		);
	});

	it("skips the save hook's model call for messages without a durable cue", () => {
		for (const text of [
			"From now on always use pnpm",
			"I prefer short replies",
			"No, don't add comments there",
			"We use Fly for deploys",
			"Remember the staging URL",
			"Our API is versioned by header",
			"Switched to Postgres 17 last week",
		])
			expect(hasDurableCue(text)).toBe(true);
		for (const text of [
			"run the tests again",
			"yes, do it",
			"fix the failing build in ci",
			"why does this fail?",
			"/compact now please",
			"ok thanks",
		])
			expect(hasDurableCue(text)).toBe(false);
	});

	it("calls an entry a copy only when it embeds close and keeps the same words", () => {
		expect(
			isNearDuplicate(
				0.95,
				"Uses pnpm for every install",
				"Uses pnpm for installs",
			),
		).toBe(true);
		expect(
			isNearDuplicate(0.95, "Use npm for installs", "Use pnpm for installs"),
		).toBe(false);
		expect(isNearDuplicate(0.85, "Prefers tabs", "Prefers tabs")).toBe(false);
	});
});
