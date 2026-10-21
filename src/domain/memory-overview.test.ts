import { describe, expect, it } from "vitest";
import {
	memoryRows,
	memoryTopics,
	RULES_TOPIC,
	recentMemoryRows,
	searchMemoryRows,
	topicRows,
} from "./memory-overview";

const CHAT = "22222222-2222-4222-8222-222222222222";
const files = {
	"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]] package managers\n",
	"tooling.md": `# Tooling\n\n- Use pnpm, never npm [scope: always; source: /?chat=${CHAT}; added: 2026-10-02]\n- Uses Vitest for tests [kind: inferred; added: 2026-10-12]\n- Use npm for installs [superseded-by: /?chat=${CHAT}; added: 2026-09-01]\n`,
	"api.md":
		"# API\n\n- Errors are problem+json [added: 2026-10-16; project: billing]\n",
	"notes.md": "- Undated note\n",
};
const today = "2026-10-20";

describe("memory overview", () => {
	const rows = memoryRows(files, today);

	it("reads each entry's rule, replaced, kind, source and date", () => {
		const [rule, inferred, replaced] = rows.filter(
			(row) => row.path === "tooling.md",
		);
		expect(rule).toMatchObject({
			text: "Use pnpm, never npm",
			rule: true,
			replaced: false,
			kind: "stated",
			chatId: CHAT,
			added: "2026-10-02",
		});
		expect(inferred).toMatchObject({ kind: "inferred", rule: false });
		expect(replaced).toMatchObject({ replaced: true });
	});

	it("pins the project rules first, then topics by newest entry, the index last", () => {
		expect(
			memoryTopics(files, today).map((topic) => [
				topic.id,
				topic.title,
				topic.count,
				topic.updated,
			]),
		).toEqual([
			[RULES_TOPIC, "Project rules", 1, "2026-10-02"],
			["api.md", "API", 1, "2026-10-16"],
			["tooling.md", "Tooling", 2, "2026-10-12"],
			["notes.md", "notes", 1, undefined],
			["MEMORY.md", "Index", 1, undefined],
		]);
	});

	it("lists a topic's rows, the rules topic across files", () => {
		expect(topicRows(rows, RULES_TOPIC).map((row) => row.text)).toEqual([
			"Use pnpm, never npm",
		]);
		expect(topicRows(rows, "tooling.md")).toHaveLength(3);
	});

	it("feeds the newest dated entries in use, newest first", () => {
		expect(recentMemoryRows(rows).map((row) => row.added)).toEqual([
			"2026-10-16",
			"2026-10-12",
			"2026-10-02",
		]);
	});

	it("searches every word across text, topic and project", () => {
		expect(searchMemoryRows(rows, "pnpm NEVER").map((row) => row.path)).toEqual(
			["tooling.md"],
		);
		expect(searchMemoryRows(rows, "billing")).toHaveLength(1);
		expect(searchMemoryRows(rows, "  ")).toEqual([]);
	});
});

it("names a topic file titled like the pinned rules by its file name", () => {
	const topics = memoryTopics(
		{
			"project-rules.md":
				"# Project rules\n\n- Use pnpm [scope: always; added: 2026-10-02]\n",
		},
		"2026-10-20",
	);
	expect(topics.map((topic) => topic.title)).toEqual([
		"Project rules",
		"project-rules",
	]);
});
