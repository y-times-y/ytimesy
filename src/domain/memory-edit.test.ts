import { describe, expect, it } from "vitest";
import {
	addMemoryLine,
	applyMemoryEdit,
	deleteMemoryLine,
	findMemoryLine,
	memoryEntryText,
	memoryProjectValue,
	memoryTopicPath,
	updateMemoryLine,
} from "./memory-edit";
import { memoryLines, withMemoryChanges } from "./memory-repo";

const files = {
	"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]]\n",
	"tooling.md":
		"# Tooling\n\n- Use pnpm, never npm [scope: always; source: /?chat=a; added: 2026-10-02]\n- Uses Vitest [kind: inferred; project: acme/web; added: 2026-10-12]\n- Prefers early returns. kind: inferred. [added: 2026-10-14]\n",
};
const today = "2026-10-21";
const ref = (line: number, text: string) => ({
	path: "tooling.md",
	line,
	text,
});
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
		expect(memoryProjectValue(" acme/web ")).toBe("acme/web");
		expect(memoryProjectValue("a;b")).toBeNull();
		expect(memoryTopicPath("notes.md")).toBe("notes.md");
		expect(memoryTopicPath("MEMORY.md")).toBeNull();
		expect(memoryTopicPath("../x.md")).toBeNull();
		expect(memoryTopicPath("notes.txt")).toBeNull();
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
		});
		const added = memoryLines(applied(result)).at(-1);
		expect(added?.raw).toBe(
			"- Use httpx, not requests [source: manual; added: 2026-10-21]",
		);
		expect(added?.meta).toEqual({ source: "manual", added: today });
	});

	it("adds an always-on project rule to a new topic and links it from the index", () => {
		const result = addMemoryLine(files, {
			text: "Deploy only on Tuesdays",
			project: "acme/web",
			always: true,
			topic: "deploy.md",
			today,
		});
		expect(result).toMatchObject({
			ok: true,
			message: "Add always-on rule (project acme/web): Deploy only on Tuesdays",
		});
		const next = applied(result);
		expect(next["deploy.md"]).toBe(
			"# deploy\n- Deploy only on Tuesdays [scope: always; project: acme/web; source: manual; added: 2026-10-21]\n",
		);
		expect(next["MEMORY.md"]).toContain("- [[deploy]]");
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
		expect(findMemoryLine(files, ref(4, "Uses Vitest"))?.line).toBe(4);
		const shifted = { "tooling.md": `# Moved\n\n\n${files["tooling.md"]}` };
		expect(findMemoryLine(shifted, ref(4, "Uses Vitest"))?.line).toBe(7);
		expect(findMemoryLine(files, ref(4, "Gone"))).toBeNull();
	});

	it("edits text in place, keeping the line's metadata", () => {
		const result = updateMemoryLine(files, ref(4, "Uses Vitest"), {
			text: "Uses Vitest with jsdom",
		});
		expect(result).toMatchObject({
			ok: true,
			message: "Edit memory: Uses Vitest with jsdom",
		});
		if (!result.ok) return;
		expect(result.changes[0].content?.split("\n")[3]).toBe(
			"- Uses Vitest with jsdom [kind: inferred; project: acme/web; added: 2026-10-12]",
		);
	});

	it("moves a line between a project and Personal by its project key", () => {
		const personal = updateMemoryLine(files, ref(4, "Uses Vitest"), {
			project: null,
		});
		expect(personal).toMatchObject({
			ok: true,
			message: "Move memory to Personal: Uses Vitest",
		});
		if (!personal.ok) return;
		expect(personal.changes[0].content?.split("\n")[3]).toBe(
			"- Uses Vitest [kind: inferred; added: 2026-10-12]",
		);
		const project = updateMemoryLine(files, ref(3, "Use pnpm, never npm"), {
			project: "acme/api",
		});
		if (!project.ok) throw new Error(project.error);
		expect(project.message).toBe(
			"Move memory to project acme/api: Use pnpm, never npm",
		);
		expect(project.changes[0].content?.split("\n")[2]).toBe(
			"- Use pnpm, never npm [scope: always; source: /?chat=a; added: 2026-10-02; project: acme/api]",
		);
		// The same project in another case is no move.
		expect(
			updateMemoryLine(files, ref(4, "Uses Vitest"), { project: "ACME/web" }),
		).toEqual({ ok: false, error: "Nothing changed." });
	});

	it("pins and unpins an always-on rule, folding trailing key text into the metadata", () => {
		const pin = updateMemoryLine(files, ref(5, "Prefers early returns."), {
			always: true,
		});
		if (!pin.ok) throw new Error(pin.error);
		expect(pin.message).toBe("Pin as always-on rule: Prefers early returns.");
		expect(pin.changes[0].content?.split("\n")[4]).toBe(
			"- Prefers early returns. [added: 2026-10-14; kind: inferred; scope: always]",
		);
		const unpin = updateMemoryLine(files, ref(3, "Use pnpm, never npm"), {
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
				ref: ref(4, "Uses Vitest"),
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
	});

	it("deletes one line and leaves the rest of the file", () => {
		const result = deleteMemoryLine(files, ref(4, "Uses Vitest"));
		if (!result.ok) throw new Error(result.error);
		expect(result.message).toBe("Delete memory: Uses Vitest");
		const next = withMemoryChanges(files, result.changes);
		expect(memoryLines(next).map((entry) => entry.text)).toEqual([
			"[[tooling]]",
			"Use pnpm, never npm",
			"Prefers early returns.",
		]);
		expect(deleteMemoryLine(files, ref(4, "Not there"))).toEqual({
			ok: false,
			error: "Memory no longer has that line.",
		});
	});
});
