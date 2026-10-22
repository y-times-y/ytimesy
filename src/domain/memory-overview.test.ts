import { describe, expect, it } from "vitest";
import {
	memoryChangeSummary,
	memoryRows,
	memoryScopes,
	PERSONAL_SCOPE,
	recentMemoryRows,
	rowsByTopic,
	scopeRows,
	searchMemoryRows,
} from "./memory-overview";
import { memoryTokens } from "./memory-ranking";

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

describe("memory scopes", () => {
	const scoped = {
		"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]] package managers\n",
		"tooling.md":
			"# Tooling\n\n- Use pnpm [scope: always; added: 2026-10-02]\n- Runs vitest [project: Acme/Web; added: 2026-10-12]\n- Old note [project: acme/web; superseded-by: x]\n",
		"api.md":
			"# API\n\n- Errors are problem+json [project: acme/web; added: 2026-10-16]\n- Billing uses cents [project: billing; added: 2026-10-01]\n",
	};
	const rows = memoryRows(scoped, "2026-10-20");

	it("puts untagged lines in Personal and each project in its own scope, without case", () => {
		expect(memoryScopes(rows)).toEqual([
			{
				id: PERSONAL_SCOPE,
				project: null,
				count: 1,
				rules: 1,
				updated: "2026-10-02",
			},
			{
				id: "project:acme/web",
				project: "Acme/Web",
				count: 2,
				rules: 0,
				updated: "2026-10-16",
			},
			{
				id: "project:billing",
				project: "billing",
				count: 1,
				rules: 0,
				updated: "2026-10-01",
			},
		]);
		expect(memoryScopes([])).toEqual([
			{ id: PERSONAL_SCOPE, project: null, count: 0, rules: 0 },
		]);
	});

	it("lists a scope's lines without the index's topic links, grouped by topic with rules first", () => {
		expect(scopeRows(rows, PERSONAL_SCOPE).map((row) => row.text)).toEqual([
			"Use pnpm",
		]);
		expect(scopeRows(rows, "project:acme/web").map((row) => row.text)).toEqual([
			"Runs vitest",
			"Old note",
			"Errors are problem+json",
		]);
		const groups = rowsByTopic(scopeRows(rows, null), scoped);
		expect(groups.map((group) => group.title)).toEqual(["API", "Tooling"]);
		expect(groups[1].rows.map((row) => row.text)).toEqual([
			"Use pnpm",
			"Runs vitest",
			"Old note",
		]);
	});
});

describe("what a dream changed", () => {
	const before = {
		"api.md":
			"# API\n\n- Errors use problem+json bodies [added: 2026-10-01]\n- Errors are RFC 9457 problem+json [added: 2026-10-05]\n- Webhooks go to v1 [added: 2026-10-02]\n- Beta flag on [expires: 2026-10-10]\n- Old cursor note [superseded-by: /?chat=b]\n- Uses tabs [added: 2026-09-01]\n",
	};
	const after = {
		"api.md":
			"# API\n\n- Errors use RFC 9457 problem+json bodies [added: 2026-10-05]\n- Webhooks go to v1 [superseded-by: /?chat=c; added: 2026-10-02]\n- Timestamps are UTC [added: 2026-10-18]\n",
	};

	it("reads merges, retired lines, resolved conflicts, removals and additions", () => {
		expect(
			memoryChangeSummary(before, after, "2026-10-20", memoryTokens),
		).toEqual({
			added: ["Timestamps are UTC"],
			merged: [
				{
					into: "Errors use RFC 9457 problem+json bodies",
					from: [
						"Errors use problem+json bodies",
						"Errors are RFC 9457 problem+json",
					],
				},
			],
			expired: ["Beta flag on"],
			resolved: ["Webhooks go to v1", "Old cursor note"],
			removed: ["Uses tabs"],
		});
	});

	it("reports nothing when nothing changed", () => {
		expect(
			memoryChangeSummary(before, before, "2026-10-20", memoryTokens),
		).toEqual({
			added: [],
			merged: [],
			expired: [],
			resolved: [],
			removed: [],
		});
	});
});
