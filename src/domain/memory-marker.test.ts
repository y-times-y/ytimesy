import { describe, expect, it } from "vitest";
import { apiConversation, isUserRequestMessage } from "./api-conversation";
import { SessionItemId } from "./ids";
import {
	memoryHoldsLine,
	recalledMemoryLine,
	savedMemoryLines,
	withMemoryRecall,
	withoutMemoryLine,
	withSavedMemory,
} from "./memory-marker";
import { memoryMatchesPart, parseMemoryLine } from "./memory-repo";
import type { SessionItem } from "./session-item";
import { groupTimelineRows } from "./timeline-activity";

const CHAT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const source = (chat: string) => `https://ytimesy.test/?chat=${chat}`;
const user = (id: string, text = id): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text,
});
const reply = (id: string): SessionItem => ({
	kind: "agentMessage",
	id: SessionItemId(id),
	text: "Done.",
});

describe("recalled lines", () => {
	it("keeps the text without metadata, the file and the source chat", () => {
		const entry = parseMemoryLine(
			`- Uses pnpm, never npm [source: ${source(OTHER)}; added: 2026-10-12; project: acme/web]`,
			"tooling.md",
			2,
		);
		if (!entry) throw new Error("bullet expected");
		expect(recalledMemoryLine(entry, new Map([[OTHER, "Monorepo"]]))).toEqual({
			path: "tooling.md",
			text: "Uses pnpm, never npm",
			source: { chatId: OTHER, title: "Monorepo", date: "2026-10-12" },
		});
		expect(
			recalledMemoryLine({ path: "a.md", text: "No source", meta: {} }),
		).toEqual({ path: "a.md", text: "No source" });
	});

	it("is recorded once on the current request; a resumed step keeps the first record", () => {
		const items = [user("a"), reply("t:a"), user("b")];
		const first = withMemoryRecall(items, { head: "h1", lines: [] });
		expect(first[2]).toMatchObject({ memory: { head: "h1" } });
		expect(first[0]).toBe(items[0]);
		const again = withMemoryRecall(first, { head: "h2", lines: [] });
		expect(again[2]).toMatchObject({ memory: { head: "h1" } });
	});

	it("never changes what the model is sent for the stored history", () => {
		const items = [user("a", "install a date library")];
		const recorded = withMemoryRecall(items, {
			head: "h1",
			index: true,
			lines: [{ path: "tooling.md", text: "Uses pnpm" }],
		});
		expect(JSON.stringify(apiConversation(recorded))).toBe(
			JSON.stringify(apiConversation(items)),
		);
		// The request with its memory part still counts as the person's message.
		const part = memoryMatchesPart([
			{
				path: "tooling.md",
				line: 2,
				raw: "- Uses pnpm",
				text: "Uses pnpm",
				meta: {},
			},
		]);
		expect(
			isUserRequestMessage(recorded, {
				role: "user",
				content: [
					{ type: "text", text: "install a date library" },
					{ type: "text", text: part },
				],
			}),
		).toBe(true);
	});
});

describe("saved lines", () => {
	const before = {
		"tooling.md": `# tooling\n- Uses pnpm [source: ${source(OTHER)}]\n`,
	};

	it("are the entries citing this chat that were not in memory before", () => {
		const after = {
			"tooling.md": `# tooling\n- Uses pnpm [source: ${source(OTHER)}]\n- Runs vitest [source: ${source(CHAT)}; added: 2026-10-15]\n`,
			"db.md": `# db\n- Prefers Postgres [source: ${source(OTHER)}]\n- Uses pnpm [source: ${source(CHAT)}]\n`,
			"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]]\n- [[db]]\n",
		};
		expect(savedMemoryLines(before, after, CHAT)).toEqual([
			{ path: "tooling.md", text: "Runs vitest" },
		]);
		expect(savedMemoryLines(before, before, CHAT)).toEqual([]);
	});

	it("merge into the turn's marker, or close the turn with a new one", () => {
		const items = [user("a"), reply("t:a"), user("b"), reply("u:b")];
		const first = withSavedMemory(items, "a", "t:memory-saved", [
			{ path: "tooling.md", text: "Runs vitest" },
		]);
		expect(first.map((item) => item.id)).toEqual([
			"a",
			"t:a",
			"t:memory-saved",
			"b",
			"u:b",
		]);
		const merged = withSavedMemory(first, "a", "a:memory-saved", [
			{ path: "tooling.md", text: "Runs vitest" },
			{ path: "db.md", text: "Prefers Postgres" },
		]);
		expect(merged).toHaveLength(5);
		expect(merged[2]).toEqual({
			kind: "memorySave",
			id: "t:memory-saved",
			lines: [
				{ path: "tooling.md", text: "Runs vitest" },
				{ path: "db.md", text: "Prefers Postgres" },
			],
		});
		expect(
			withSavedMemory(items, "missing", "x", [{ path: "a.md", text: "x" }]),
		).toEqual(items);
	});

	it("stay in view under the turn's answer once the turn completes", () => {
		const items = [
			user("a"),
			{
				kind: "dynamicToolCall",
				id: SessionItemId("t:1"),
				tool: "exec_command",
				status: "completed",
			} satisfies SessionItem,
			reply("t:a"),
			{
				kind: "memorySave",
				id: SessionItemId("t:memory-saved"),
				lines: [{ path: "tooling.md", text: "Runs vitest" }],
			} satisfies SessionItem,
		];
		const rows = groupTimelineRows(items, "completed");
		expect(
			rows.map((row) => (row.kind === "item" ? row.item.id : row.kind)),
		).toEqual(["a", "work", "t:a", "t:memory-saved"]);
	});
});

describe("undo", () => {
	const files = {
		"tooling.md": `# tooling\n- Uses pnpm [source: x]\n- Runs  vitest [source: ${source(CHAT)}]\n`,
	};

	it("removes the entry by its text, keeping the rest of the file", () => {
		const line = { path: "tooling.md", text: "Runs vitest" };
		expect(memoryHoldsLine(files, line)).toBe(true);
		expect(withoutMemoryLine(files, line)).toEqual({
			path: "tooling.md",
			content: "# tooling\n- Uses pnpm [source: x]\n",
		});
	});

	it("does nothing when memory no longer holds it", () => {
		const gone = { path: "tooling.md", text: "Uses yarn" };
		expect(memoryHoldsLine(files, gone)).toBe(false);
		expect(withoutMemoryLine(files, gone)).toBeNull();
		expect(
			withoutMemoryLine(files, { path: "missing.md", text: "Uses pnpm" }),
		).toBeNull();
	});
});
