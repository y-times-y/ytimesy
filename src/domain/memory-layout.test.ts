import { describe, expect, it } from "vitest";
import {
	byRecency,
	isThisProjectLine,
	keyMatchesProject,
	lineInScope,
	MEMORY_LAYOUT_MARKER,
	type MemoryProject,
	memoryFolderOf,
	memoryIndexFor,
	memoryLayoutChanges,
	memoryPathScope,
	memoryProjectKey,
	memoryProjectOf,
	needsMemoryLayout,
	personalSortPending,
	projectFolderListing,
	projectKeyFor,
	projectKeyId,
	projectSlug,
	staleMemoryLines,
	topicFileName,
} from "./memory-layout";
import {
	dreamReviewSection,
	memoryLines,
	withMemoryChanges,
} from "./memory-repo";

const WEB: MemoryProject = {
	fullName: "y-times-y/ytimesy",
	name: "ytimesy",
	repositoryIds: [101],
};
const API: MemoryProject = {
	fullName: "acme/api",
	name: null,
	repositoryIds: [202, 203],
};

describe("project keys", () => {
	it("names a folder by a readable slug and the repository id", () => {
		expect(projectSlug("y-times-y/ytimesy")).toBe("y-times-y-ytimesy");
		expect(projectSlug("Acme/Web.App")).toBe("acme-web-app");
		expect(projectSlug("///")).toBe("project");
		expect(memoryProjectKey(WEB)).toBe("y-times-y-ytimesy--101");
		expect(projectKeyId("y-times-y-ytimesy--101")).toBe(101);
		expect(projectKeyId("acme-web")).toBeNull();
		expect(
			memoryProjectOf({
				fullName: "acme/web",
				name: "Web",
				repositoryId: 5,
				repositories: [{ repositoryId: 5 }, { repositoryId: 6 }],
			}),
		).toEqual({ fullName: "acme/web", name: "Web", repositoryIds: [5, 6] });
	});

	it("matches a renamed repository by its id, and an id-less folder by its slug", () => {
		expect(keyMatchesProject("old-name--101", WEB)).toBe(true);
		expect(keyMatchesProject("acme-api--203", API)).toBe(true);
		expect(keyMatchesProject("y-times-y-ytimesy--999", WEB)).toBe(false);
		expect(keyMatchesProject("y-times-y-ytimesy", WEB)).toBe(true);
		const files = { "projects/old-name--101/deploy.md": "- x\n" };
		expect(projectKeyFor(files, WEB)).toBe("old-name--101");
		expect(projectKeyFor({}, WEB)).toBe("y-times-y-ytimesy--101");
	});

	it("reads a path's scope from its folder", () => {
		expect(memoryPathScope("MEMORY.md")).toEqual({ kind: "index" });
		expect(memoryPathScope("personal/style.md")).toEqual({ kind: "personal" });
		expect(memoryPathScope("projects/acme-api--202/x.md")).toEqual({
			kind: "project",
			key: "acme-api--202",
		});
		expect(memoryPathScope("projects/x.md")).toEqual({ kind: "legacy" });
		expect(memoryPathScope("tooling.md")).toEqual({ kind: "legacy" });
		expect(memoryFolderOf("projects/k--1/a.md")).toBe("projects/k--1");
		expect(memoryFolderOf("tooling.md")).toBeNull();
		expect(topicFileName("projects/k--1/deploy.md")).toBe("deploy.md");
		expect(topicFileName("a/b.md")).toBe("a-b.md");
	});
});

describe("what a chat may recall", () => {
	const lines = memoryLines({
		"personal/style.md": "- Prefers tabs\n",
		"projects/y-times-y-ytimesy--101/deploy.md": "- Deploys on Fly\n",
		"projects/acme-api--202/deploy.md": "- Deploys on Render\n",
		"tooling.md":
			"- Untagged legacy line\n- Tagged web line [project: y-times-y/ytimesy]\n- Tagged api line [project: acme/api]\n",
	});
	const visible = (project: MemoryProject | null) =>
		lines
			.filter((entry) => lineInScope(entry, project))
			.map((entry) => entry.text);

	it("shows a project's chat personal/, its own folder and its legacy tagged lines", () => {
		expect(visible(WEB)).toEqual([
			"Prefers tabs",
			"Deploys on Fly",
			"Untagged legacy line",
			"Tagged web line",
		]);
		expect(visible(API)).toEqual([
			"Prefers tabs",
			"Deploys on Render",
			"Untagged legacy line",
			"Tagged api line",
		]);
	});

	it("shows a chat without a project personal notes only", () => {
		expect(visible(null)).toEqual(["Prefers tabs", "Untagged legacy line"]);
	});

	it("tells the project's own lines from personal ones", () => {
		expect(
			lines
				.filter((entry) => isThisProjectLine(entry, WEB))
				.map((entry) => entry.text),
		).toEqual(["Deploys on Fly", "Tagged web line"]);
		expect(lines.filter((entry) => isThisProjectLine(entry, null))).toEqual([]);
	});

	it("ranks newest first, so a cap on ranked lines keeps the newest", () => {
		const dated = memoryLines({
			"personal/a.md":
				"- Old [added: 2026-01-01]\n- Undated\n- New [added: 2026-10-01]\n",
		});
		expect([...dated].sort(byRecency).map((entry) => entry.text)).toEqual([
			"New",
			"Old",
			"Undated",
		]);
	});
});

describe("MEMORY.md for one chat", () => {
	const index = [
		"# Memory",
		"",
		"- Het prefers short replies",
		"- Web deploys need a tag [project: y-times-y/ytimesy]",
		"- API is frozen [project: acme/api]",
		"",
		"## Index",
		"- [[personal/style]] how they write",
		"- [[projects/y-times-y-ytimesy--101/deploy]]",
		"- [[projects/acme-api--202/deploy]]",
		"- [[personal/tools]], [[projects/acme-api--202/tools]]",
		"",
	].join("\n");

	it("drops other projects' links and lines", () => {
		const web = memoryIndexFor(index, WEB).content;
		expect(web).toContain("Web deploys need a tag");
		expect(web).toContain("[[projects/y-times-y-ytimesy--101/deploy]]");
		expect(web).not.toContain("acme-api--202");
		expect(web).not.toContain("API is frozen");
		// A line linking two folders keeps only this chat's link.
		expect(web).toContain("- [[personal/tools]]\n");
		const none = memoryIndexFor(index, null);
		expect(none.content).not.toContain("projects/");
		expect(none.content).not.toContain("Web deploys");
		expect(none.content).toContain("- [[personal/style]] how they write");
		expect(none.lines).toBe(5);
	});

	it("is capped at a line boundary with a pointer to the rest", () => {
		const long = Array.from(
			{ length: 100 },
			(_, line) => `- Fact ${line} ${"x".repeat(30)}`,
		).join("\n");
		const capped = memoryIndexFor(long, null, 500);
		expect(capped.content.length).toBeLessThan(600);
		expect(capped.clipped).toBeGreaterThan(80);
		expect(capped.content.split("\n").at(-1)).toBe(
			`- … ${capped.clipped} more lines: \`cat ~/memory/MEMORY.md\``,
		);
	});
});

describe("moving a repo into the layout", () => {
	const legacy = {
		"MEMORY.md":
			"# Memory\n\n- Prefers short replies\n\n## Index\n- [[tooling]] package managers\n- [[deploy]]\n",
		"tooling.md": [
			"# Tooling",
			"",
			"Notes on how the user installs things.",
			"- Prefers pnpm everywhere [added: 2026-09-01]",
			"- ytimesy pins Node 22 [project: y-times-y/ytimesy; added: 2026-09-02]",
			"- The API uses Go modules [project: acme/api; added: 2026-09-03]",
			"",
		].join("\n"),
		"deploy.md":
			"# Deploy\n- Web deploys on Fly [project: Y-Times-Y/ytimesy]\n- Old app deploys by hand [project: gone/app]\n",
	};

	it("moves tagged lines to their project's folder and the rest to personal/, keeping every line", () => {
		const changes = memoryLayoutChanges(legacy, [WEB, API]);
		if (!changes) throw new Error("changes expected");
		const after = withMemoryChanges(legacy, changes);
		expect(after["tooling.md"]).toBeUndefined();
		expect(after["deploy.md"]).toBeUndefined();
		expect(after["personal/tooling.md"]).toBe(
			"# Tooling\n\nNotes on how the user installs things.\n- Prefers pnpm everywhere [added: 2026-09-01]\n",
		);
		expect(after["projects/y-times-y-ytimesy--101/tooling.md"]).toBe(
			"# Tooling\n\n- ytimesy pins Node 22 [project: y-times-y/ytimesy; added: 2026-09-02]\n",
		);
		expect(after["projects/acme-api--202/tooling.md"]).toContain(
			"- The API uses Go modules",
		);
		expect(after["projects/y-times-y-ytimesy--101/deploy.md"]).toContain(
			"- Web deploys on Fly",
		);
		// A project the user no longer has gets a slug folder; nothing is dropped.
		expect(after["projects/gone-app/deploy.md"]).toContain(
			"- Old app deploys by hand",
		);
		// A file with only project lines leaves no empty personal/ copy.
		expect(after["personal/deploy.md"]).toBeUndefined();
		const before = memoryLines(legacy)
			.filter((entry) => entry.path !== "MEMORY.md")
			.map((entry) => entry.raw);
		const moved = memoryLines(after)
			.filter((entry) => entry.path !== "MEMORY.md")
			.map((entry) => entry.raw);
		expect(before.every((raw) => moved.includes(raw))).toBe(true);
		expect(moved).toHaveLength(before.length);
		// The index follows: the old link points at every new file, its words kept.
		expect(after["MEMORY.md"]).toContain(
			"- [[personal/tooling]], [[projects/y-times-y-ytimesy--101/tooling]], [[projects/acme-api--202/tooling]] package managers",
		);
		expect(after["MEMORY.md"]).toContain("[[projects/gone-app/deploy]]");
		expect(after["MEMORY.md"]).toContain("- Prefers short replies");
		// Untagged lines went to personal/: the next dream sorts them.
		expect(after[MEMORY_LAYOUT_MARKER]).toBe("2\nsort-personal: pending\n");
		expect(personalSortPending(after)).toBe(true);
	});

	it("is idempotent: a second run changes nothing", () => {
		const changes = memoryLayoutChanges(legacy, [WEB, API]);
		if (!changes) throw new Error("changes expected");
		const after = withMemoryChanges(legacy, changes);
		expect(needsMemoryLayout(after)).toBe(false);
		expect(memoryLayoutChanges(after, [WEB, API])).toBeNull();
	});

	it("merges a mixed repo into files already in the layout without repeating lines", () => {
		const mixed = {
			[MEMORY_LAYOUT_MARKER]: "2\n",
			"MEMORY.md": "# Memory\n\n## Index\n- [[personal/tooling]]\n",
			"personal/tooling.md":
				"# Tooling\n- Prefers pnpm everywhere [added: 2026-09-01]\n",
			// Written at the root after the move (an agent's old habit).
			"tooling.md":
				"# Tooling\n- Prefers pnpm everywhere [added: 2026-09-01]\n- Likes dark mode\n- Web uses Vite [project: y-times-y/ytimesy]\n",
		};
		expect(needsMemoryLayout(mixed)).toBe(true);
		const changes = memoryLayoutChanges(mixed, [WEB]);
		if (!changes) throw new Error("changes expected");
		const after = withMemoryChanges(mixed, changes);
		expect(after["personal/tooling.md"]).toBe(
			"# Tooling\n- Prefers pnpm everywhere [added: 2026-09-01]\n- Likes dark mode\n",
		);
		expect(after["projects/y-times-y-ytimesy--101/tooling.md"]).toContain(
			"- Web uses Vite",
		);
		expect(after["tooling.md"]).toBeUndefined();
		expect(memoryLayoutChanges(after, [WEB])).toBeNull();
	});

	it("writes only the marker for a repo already laid out", () => {
		const laidOut = {
			"MEMORY.md": "# Memory\n\n## Index\n- [[personal/a]]\n",
			"personal/a.md": "- x\n",
		};
		expect(memoryLayoutChanges(laidOut, [])).toEqual([
			{ path: MEMORY_LAYOUT_MARKER, content: "2\n" },
		]);
	});

	it("tells the dream which folder is which project", () => {
		const files = {
			"projects/old-name--101/a.md": "- x\n",
			"projects/gone-app/a.md": "- y\n",
		};
		expect(projectFolderListing(files, [WEB, API])).toBe(
			[
				"- projects/acme-api--202/ = acme/api",
				"- projects/gone-app/ = (no longer a project)",
				"- projects/old-name--101/ = y-times-y/ytimesy",
			].join("\n"),
		);
	});
});

describe("the dream's review, folder by folder", () => {
	const files = {
		"MEMORY.md": "# Memory\n",
		"personal/style.md": "# style\n- Prefers tabs\n",
		"projects/a--1/x.md": `# x\n${"- a line about project a\n".repeat(20)}`,
		"projects/b--2/x.md": `# x\n${"- a line about project b\n".repeat(20)}`,
	};

	it("covers what fits, personal/ first, then projects in a weekly rotation", () => {
		const week0 = dreamReviewSection(files, { budget: 700, rotate: 0 }) ?? "";
		expect(week0).toContain("### personal/style.md");
		expect(week0).toContain("### projects/a--1/x.md");
		expect(week0).not.toContain("### projects/b--2/x.md");
		expect(week0).toContain("(next time: projects/b--2/)");
		const week1 = dreamReviewSection(files, { budget: 700, rotate: 1 }) ?? "";
		expect(week1).toContain("### projects/b--2/x.md");
		expect(week1).not.toContain("### projects/a--1/x.md");
		expect(dreamReviewSection({ "MEMORY.md": "# Memory\n" })).toBeNull();
	});

	it("lists lines no chat has used for a long time", () => {
		const section =
			dreamReviewSection(files, {
				stale: ["personal/style.md:2: Prefers tabs (never used)"],
			}) ?? "";
		expect(section).toContain("Lines no chat has used for a long time");
		expect(section).toContain("Prefers tabs (never used)");
	});
});

describe("lines no chat uses", () => {
	const files = {
		"personal/a.md": [
			"- Old and never used [added: 2026-01-01]",
			"- Old but used lately [added: 2026-01-01]",
			"- Used long ago [added: 2026-01-01]",
			"- New and unused yet [added: 2026-10-20]",
			"- Always on [scope: always; added: 2026-01-01]",
			"- Replaced [superseded-by: x; added: 2026-01-01]",
		].join("\n"),
	};
	const recalled = new Map([
		["old but used lately", "2026-10-25"],
		["used long ago", "2026-07-01"],
	]);

	it("are counted from when tracking began, never before it", () => {
		expect(
			staleMemoryLines({
				files,
				today: "2026-11-01",
				recalled,
				trackingSince: null,
			}),
		).toEqual([]);
		// Tracking began 10 days ago: too soon to call any line unused.
		expect(
			staleMemoryLines({
				files,
				today: "2026-11-01",
				recalled,
				trackingSince: "2026-10-22",
			}),
		).toEqual(["personal/a.md:3: Used long ago (last used 2026-07-01)"]);
		expect(
			staleMemoryLines({
				files,
				today: "2026-12-30",
				recalled,
				trackingSince: "2026-10-22",
			}),
		).toEqual([
			"personal/a.md:1: Old and never used (never used)",
			"personal/a.md:3: Used long ago (last used 2026-07-01)",
			"personal/a.md:4: New and unused yet (never used)",
		]);
	});
});
