import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { isUserRequestMessage } from "./api-conversation";
import {
	annotateMemoryText,
	appendMemoryEntry,
	attachedMemory,
	chatIdFromSource,
	EMPTY_MEMORY,
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

	it("selects at most five similar lines above the cutoff, never twice", () => {
		const files = {
			"MEMORY.md": "- Prefers short answers",
			"tooling.md": Array.from(
				{ length: 8 },
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
		]);
		expect(memoryMatchesPart(picked.slice(0, 1))).toContain(
			"tooling.md:2: - Rule 1",
		);
		const below = new Map(lines.map((entry) => [entry, 0.5]));
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
});
