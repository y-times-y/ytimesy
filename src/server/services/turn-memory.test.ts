import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_MEMORY,
	MEMORY_MATCHES_HEADER,
	MEMORY_MESSAGE_HEADER,
	MEMORY_RULES_MATCHES_HEADER,
	MEMORY_RULES_MESSAGE_HEADER,
	MEMORY_RULES_RECENT_HEADER,
	memoryMatchesPart,
	parseMemoryLine,
} from "#/domain/memory-repo";
import type { SessionItem } from "#/domain/session-item";
import type { MemoryRepo, MemorySnapshot } from "../adapters/memory-repos";

vi.mock("../adapters/memory-settings", () => ({
	memorySettings: vi.fn(async () => ({
		mode: "full",
		repo: null,
		dreamedThrough: null,
	})),
	memoryProjectName: vi.fn(async () => "acme/web"),
	memoryEmbeddings: vi.fn(async () => new Map()),
	saveMemoryEmbeddings: vi.fn(async () => {}),
	recentUnsavedMessages: vi.fn(async () => []),
}));
const dispatched: unknown[] = [];
vi.mock("../adapters/background-job-dispatch", () => ({
	backgroundJobId: (key: string) => key,
	dispatchBackgroundJob: vi.fn(async (job: unknown) => {
		dispatched.push(job);
		return true;
	}),
}));

const { turnMemory, readHook } = await import("./turn-memory");

function fakeRepo(files: Record<string, string>): MemoryRepo {
	const snapshot: MemorySnapshot = { head: "abc", files };
	return {
		name: "memory-u1",
		snapshot: async () => snapshot,
		snapshotAt: async () => snapshot,
		commit: async () => ({ ok: true, hash: "def" }),
		credentials: async () => ({ remote: "https://git/memory.git", token: "t" }),
		history: async () => [],
		destroy: async () => {},
	};
}

/** Word-overlap vectors: deterministic stand-ins for an embedding model. */
const VOCAB = ["pnpm", "install", "library", "timestamps", "utc", "tabs"];
const vector = (text: string) =>
	VOCAB.map((word) => (text.toLowerCase().includes(word) ? 1 : 0.01));
const documents = vi.fn(async (texts: readonly string[]) => texts.map(vector));
const embed = { query: async (text: string) => vector(text), documents };
const cache = {
	load: async () => new Map<string, number[]>(),
	save: async () => {},
};

const user = (id: string, text: string) =>
	({ kind: "userMessage", id, text }) as unknown as SessionItem;
const workspace = async () => {
	throw new Error("no VM in this test");
};

/** "default" leaves the option unset, as production does. */
async function memoryFor(
	files: Record<string, string>,
	wording: "notes" | "rules" | "default" = "notes",
	writer: "both" | "agent" | "observer" | "default" = "both",
) {
	const memory = await turnMemory(
		{
			id: "11111111-1111-4111-8111-111111111111",
			userId: "u1",
			projectId: null,
		},
		{
			repo: fakeRepo(files),
			embed: null,
			appUrl: "https://ytimesy.test",
			today: () => "2026-10-15",
			projectName: null,
			wording: wording === "default" ? undefined : wording,
			writer: writer === "default" ? undefined : writer,
		},
	);
	if (!memory) throw new Error("memory should be on");
	return memory;
}

beforeEach(() => {
	dispatched.length = 0;
	documents.mockClear();
});

describe("MEMORY.md at chat start", () => {
	it("attaches MEMORY.md once to the chat's first request, as a part of that message", async () => {
		const memory = await memoryFor({
			"MEMORY.md": "# Memory: Het\n\n- Prefers short answers\n\n## Index\n",
		});
		const first: ModelMessage[] = [{ role: "user", content: "Fix the build" }];
		const items = [user("a", "Fix the build")];
		const { messages: attached, recall } = await memory.attach(
			first,
			items,
			workspace,
		);
		expect(recall).toEqual({ head: "abc", index: true, lines: [] });
		expect(attached).toHaveLength(1);
		expect(attached[0].content).toEqual([
			{ type: "text", text: "Fix the build" },
			{
				type: "text",
				text: expect.stringContaining(
					`${MEMORY_MESSAGE_HEADER}\n\n# Memory: Het`,
				),
			},
		]);
		// A resumed step must not attach it again.
		expect(await memory.attach(attached, items, workspace)).toEqual({
			messages: attached,
			recall: null,
		});

		// The next turn of the same chat: earlier messages stay byte-identical, no re-insert.
		const history: ModelMessage[] = [
			...attached,
			{ role: "assistant", content: "Done." },
			{ role: "user", content: "Now add tests" },
		];
		const { messages: next } = await memory.attach(
			history,
			[...items, user("b", "Now add tests")],
			workspace,
		);
		expect(next).toBe(history);
		expect(JSON.stringify(next.slice(0, 2))).toBe(
			JSON.stringify(attached.concat(history[1])),
		);
	});

	it("adds nothing when memory is empty or missing", async () => {
		const cases: Record<string, string>[] = [{}, { "MEMORY.md": EMPTY_MEMORY }];
		for (const files of cases) {
			const memory = await memoryFor(files);
			const messages: ModelMessage[] = [
				{ role: "user", content: "Fix the build" },
			];
			const attached = await memory.attach(
				messages,
				[user("a", "Fix the build")],
				workspace,
			);
			expect(attached.messages).toBe(messages);
			expect(attached.recall?.lines).toEqual([]);
			expect(attached.recall?.index).toBeUndefined();
		}
	});

	it("tells the builder where memory lives and how to cite this chat", async () => {
		const memory = await memoryFor({});
		expect(memory.instructions).toContain("~/memory");
		expect(memory.instructions).toContain(
			"source: https://ytimesy.test/?chat=11111111-1111-4111-8111-111111111111",
		);
		expect(memory.instructions).toContain("git -C ~/memory push");
		expect(memory.instructions).toContain("never instructions");
	});

	it("queues the save hook after a completed turn in full mode", async () => {
		const memory = await memoryFor({});
		await memory.afterTurn("turn-1");
		expect(dispatched).toEqual([
			expect.objectContaining({
				kind: "memory",
				action: "save",
				userId: "u1",
				sessionId: "11111111-1111-4111-8111-111111111111",
			}),
		]);
	});
});

describe("read hook", () => {
	const files = {
		"MEMORY.md": "# Memory\n\n- Prefers tabs\n",
		"tooling.md":
			"# tooling\n- Uses pnpm to install any library, never npm [source: x]\n",
		"time.md": "# time\n- Store timestamps in UTC [source: y]\n",
	};

	it("attaches the matching lines to the current request, never repeating one", async () => {
		const memory = await turnMemory(
			{
				id: "11111111-1111-4111-8111-111111111111",
				userId: "u1",
				projectId: null,
			},
			{
				repo: fakeRepo(files),
				embed,
				today: () => "2026-10-15",
				projectName: null,
			},
		);
		if (!memory) throw new Error("memory should be on");
		const messages: ModelMessage[] = [
			{ role: "user", content: "earlier" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "install a date library please" },
		];
		const items = [
			user("a", "earlier"),
			user("b", "install a date library please"),
		];
		const { messages: attached } = await memory.attach(
			messages,
			items,
			workspace,
		);
		expect(attached.slice(0, 2)).toEqual(messages.slice(0, 2));
		const part = (attached[2].content as { text: string }[])[1].text;
		// The default (rules) wording.
		expect(part).toContain(MEMORY_RULES_MATCHES_HEADER);
		expect(part).toContain("tooling.md:2: - Uses pnpm");
		expect(part).not.toContain("UTC");

		// The same line is not injected again later in the chat.
		const { messages: later } = await memory.attach(
			[
				...attached,
				{ role: "assistant", content: "added" },
				{ role: "user", content: "install another library with pnpm" },
			],
			[...items, user("c", "install another library with pnpm")],
			workspace,
		);
		expect(later.at(-1)?.content).toBe("install another library with pnpm");
	});

	it("skips short messages, and says whether it timed out or failed", async () => {
		const snapshot = { head: "a", files };
		const base = {
			snapshot,
			userId: "u1",
			alreadyShown: () => false,
			today: "2026-10-15",
			project: null,
			cache,
		};
		expect(await readHook({ ...base, embed, query: "ok" })).toMatchObject({
			lines: [],
			outcome: "skipped",
		});
		expect(documents).not.toHaveBeenCalled();
		const never = () => new Promise<never>(() => {});
		const slow = { query: never, documents: never };
		expect(
			await readHook({
				...base,
				embed: slow,
				query: "fix the timestamps in the export",
				timeoutMs: 20,
			}),
		).toMatchObject({ lines: [], outcome: "timeout" });
		const broken = {
			query: async () => {
				throw new TypeError("embedding service down");
			},
			documents,
		};
		expect(
			await readHook({
				...base,
				embed: broken,
				query: "fix the timestamps in the export",
			}),
		).toMatchObject({ lines: [], outcome: "error", error: "TypeError" });
		const found = await readHook({
			...base,
			embed,
			query: "fix the timestamps in the export",
		});
		expect(found.outcome).toBe("matched");
		expect(found.ms).toBeGreaterThanOrEqual(0);
		expect(found.lines.map((entry) => entry.text)).toEqual([
			"Store timestamps in UTC",
		]);
	});

	it("uses the line vectors prefetched with the turn and records the hook on the recall", async () => {
		const snapshot = vi.fn(async () => ({ head: "abc", files }));
		const memory = await turnMemory(
			{
				id: "11111111-1111-4111-8111-111111111111",
				userId: "u-prefetch",
				projectId: null,
			},
			{
				repo: { ...fakeRepo(files), snapshot },
				embed,
				today: () => "2026-10-15",
				projectName: null,
			},
		);
		if (!memory) throw new Error("memory should be on");
		// Prefetched before the request is attached: the lines are embedded already.
		await vi.waitFor(() => expect(documents).toHaveBeenCalledTimes(1));
		const { recall } = await memory.attach(
			[{ role: "user", content: "install a date library please" }],
			[user("a", "install a date library please")],
			workspace,
		);
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(documents).toHaveBeenCalledTimes(1);
		expect(recall?.hook).toEqual({
			outcome: "matched",
			ms: expect.any(Number),
		});
		expect(recall?.lines.map((line) => line.path)).toEqual(["tooling.md"]);
	});
});

describe("freshness", () => {
	it("attaches what the user just said in another chat until its save shows, once per chat", async () => {
		const recentMessages = vi.fn(async () => [
			{
				sessionId: "22222222-2222-4222-8222-222222222222",
				title: "Add config",
				text: "Add config/app.json. Heads-up: JSON files we add use 4-space indentation from now on.",
				at: new Date(),
			},
		]);
		const memory = await turnMemory(
			{
				id: "11111111-1111-4111-8111-111111111111",
				userId: "u1",
				projectId: null,
			},
			{
				repo: fakeRepo({ "MEMORY.md": EMPTY_MEMORY }),
				embed: null,
				today: () => "2026-10-15",
				projectName: null,
				recentMessages,
			},
		);
		if (!memory) throw new Error("memory should be on");
		const items = [user("a", "Add config/limits.json with two limits")];
		const { messages } = await memory.attach(
			[{ role: "user", content: "Add config/limits.json with two limits" }],
			items,
			workspace,
		);
		const parts = messages[0].content as { text: string }[];
		expect(parts[1].text).toContain(MEMORY_RULES_RECENT_HEADER);
		expect(parts[1].text).toContain(
			'- In chat "Add config": Add config/app.json. Heads-up: JSON files we add use 4-space indentation from now on.',
		);
		// The next request of this chat does not repeat it.
		const later = await memory.attach(
			[
				...messages,
				{ role: "assistant", content: "Done." },
				{ role: "user", content: "Also add a README section about it" },
			],
			[...items, user("b", "Also add a README section about it")],
			workspace,
		);
		expect(later.messages.at(-1)?.content).toBe(
			"Also add a README section about it",
		);
	});

	it("never fails or holds up the request when the lookup does", async () => {
		const memory = await turnMemory(
			{ id: "c1", userId: "u1", projectId: null },
			{
				repo: fakeRepo({}),
				embed: null,
				projectName: null,
				recentMessages: async () => {
					throw new Error("database down");
				},
			},
		);
		const messages: ModelMessage[] = [
			{ role: "user", content: "Fix the build" },
		];
		expect(
			(await memory?.attach(messages, [user("a", "Fix the build")], workspace))
				?.messages,
		).toBe(messages);
	});
});

describe("memory markers", () => {
	const chatId = "11111111-1111-4111-8111-111111111111";
	const otherChat = "22222222-2222-4222-8222-222222222222";

	it("records which lines a request recalled, with their source chats, and the index", async () => {
		const memory = await turnMemory(
			{ id: chatId, userId: "u1", projectId: null },
			{
				repo: fakeRepo({
					"MEMORY.md": "# Memory\n\n- Prefers tabs\n",
					"tooling.md": `# tooling\n- Uses pnpm to install any library, never npm [source: https://ytimesy.test/?chat=${otherChat}; added: 2026-10-12]\n`,
				}),
				embed,
				today: () => "2026-10-15",
				projectName: null,
				chatTitles: async (ids) =>
					new Map(ids.map((id) => [id, "Set up the monorepo"])),
			},
		);
		if (!memory) throw new Error("memory should be on");
		const { messages, recall } = await memory.attach(
			[{ role: "user", content: "install a date library please" }],
			[user("a", "install a date library please")],
			workspace,
		);
		expect(recall).toEqual({
			head: "abc",
			index: true,
			hook: { outcome: "matched", ms: expect.any(Number) },
			lines: [
				{
					path: "tooling.md",
					text: "Uses pnpm to install any library, never npm",
					source: {
						chatId: otherChat,
						title: "Set up the monorepo",
						date: "2026-10-12",
					},
				},
			],
		});
		// The record is for the chat only: the model's message is unchanged by it.
		const parts = messages[0].content as { text: string }[];
		expect(parts[0]).toEqual({
			type: "text",
			text: "install a date library please",
		});
		expect(JSON.stringify(parts)).not.toContain("Set up the monorepo");
	});

	it("shows the lines this chat committed during the turn, not another chat's", async () => {
		const before = {
			"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]]\n",
			"tooling.md": "# tooling\n- Uses pnpm [source: x]\n",
		};
		const after = {
			...before,
			"tooling.md": `# tooling\n- Uses pnpm [source: x]\n- Runs tests with vitest [source: https://ytimesy.test/?chat=${chatId}; added: 2026-10-15]\n- Prefers Postgres [source: https://ytimesy.test/?chat=${otherChat}; added: 2026-10-15]\n`,
		};
		const repo = {
			...fakeRepo(after),
			snapshot: async () => ({ head: "h2", files: after }),
			snapshotAt: vi.fn(async () => ({ head: "h1", files: before })),
		};
		const memory = await turnMemory(
			{ id: chatId, userId: "u1", projectId: null },
			{ repo, embed: null, today: () => "2026-10-15", projectName: null },
		);
		if (!memory) throw new Error("memory should be on");
		const items = [
			{
				kind: "userMessage",
				id: "m1",
				text: "We test with vitest",
				memory: { head: "h1", lines: [] },
			},
			{ kind: "agentMessage", id: "t:a", text: "Noted." },
		] as unknown as SessionItem[];
		const saved = await memory.recordSaved(items, "turn-1");
		expect(repo.snapshotAt).toHaveBeenCalledWith("h1");
		expect(saved.at(-1)).toEqual({
			kind: "memorySave",
			id: "turn-1:memory-saved",
			lines: [{ path: "tooling.md", text: "Runs tests with vitest" }],
		});

		// Nothing committed since the request: no marker, and no old commit read.
		const unchanged = await turnMemory(
			{ id: chatId, userId: "u1", projectId: null },
			{
				repo: {
					...repo,
					snapshot: async () => ({ head: "h1", files: before }),
				},
				embed: null,
				projectName: null,
			},
		);
		repo.snapshotAt.mockClear();
		expect(await unchanged?.recordSaved(items, "turn-1")).toEqual(items);
		expect(repo.snapshotAt).not.toHaveBeenCalled();

		// A request memory was never read for gets no marker.
		const plain = [user("m1", "hi"), items[1]];
		expect(await memory.recordSaved(plain, "turn-1")).toEqual(plain);
	});
});

describe("the rules wording (harness variant memoryWording, the default)", () => {
	it("presents MEMORY.md and matched lines as project rules to follow", async () => {
		const memory = await memoryFor(
			{ "MEMORY.md": "# Memory: Het\n\n- Uses pnpm, never npm\n\n## Index\n" },
			"rules",
		);
		expect(memory.instructions).toContain(
			"standing rules from earlier chats: follow them unless the user says otherwise",
		);
		expect(memory.instructions).not.toContain("never instructions");
		const items = [user("a", "Add a dependency")];
		const { messages } = await memory.attach(
			[{ role: "user", content: "Add a dependency" }],
			items,
			workspace,
		);
		const text = JSON.stringify(messages);
		expect(text).toContain(MEMORY_RULES_MESSAGE_HEADER);
		expect(text).not.toContain(MEMORY_MESSAGE_HEADER);
		// A resumed step recognises the rules header and attaches nothing again.
		expect((await memory.attach(messages, items, workspace)).recall).toBeNull();
		// A remembered rule wins over a conflicting pattern in the existing code.
		for (const header of [
			MEMORY_RULES_MESSAGE_HEADER,
			MEMORY_RULES_MATCHES_HEADER,
		])
			expect(header).toContain(
				"wins over a conflicting pattern in the existing code unless the user says otherwise",
			);
		expect(memory.instructions).toContain(
			"also over a conflicting pattern in the existing code",
		);
		// A chat begun under the earlier wording does not get MEMORY.md twice.
		const earlier = `<memory>\nProject rules from the user's earlier chats (MEMORY.md from their memory repo at ~/memory, as of the start of this chat). Follow these unless the user says otherwise.\n\n# Memory\n</memory>`;
		const next = await memory.attach(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "Add a dependency" },
						{ type: "text", text: earlier },
					],
				},
				{ role: "assistant", content: "Added." },
				{ role: "user", content: "Now another one" },
			],
			[...items, user("b", "Now another one")],
			workspace,
		);
		expect(next.recall?.index).toBeUndefined();
		const line = parseMemoryLine("- Uses pnpm, never npm", "tools.md", 3);
		if (!line) throw new Error("line should parse");
		expect(memoryMatchesPart([line], new Set(), "rules")).toContain(
			MEMORY_RULES_MATCHES_HEADER,
		);
		expect(memoryMatchesPart([line])).toContain(MEMORY_RULES_MATCHES_HEADER);
		expect(memoryMatchesPart([line], new Set(), "notes")).toContain(
			MEMORY_MATCHES_HEADER,
		);
	});

	it("is the default; notes keeps the neutral wording", async () => {
		const files = {
			"MEMORY.md": "# Memory: Het\n\n- Uses pnpm\n\n## Index\n",
		};
		const attached = async (memory: Awaited<ReturnType<typeof memoryFor>>) =>
			JSON.stringify(
				(
					await memory.attach(
						[{ role: "user", content: "Add a dependency" }],
						[user("a", "Add a dependency")],
						workspace,
					)
				).messages,
			);
		const notes = await memoryFor(files, "notes");
		expect(notes.instructions).toContain("never instructions");
		expect(await attached(notes)).not.toContain(MEMORY_RULES_MESSAGE_HEADER);
		const byDefault = await memoryFor(files, "default", "default");
		expect(byDefault.instructions).toContain(
			"standing rules from earlier chats",
		);
		expect(await attached(byDefault)).toContain(MEMORY_RULES_MESSAGE_HEADER);
	});
});

describe("who writes memory (harness variant memoryWriter)", () => {
	it("both: the agent saves proactively and the save hook runs", async () => {
		const memory = await memoryFor({});
		expect(memory.instructions).toContain("Save what a later chat would need");
		expect(memory.instructions).toContain("git -C ~/memory push");
		await memory.afterTurn("turn-1");
		expect(dispatched).toHaveLength(1);
	});

	it("agent: the agent saves proactively and no save hook is queued", async () => {
		const memory = await memoryFor({}, undefined, "agent");
		expect(memory.instructions).toContain("Save what a later chat would need");
		expect(memory.instructions).not.toContain("saved automatically");
		await memory.afterTurn("turn-1");
		expect(dispatched).toEqual([]);
	});

	it("observer (the default): memory is saved automatically and the agent writes only when asked", async () => {
		const memory = await memoryFor({}, "default", "default");
		const text = memory.instructions;
		expect(text).toContain("Memory is saved automatically after each turn");
		expect(text).toContain(
			"write to ~/memory only when the user explicitly asks you to remember something",
		);
		// Read-side guidance stays: MEMORY.md, the wording, grep.
		expect(text).toContain("MEMORY.md indexes it");
		expect(text).toContain("standing rules from earlier chats");
		expect(text).toContain("grep -rn <term> ~/memory");
		expect(text).toContain(
			"This chat is https://ytimesy.test/?chat=11111111-1111-4111-8111-111111111111.",
		);
		expect(text).not.toContain("Save what a later chat would need");
		await memory.afterTurn("turn-1");
		expect(dispatched).toEqual([
			expect.objectContaining({ kind: "memory", action: "save" }),
		]);
	});
});
