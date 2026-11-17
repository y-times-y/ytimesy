import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { Y_SQUARED_MAX_STARTS_PER_TURN } from "#/domain/y-squared";
import { SqliteYSquaredCrew } from "../edge/y-squared-crew-store";
import { ySquaredTools } from "./y-squared-tools";

const run = (
	tools: ReturnType<typeof ySquaredTools>,
	name: string,
	input: unknown,
) =>
	(
		tools[name] as {
			execute: (input: unknown, options: unknown) => Promise<string>;
		}
	).execute(input, { toolCallId: "c", messages: [] });

function store() {
	const db = new DatabaseSync(":memory:");
	return new SqliteYSquaredCrew({
		exec(query: string, ...bindings: (string | number | null)[]) {
			const statement = db.prepare(query);
			if (/^\s*select/i.test(query)) {
				const rows = statement.all(...bindings);
				return { toArray: () => rows.map((row) => ({ ...row })) };
			}
			statement.run(...bindings);
			return { toArray: () => [] };
		},
	} as never);
}

const NOW = Date.parse("2026-11-12T12:00:00Z");

function fixture(seed: (crew: SqliteYSquaredCrew) => void = () => {}) {
	const crew = store();
	seed(crew);
	const requests = { list: 0, thread: 0, reconcile: 0 };
	const client = {
		list: async () => {
			requests.list++;
			return crew.list();
		},
		thread: async (id: string) => {
			requests.thread++;
			return crew.thread(id);
		},
		reconcile: async (rows: never) => {
			requests.reconcile++;
			crew.reconcile(rows);
		},
	};
	const list = vi.fn(async () => [
		{
			id: "y2",
			title: "Y²",
			waitingOn: null,
			workingSince: null,
			updatedAt: null,
		},
		{
			id: "t1",
			title: "Verbose flag",
			waitingOn: "question",
			workingSince: null,
			updatedAt: "2026-11-12T11:00:00Z",
		},
		{
			id: "t3",
			title: "New session",
			waitingOn: null,
			workingSince: null,
			updatedAt: null,
			unused: true,
		},
	]);
	const tools = ySquaredTools({
		userId: "u",
		projectId: "p",
		selfId: "y2",
		deps: { list: list as never, crew: () => client as never, now: () => NOW },
	});
	return { tools, list, requests };
}

const seeded = (crew: SqliteYSquaredCrew) => {
	const base = {
		userId: "u",
		projectId: "p",
		ySquaredId: "y2",
		prUrl: null,
		lastReply: null,
		waitingOn: null,
	};
	crew.noteThread(
		{
			...base,
			sessionId: "t1",
			title: "Verbose flag",
			state: "waiting",
			waitingOn: "question",
			lastReply: "Should it print to stderr or stdout?",
		},
		NOW - 3_600_000,
	);
	crew.noteThread(
		{ ...base, sessionId: "t2", title: "Health endpoint", state: "working" },
		NOW - 5 * 60_000,
	);
	crew.noteThread(
		{
			...base,
			sessionId: "t4",
			title: "Docs",
			state: "finished",
			prUrl: "https://github.com/a/b/pull/8",
			lastReply: "Done.",
		},
		NOW - 60_000,
	);
};

describe("ySquaredTools", () => {
	it("threads: needs-you first, one crew request, no sidebar or transcript read", async () => {
		const { tools, list, requests } = fixture(seeded);
		const text = await run(tools, "threads", {});
		expect(text).not.toContain("Y²");
		expect(text.indexOf("Verbose flag")).toBeLessThan(
			text.indexOf("Health endpoint"),
		);
		expect(text).toContain("needs your answer to a question");
		expect(text).toContain("last reply: Should it print to stderr or stdout?");
		expect(text).toContain("working for 5 min");
		expect(text).toContain("pull request: https://github.com/a/b/pull/8");
		expect(requests).toEqual({ list: 1, thread: 0, reconcile: 0 });
		expect(list).not.toHaveBeenCalled();
	});

	it("thread: one row in one request; another project's id and Y² are refused", async () => {
		const { tools, requests } = fixture(seeded);
		const text = await run(tools, "thread", { id: "t1" });
		expect(text).toContain('"Verbose flag" (id t1)');
		expect(text).toContain("Status: it needs your answer to a question");
		expect(text).toContain("Last reply: Should it print to stderr or stdout?");
		expect(requests).toEqual({ list: 0, thread: 1, reconcile: 0 });
		expect(await run(tools, "thread", { id: "elsewhere" })).toBe(
			"No such thread in this project.",
		);
		expect(await run(tools, "thread", { id: "y2" })).toBe(
			"No such thread in this project.",
		);
	});

	it("cold start: fills the crew once from sidebar metadata, then never again", async () => {
		const { tools, list, requests } = fixture();
		const first = await run(tools, "threads", {});
		expect(first).toContain("Verbose flag");
		expect(first).not.toContain("New session");
		expect(list).toHaveBeenCalledTimes(1);
		expect(requests.reconcile).toBe(1);
		await run(tools, "threads", {});
		expect(list).toHaveBeenCalledTimes(1);
		expect(requests.reconcile).toBe(1);
	});

	it("without a crew (local development) it reads sidebar metadata only", async () => {
		const tools = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			deps: {
				list: (async () => [
					{
						id: "t1",
						title: "Verbose flag",
						waitingOn: "question",
						workingSince: null,
						updatedAt: null,
					},
				]) as never,
				crew: () => null,
				now: () => NOW,
			},
		});
		expect(await run(tools, "threads", {})).toContain(
			"needs your answer to a question",
		);
	});
});

describe("ySquaredTools write tools", () => {
	const chat = (over: Record<string, unknown> = {}) => ({
		id: "t1",
		projectId: "p",
		title: "Verbose flag",
		harness: "api",
		listedModelId: "m-thread",
		parentSessionId: null,
		agentRole: null,
		turnStatus: "idle",
		...over,
	});
	function writeFixture(chats: Record<string, unknown>, turn = "idle") {
		const metadata = vi.fn(async (_user: string, id: string) =>
			id in chats ? (chats[id] as never) : null,
		);
		const send = vi.fn(async () => ({ turnStatus: turn }) as never);
		const stop = vi.fn(async () => ({ turnStatus: "idle" }));
		const list = vi.fn();
		const crew = vi.fn(() => null);
		const tools = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			machines: {} as never,
			modelId: "m-y2",
			harnessId: "api",
			turnId: "turn-1",
			deps: {
				metadata: metadata as never,
				send: send as never,
				stop: stop as never,
				list: list as never,
				crew,
			},
		});
		return { tools, metadata, send, stop, list, crew };
	}

	it("refuses another project's thread, Y² itself and subagents for message and stop", async () => {
		const f = writeFixture({
			other: chat({ id: "other", projectId: "q" }),
			y2: chat({ id: "y2" }),
			child: chat({ id: "child", parentSessionId: "t1" }),
		});
		for (const id of ["other", "y2", "child", "missing"]) {
			expect(await run(f.tools, "message_thread", { id, text: "hi" })).toBe(
				"No such thread in this project.",
			);
			expect(await run(f.tools, "stop_thread", { id })).toBe(
				"No such thread in this project.",
			);
		}
		expect(f.send).not.toHaveBeenCalled();
		expect(f.stop).not.toHaveBeenCalled();
		// Y² itself is refused before any database read.
		expect(f.metadata).not.toHaveBeenCalledWith("u", "y2");
	});

	it("start_thread says started when the turn runs and queued when admission holds it", async () => {
		const started = writeFixture({}, "running");
		const text = await run(started.tools, "start_thread", {
			title: "Add health",
			brief: "Add GET /health.",
		});
		expect(text).toMatch(/^Started "Add health"/);
		const [, scope, input] = started.send.mock.calls[0] as unknown as [
			unknown,
			Record<string, unknown>,
			Record<string, unknown>,
		];
		expect(scope).toMatchObject({ projectId: "p", createNew: true });
		expect(scope.sessionId).toBeUndefined();
		expect(input.text).toBe("Add health\n\nAdd GET /health.");
		expect(input.modelId).toBe("m-y2");
		const queued = writeFixture({}, "idle");
		expect(
			await run(queued.tools, "start_thread", { title: "A", brief: "B" }),
		).toContain("Queued");
		expect(
			await run(queued.tools, "start_thread", { title: "A", brief: "B" }),
		).toContain("behind the budget/concurrency limit");
	});

	it("keys sends by turn and content so a replay does not duplicate", async () => {
		const f = writeFixture({});
		await run(f.tools, "start_thread", { title: "A", brief: "B" });
		await run(f.tools, "start_thread", { title: "A", brief: "B" });
		await run(f.tools, "start_thread", { title: "A", brief: "C" });
		const keys = f.send.mock.calls.map(
			(call) =>
				(call as unknown as [unknown, unknown, { idempotencyKey: string }])[2]
					.idempotencyKey,
		);
		expect(keys[0]).toBe(keys[1]);
		expect(keys[2]).not.toBe(keys[0]);
	});

	it("stops starting after the per-turn guard and never sends the extra", async () => {
		const f = writeFixture({}, "running");
		for (let i = 0; i < Y_SQUARED_MAX_STARTS_PER_TURN; i++)
			expect(
				await run(f.tools, "start_thread", { title: `T${i}`, brief: "b" }),
			).toMatch(/^Started/);
		const extra = await run(f.tools, "start_thread", {
			title: "more",
			brief: "b",
		});
		expect(extra).toMatch(/^Not started: at most 8/);
		expect(f.send).toHaveBeenCalledTimes(Y_SQUARED_MAX_STARTS_PER_TURN);
	});

	it("message_thread queues into a running thread and starts a turn in an idle one", async () => {
		const running = writeFixture({ t1: chat({ turnStatus: "running" }) });
		expect(
			await run(running.tools, "message_thread", { id: "t1", text: "also" }),
		).toContain("Queued the message");
		const idle = writeFixture({ t1: chat() }, "running");
		expect(
			await run(idle.tools, "message_thread", { id: "t1", text: "go" }),
		).toContain("its turn started");
		const held = writeFixture({ t1: chat() }, "idle");
		expect(
			await run(held.tools, "message_thread", { id: "t1", text: "go" }),
		).toContain("behind the budget/concurrency limit");
		expect(
			(idle.send.mock.calls[0] as unknown[] | undefined)?.[1],
		).toMatchObject({
			sessionId: "t1",
			projectId: "p",
			createNew: false,
			harnessId: "api",
		});
	});

	it("rejects an oversized message in the schema", () => {
		const f = writeFixture({ t1: chat() });
		const schema = (f.tools.message_thread as { inputSchema: z.ZodType })
			.inputSchema;
		expect(
			schema.safeParse({ id: "t1", text: "x".repeat(8_001) }).success,
		).toBe(false);
		expect(schema.safeParse({ id: "t1", text: "ok" }).success).toBe(true);
	});

	it("stop_thread stops a running thread through the stop path only", async () => {
		const f = writeFixture({ t1: chat({ turnStatus: "running" }) });
		expect(await run(f.tools, "stop_thread", { id: "t1" })).toContain(
			"Stopped",
		);
		expect(f.stop).toHaveBeenCalledTimes(1);
		const idle = writeFixture({ t1: chat() });
		expect(await run(idle.tools, "stop_thread", { id: "t1" })).toContain(
			"is not running",
		);
		expect(idle.stop).not.toHaveBeenCalled();
	});

	it("reads no sidebar and no crew for any write tool", async () => {
		const f = writeFixture({ t1: chat({ turnStatus: "running" }) });
		await run(f.tools, "start_thread", { title: "A", brief: "B" });
		await run(f.tools, "message_thread", { id: "t1", text: "x" });
		await run(f.tools, "stop_thread", { id: "t1" });
		expect(f.list).not.toHaveBeenCalled();
		expect(f.crew).not.toHaveBeenCalled();
	});
});
