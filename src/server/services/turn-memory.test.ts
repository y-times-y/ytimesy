import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_MEMORY,
	MEMORY_MATCHES_HEADER,
	MEMORY_MESSAGE_HEADER,
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
		commit: async () => ({ ok: true, hash: "def" }),
		credentials: async () => ({ remote: "https://git/memory.git", token: "t" }),
		history: async () => [],
		destroy: async () => {},
	};
}

/** Word-overlap vectors: deterministic stand-ins for an embedding model. */
const VOCAB = ["pnpm", "install", "library", "timestamps", "utc", "tabs"];
const embed = vi.fn(async (texts: readonly string[]) =>
	texts.map((text) =>
		VOCAB.map((word) => (text.toLowerCase().includes(word) ? 1 : 0.01)),
	),
);
const cache = {
	load: async () => new Map<string, number[]>(),
	save: async () => {},
};

const user = (id: string, text: string) =>
	({ kind: "userMessage", id, text }) as unknown as SessionItem;
const workspace = async () => {
	throw new Error("no VM in this test");
};

async function memoryFor(files: Record<string, string>) {
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
		},
	);
	if (!memory) throw new Error("memory should be on");
	return memory;
}

beforeEach(() => {
	dispatched.length = 0;
	embed.mockClear();
});

describe("MEMORY.md at chat start", () => {
	it("attaches MEMORY.md once to the chat's first request, as a part of that message", async () => {
		const memory = await memoryFor({
			"MEMORY.md": "# Memory: Het\n\n- Prefers short answers\n\n## Index\n",
		});
		const first: ModelMessage[] = [{ role: "user", content: "Fix the build" }];
		const items = [user("a", "Fix the build")];
		const attached = await memory.attach(first, items, workspace);
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
		expect(await memory.attach(attached, items, workspace)).toBe(attached);

		// The next turn of the same chat: earlier messages stay byte-identical, no re-insert.
		const history: ModelMessage[] = [
			...attached,
			{ role: "assistant", content: "Done." },
			{ role: "user", content: "Now add tests" },
		];
		const next = await memory.attach(
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
			expect(
				await memory.attach(messages, [user("a", "Fix the build")], workspace),
			).toBe(messages);
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
		const attached = await memory.attach(messages, items, workspace);
		expect(attached.slice(0, 2)).toEqual(messages.slice(0, 2));
		const part = (attached[2].content as { text: string }[])[1].text;
		expect(part).toContain(MEMORY_MATCHES_HEADER);
		expect(part).toContain("tooling.md:2: - Uses pnpm");
		expect(part).not.toContain("UTC");

		// The same line is not injected again later in the chat.
		const later = await memory.attach(
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

	it("skips short messages and gives up after the timeout", async () => {
		const snapshot = { head: "a", files };
		const base = {
			snapshot,
			userId: "u1",
			alreadyShown: () => false,
			today: "2026-10-15",
			project: null,
			cache,
		};
		expect(await readHook({ ...base, embed, query: "ok" })).toEqual([]);
		expect(embed).not.toHaveBeenCalled();
		const slow = async () => new Promise<number[][]>(() => {});
		expect(
			await readHook({
				...base,
				embed: slow,
				query: "fix the timestamps in the export",
				timeoutMs: 20,
			}),
		).toEqual([]);
		const found = await readHook({
			...base,
			embed,
			query: "fix the timestamps in the export",
		});
		expect(found.map((entry) => entry.text)).toEqual([
			"Store timestamps in UTC",
		]);
	});
});
