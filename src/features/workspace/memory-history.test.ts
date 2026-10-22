import { describe, expect, it } from "vitest";
import { memoryHistoryChanges } from "./memory-history";

const CHAT = "0b6f6b5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

describe("memoryHistoryChanges", () => {
	it("shows plain text with source and date parsed out", () => {
		const patch = [
			"@@ -1,2 +1,3 @@",
			" # Tooling",
			" - Uses pnpm [added: 2026-10-01]",
			"+- Use httpx [project: acme/web; source: manual; added: 2026-10-21]",
			`+- Runs vitest [source: https://ytimesy.test/?chat=${CHAT}; added: 2026-10-15]`,
		].join("\n");
		expect(memoryHistoryChanges(patch)).toEqual([
			{
				change: "add",
				text: "Use httpx",
				manual: true,
				chatId: null,
				added: "2026-10-21",
			},
			{
				change: "add",
				text: "Runs vitest",
				manual: false,
				chatId: CHAT,
				added: "2026-10-15",
			},
		]);
	});

	it("reads a removed line as a delete and skips headings and file headers", () => {
		const patch = [
			"--- a",
			"+++ b",
			"-# Old heading",
			"+# New heading",
			"-- Uses npm [source: manual]",
		].join("\n");
		expect(memoryHistoryChanges(patch)).toEqual([
			{ change: "delete", text: "Uses npm", manual: true, chatId: null },
		]);
	});

	it("merges a line whose only change is its tags into one update", () => {
		const patch = [
			"-- Use npm [source: a; added: 2026-09-01]",
			`+- Use npm [source: a; added: 2026-09-01] [superseded-by: /?chat=${CHAT}]`,
		].join("\n");
		expect(memoryHistoryChanges(patch)).toEqual([
			{
				change: "update",
				text: "Use npm",
				manual: false,
				chatId: null,
				added: "2026-09-01",
			},
		]);
	});
});
