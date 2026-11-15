import type { ToolSet } from "ai";
import { expect, it } from "vitest";
import {
	withWorkspaceNote,
	workspaceReplacedNote,
} from "./workspace-replaced-note";

const execute = (...results: unknown[]) => {
	let call = 0;
	return async () => results[call++];
};
const run = (tools: ToolSet, name: string) =>
	(tools[name].execute as () => Promise<unknown>)();

it("tells the agent once, on the first result it can carry it", async () => {
	let pending: string | null = workspaceReplacedNote();
	const take = () => {
		const note = pending;
		pending = null;
		return note;
	};
	const tools = withWorkspaceNote(
		{
			list: { execute: execute(["a"], ["b"]) },
			read: { execute: execute({ text: "x" }, { text: "y" }) },
			shell: { execute: execute("out", "out2") },
		} as unknown as ToolSet,
		take,
	);
	// A list cannot carry it: the note waits.
	expect(await run(tools, "list")).toEqual(["a"]);
	expect(pending).not.toBeNull();
	// An object carries it, as its own field.
	const first = (await run(tools, "read")) as Record<string, unknown>;
	expect(first.workspaceNotice).toBe(workspaceReplacedNote());
	expect(first.text).toBe("x");
	expect(pending).toBeNull();
	// Never again, on any tool.
	expect(await run(tools, "read")).toEqual({ text: "y" });
	expect(await run(tools, "shell")).toBe("out");
});

it("puts it before a text result", async () => {
	let pending: string | null = "NOTE";
	const tools = withWorkspaceNote(
		{ shell: { execute: execute("hello") } } as unknown as ToolSet,
		() => {
			const note = pending;
			pending = null;
			return note;
		},
	);
	expect(await run(tools, "shell")).toBe("NOTE\n\nhello");
});

it("does nothing when no machine was replaced", async () => {
	const tools = withWorkspaceNote(
		{ shell: { execute: execute("hello") } } as unknown as ToolSet,
		() => null,
	);
	expect(await run(tools, "shell")).toBe("hello");
});

it("names what is missing and what to do", () => {
	const note = workspaceReplacedNote();
	for (const part of ["last pushed commit", "git status", "restart"])
		expect(note).toContain(part);
});
