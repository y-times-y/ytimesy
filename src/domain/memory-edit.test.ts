import { describe, expect, it } from "vitest";
import {
	addMemoryLine,
	applyMemoryEdit,
	deleteMemoryLine,
	findMemoryLine,
	memoryEntryText,
	memoryProjectValue,
	memoryTopicPath,
	resolveProjectKey,
	suggestMemoryTopic,
	updateMemoryLine,
} from "./memory-edit";
import { memoryLines, withMemoryChanges } from "./memory-repo";

const WEB = "projects/acme-web--7";
const files = {
	"MEMORY.md": `# Memory\n\n## Index\n- [[personal/tooling]]\n- [[${WEB}/tooling]]\n`,
	"personal/tooling.md":
		"# Tooling\n\n- Use pnpm, never npm [scope: always; source: /?chat=a; added: 2026-10-02]\n- Prefers early returns. kind: inferred. [added: 2026-10-14]\n",
	[`${WEB}/tooling.md`]:
		"# Tooling\n\n- Uses Vitest [kind: inferred; added: 2026-10-12]\n",
};
const today = "2026-10-21";
const ref = (path: string, line: number, text: string) => ({
	path,
	line,
	text,
});
const personal = (line: number, text: string) =>
	ref("personal/tooling.md", line, text);
const web = (line: number, text: string) =>
	ref(`${WEB}/tooling.md`, line, text);
const applied = (result: ReturnType<typeof addMemoryLine>) => {
	if (!result.ok) throw new Error(result.error);
	return withMemoryChanges(files, result.changes);
};

describe("memory edits", () => {
	it("reads typed text as one entry, refusing text that would read back as metadata", () => {
		expect(memoryEntryText("  - Use  httpx\nfor HTTP ")).toBe(
			"Use httpx for HTTP",
		);
		expect(memoryEntryText("")).toBeNull();
		expect(memoryEntryText("x".repeat(501))).toBeNull();
		expect(memoryEntryText("Ends like metadata [project: x]")).toBeNull();
		expect(memoryEntryText("Ends like a key. scope: always")).toBeNull();
		expect(memoryEntryText("See [[api]] for errors")).toBe(
			"See [[api]] for errors",
		);
		expect(memoryProjectValue(" acme-web--7 ")).toBe("acme-web--7");
		// An owner/name from an older view becomes its folder slug.
		expect(memoryProjectValue("Acme/Web")).toBe("acme-web");
		expect(memoryProjectValue("a;b")).toBeNull();
		expect(memoryTopicPath("notes.md")).toBe("notes.md");
		expect(memoryTopicPath("MEMORY.md")).toBeNull();
		expect(memoryTopicPath("../x.md")).toBeNull();
		expect(memoryTopicPath("notes.txt")).toBeNull();
	});

	it("resolves a project to its existing folder by repository id, then by slug", () => {
		expect(resolveProjectKey(files, "acme-web--7")).toBe("acme-web--7");
		// The repo was renamed: same id, new slug, same folder.
		expect(resolveProjectKey(files, "acme-site--7")).toBe("acme-web--7");
		expect(resolveProjectKey(files, "acme-web")).toBe("acme-web--7");
		expect(resolveProjectKey(files, "other--9")).toBe("other--9");
	});

	it("adds a Personal line stated by the user, dated today, to an existing topic", () => {
		const result = addMemoryLine(files, {
			text: "Use httpx, not requests",
			project: null,
			always: false,
			topic: "tooling.md",
			today,
		});
		expect(result).toMatchObject({
			ok: true,
			message: "Add memory (Personal): Use httpx, not requests",
			added: { path: "personal/tooling.md", line: 5 },
		});
		const added = memoryLines(applied(result)).find(
			(entry) => entry.text === "Use httpx, not requests",
		);
		expect(added?.raw).toBe(
			"- Use httpx, not requests [source: manual; added: 2026-10-21]",
		);
		expect(added?.path).toBe("personal/tooling.md");
	});

	it("adds an always-on project rule to a new topic in the project's folder and links it", () => {
		const result = addMemoryLine(files, {
			text: "Deploy only on Tuesdays",
			project: "acme-web--7",
			always: true,
			topic: "deploy.md",
			today,
		});
		expect(result).toMatchObject({
			ok: true,
			message: "Add always-on rule (project acme-web): Deploy only on Tuesdays",
		});
		const next = applied(result);
		expect(next[`${WEB}/deploy.md`]).toBe(
			"# deploy\n- Deploy only on Tuesdays [scope: always; source: manual; added: 2026-10-21]\n",
		);
		expect(next["MEMORY.md"]).toContain(`- [[${WEB}/deploy]]`);
	});

	it("files a new line under the folder's topic it shares the most words with, else notes", () => {
		const topics = {
			...files,
			"personal/api.md":
				"# API\n\n- Errors use problem+json [added: 2026-10-01]\n",
		};
		expect(suggestMemoryTopic(topics, "Run tests with Vitest in CI")).toBe(
			`${WEB}/tooling.md`,
		);
		expect(suggestMemoryTopic(topics, "Use pnpm in CI too", "personal")).toBe(
			"personal/tooling.md",
		);
		expect(
			suggestMemoryTopic(topics, "Likes dark roast coffee", "personal"),
		).toBe("personal/notes.md");
		const result = addMemoryLine(topics, {
			text: "API errors include a trace id",
			project: null,
			always: false,
			today,
		});
		expect(result).toMatchObject({
			ok: true,
			added: {
				path: "personal/api.md",
				line: 4,
				text: "API errors include a trace id",
			},
		});
		// A project's line goes to a topic in that project's folder, never personal/.
		const project = addMemoryLine(topics, {
			text: "API errors include a trace id",
			project: "acme-web--7",
			always: false,
			today,
		});
		expect(project).toMatchObject({
			ok: true,
			added: { path: `${WEB}/notes.md` },
		});
	});

	it("rejects text, projects and topics it cannot store", () => {
		const base = { project: null, always: false, today };
		expect(addMemoryLine(files, { ...base, text: " " })).toEqual({
			ok: false,
			error: "Write what should be remembered.",
		});
		expect(
			addMemoryLine(files, { ...base, text: "ok", project: "bad]name" }),
		).toMatchObject({ ok: false });
		expect(
			addMemoryLine(files, { ...base, text: "ok", topic: "MEMORY.md" }),
		).toMatchObject({ ok: false });
	});

	it("finds a line by number, or by its text after the file moved", () => {
		expect(findMemoryLine(files, web(3, "Uses Vitest"))?.line).toBe(3);
		const shifted = {
			[`${WEB}/tooling.md`]: `# Moved\n\n\n${files[`${WEB}/tooling.md`]}`,
		};
		expect(findMemoryLine(shifted, web(3, "Uses Vitest"))?.line).toBe(6);
		expect(findMemoryLine(files, web(3, "Gone"))).toBeNull();
	});

	it("edits text in place, keeping the line's metadata", () => {
		const result = updateMemoryLine(files, web(3, "Uses Vitest"), {
			text: "Uses Vitest with jsdom",
		});
		expect(result).toMatchObject({
			ok: true,
			message: "Edit memory: Uses Vitest with jsdom",
		});
		if (!result.ok) return;
		expect(result.changes[0].content?.split("\n")[2]).toBe(
			"- Uses Vitest with jsdom [kind: inferred; added: 2026-10-12]",
		);
	});

	it("moves a line between a project's folder and personal/, to the same topic", () => {
		const toPersonal = updateMemoryLine(files, web(3, "Uses Vitest"), {
			project: null,
		});
		if (!toPersonal.ok) throw new Error(toPersonal.error);
		expect(toPersonal.message).toBe("Move memory to Personal: Uses Vitest");
		const next = withMemoryChanges(files, toPersonal.changes);
		expect(next[`${WEB}/tooling.md`]).toBe("# Tooling\n\n");
		expect(next["personal/tooling.md"]).toContain(
			"- Uses Vitest [kind: inferred; added: 2026-10-12]\n",
		);
		const toProject = updateMemoryLine(
			files,
			personal(3, "Use pnpm, never npm"),
			{ project: "acme-api--8" },
		);
		if (!toProject.ok) throw new Error(toProject.error);
		expect(toProject.message).toBe(
			"Move memory to project acme-api: Use pnpm, never npm",
		);
		const moved = withMemoryChanges(files, toProject.changes);
		expect(moved["projects/acme-api--8/tooling.md"]).toBe(
			"# tooling\n- Use pnpm, never npm [scope: always; source: /?chat=a; added: 2026-10-02]\n",
		);
		expect(moved["MEMORY.md"]).toContain("- [[projects/acme-api--8/tooling]]");
		// Its own folder, or the same repository under a new name, is no move.
		expect(
			updateMemoryLine(files, web(3, "Uses Vitest"), {
				project: "acme-site--7",
			}),
		).toEqual({ ok: false, error: "Nothing changed." });
	});

	it("moves a legacy tagged line into the layout, dropping its project key", () => {
		const legacy = {
			"tooling.md":
				"# Tooling\n\n- Uses Go [project: acme/api; added: 2026-10-01]\n",
		};
		expect(
			updateMemoryLine(legacy, ref("tooling.md", 3, "Uses Go"), {
				project: "acme-api--8",
			}),
		).toEqual({ ok: false, error: "Nothing changed." });
		const result = updateMemoryLine(legacy, ref("tooling.md", 3, "Uses Go"), {
			project: null,
		});
		if (!result.ok) throw new Error(result.error);
		const next = withMemoryChanges(legacy, result.changes);
		expect(next["personal/tooling.md"]).toContain(
			"- Uses Go [added: 2026-10-01]\n",
		);
	});

	it("pins and unpins an always-on rule, folding trailing key text into the metadata", () => {
		const pin = updateMemoryLine(files, personal(4, "Prefers early returns."), {
			always: true,
		});
		if (!pin.ok) throw new Error(pin.error);
		expect(pin.message).toBe("Pin as always-on rule: Prefers early returns.");
		expect(pin.changes[0].content?.split("\n")[3]).toBe(
			"- Prefers early returns. [added: 2026-10-14; kind: inferred; scope: always]",
		);
		const unpin = updateMemoryLine(files, personal(3, "Use pnpm, never npm"), {
			always: false,
		});
		if (!unpin.ok) throw new Error(unpin.error);
		expect(unpin.changes[0].content?.split("\n")[2]).toBe(
			"- Use pnpm, never npm [source: /?chat=a; added: 2026-10-02]",
		);
	});

	it("combines several changes to one line into one edit", () => {
		const result = applyMemoryEdit(
			files,
			{
				op: "update",
				ref: web(3, "Uses Vitest"),
				text: "Uses Vitest 3",
				project: null,
				always: true,
			},
			today,
		);
		expect(result).toMatchObject({
			ok: true,
			message:
				"Edit memory; Move memory to Personal; Pin as always-on rule: Uses Vitest 3",
		});
		if (!result.ok) return;
		expect(
			withMemoryChanges(files, result.changes)["personal/tooling.md"],
		).toContain(
			"- Uses Vitest 3 [kind: inferred; added: 2026-10-12; scope: always]",
		);
	});

	it("deletes one line and leaves the rest of the file", () => {
		const result = deleteMemoryLine(files, personal(3, "Use pnpm, never npm"));
		if (!result.ok) throw new Error(result.error);
		expect(result.message).toBe("Delete memory: Use pnpm, never npm");
		const next = withMemoryChanges(files, result.changes);
		expect(
			memoryLines(next)
				.filter((entry) => entry.path === "personal/tooling.md")
				.map((entry) => entry.text),
		).toEqual(["Prefers early returns."]);
		expect(deleteMemoryLine(files, web(3, "Not there"))).toEqual({
			ok: false,
			error: "Memory no longer has that line.",
		});
	});
});
