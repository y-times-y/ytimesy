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
		// Root threads the crew rows below belong to; a crew row of a chat the
		// list leaves out (a helper chat, an archived thread) is not listed.
		...["t2", "t4"].map((id) => ({
			id,
			title: id,
			waitingOn: null,
			workingSince: null,
			updatedAt: null,
		})),
	]);
	const tools = ySquaredTools({
		userId: "u",
		projectId: "p",
		selfId: "y2",
		deps: {
			list: list as never,
			crew: () => client as never,
			now: () => NOW,
			outcome: async () => null,
		},
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

const store0 = (id: string) => {
	const crew = store();
	seeded(crew);
	return crew.thread(id);
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
		// One metadata read (which chats are root threads), no transcript.
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("threads: leaves out crew rows of helper chats and archived threads", async () => {
		const crew = store();
		seeded(crew);
		crew.noteThread(
			{
				userId: "u",
				projectId: "p",
				ySquaredId: "y2",
				prUrl: null,
				lastReply: null,
				waitingOn: null,
				sessionId: "builder-1",
				title: "Old builder",
				state: "failed",
			},
			NOW - 60_000,
		);
		const client = { list: async () => crew.list() };
		const tools = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			deps: {
				// builder-1 is a child chat: the root list does not have it.
				list: (async () => [
					{
						id: "t1",
						title: "Verbose flag",
						waitingOn: null,
						workingSince: null,
						updatedAt: null,
					},
				]) as never,
				crew: () => client as never,
				now: () => NOW,
			},
		});
		const text = await run(tools, "threads", {});
		expect(text).toContain("Verbose flag");
		expect(text).not.toContain("Old builder");
		expect(text).not.toContain("builder-1");
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
		// The root list is read each time (to drop helper chats); the crew is filled once.
		expect(list).toHaveBeenCalledTimes(2);
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

	it("retry_thread continues only a failed thread, through the send path", async () => {
		const f = writeFixture(
			{ t1: chat({ turnStatus: "failed" }), t2: chat({ id: "t2" }) },
			"running",
		);
		expect(await run(f.tools, "retry_thread", { id: "t1" })).toContain(
			"Retrying",
		);
		expect(f.send).toHaveBeenCalledTimes(1);
		const [, , sent] = f.send.mock.calls[0] as unknown as [
			unknown,
			unknown,
			{ text: string; modelId: string },
		];
		expect(sent.text).toContain("Your last turn failed");
		expect(sent.modelId).toBe("m-thread");
		expect(await run(f.tools, "retry_thread", { id: "t2" })).toContain(
			"nothing to retry",
		);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(await run(f.tools, "retry_thread", { id: "nope" })).toBe(
			"No such thread in this project.",
		);
	});

	it("archive_thread: failed and merged-PR threads go; open PRs, waiting, working and helper chats are refused with a reason", async () => {
		const archive = vi.fn(async () => undefined);
		const prOpen = vi.fn(async (_u: string, _p: string, url: string) =>
			url.endsWith("/1") ? true : url.endsWith("/2") ? false : null,
		);
		const rows: Record<string, unknown> = {
			t1: { waitingOn: "failed", prUrl: null },
			t2: { waitingOn: "question", prUrl: null },
			open: { waitingOn: null, prUrl: "https://github.com/o/r/pull/1" },
			merged: { waitingOn: null, prUrl: "https://github.com/o/r/pull/2" },
			unknown: { waitingOn: null, prUrl: "https://github.com/o/r/pull/3" },
		};
		const chats: Record<string, unknown> = {
			w: chat({ id: "w", turnStatus: "running" }),
			builder: chat({
				id: "builder",
				parentSessionId: "t1",
				agentRole: "writer",
			}),
			other: chat({ id: "other", projectId: "q" }),
			...Object.fromEntries(
				Object.keys(rows).map((id) => [id, chat({ id, turnStatus: "failed" })]),
			),
		};
		const tools = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			deps: {
				metadata: (async (_u: string, id: string) =>
					chats[id] ?? null) as never,
				crew: (() => ({
					thread: async (id: string) => rows[id] ?? null,
				})) as never,
				archive,
				prOpen,
			},
		});
		const go = (id: string) => run(tools, "archive_thread", { id });
		expect(await go("t1")).toContain("Archived");
		expect(await go("merged")).toContain("Archived");
		expect(archive.mock.calls.map((c) => c[1])).toEqual(["t1", "merged"]);
		expect(await go("open")).toContain("open pull request");
		expect(await go("unknown")).toContain("could not be checked");
		expect(await go("t2")).toContain("waiting on the person");
		expect(await go("w")).toContain("is working");
		// A helper chat is explained, never reported as missing.
		expect(await go("builder")).toContain("helper chat");
		expect(await go("builder")).not.toContain("No such thread");
		for (const id of ["other", "nope", "y2"])
			expect(await go(id)).toBe("No such thread in this project.");
		expect(archive).toHaveBeenCalledTimes(2);
	});

	it("reads no sidebar and no crew for any write tool", async () => {
		const f = writeFixture({ t1: chat({ turnStatus: "running" }) });
		await run(f.tools, "start_thread", { title: "A", brief: "B" });
		await run(f.tools, "message_thread", { id: "t1", text: "x" });
		await run(f.tools, "stop_thread", { id: "t1" });
		expect(f.list).not.toHaveBeenCalled();
		// the crew is only told of Y²'s own sends (start, message), never read
		expect(f.crew).toHaveBeenCalledTimes(2);
	});

	it("marks its own sends in the crew before sending, so they are not taken for the person's", async () => {
		const order: string[] = [];
		const noteY2Sent = vi.fn(async (id: string | null) => {
			order.push(`mark:${id}`);
		});
		const f = writeFixture({ t1: chat() });
		const tools = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			machines: {} as never,
			modelId: "m-y2",
			harnessId: "api",
			deps: {
				metadata: f.metadata as never,
				send: (async () => {
					order.push("send");
					return { turnStatus: "running" };
				}) as never,
				crew: (() => ({ noteY2Sent })) as never,
			},
		});
		await run(tools, "start_thread", { title: "A", brief: "B" });
		await run(tools, "message_thread", { id: "t1", text: "x" });
		expect(order).toEqual(["mark:null", "send", "mark:t1", "send"]);
	});

	it("message_thread modes: queue (default) waits for the turn's end, steer is released for the next step, interrupt stops first", async () => {
		for (const mode of [undefined, "queue"]) {
			const f = writeFixture({ t1: chat({ turnStatus: "running" }) });
			expect(
				await run(f.tools, "message_thread", { id: "t1", text: "x", mode }),
			).toContain("Queued the message");
			expect(f.stop).not.toHaveBeenCalled();
			expect(f.send).toHaveBeenCalledTimes(1);
			// not released: it waits for the turn's end (or Send)
			expect(
				(f.send.mock.calls[0] as unknown[] | undefined)?.[2],
			).not.toHaveProperty("released");
		}
		const steer = writeFixture({ t1: chat({ turnStatus: "running" }) });
		const steered = await run(steer.tools, "message_thread", {
			id: "t1",
			text: "use port 4001",
			mode: "steer",
		});
		expect(steered).toContain("Steering");
		expect(steered).toContain("next step");
		expect(steer.stop).not.toHaveBeenCalled();
		expect(steer.send).toHaveBeenCalledTimes(1);
		// released: the running turn takes it at its next step, with no extra turn
		expect(
			(steer.send.mock.calls[0] as unknown[] | undefined)?.[2],
		).toMatchObject({
			text: "use port 4001",
			released: true,
		});
		// an idle thread: steer behaves like send (it starts a turn)
		const idleSteer = writeFixture({ t1: chat() }, "running");
		expect(
			await run(idleSteer.tools, "message_thread", {
				id: "t1",
				text: "go",
				mode: "steer",
			}),
		).toContain("its turn started");
		expect(
			(idleSteer.send.mock.calls[0] as unknown[] | undefined)?.[2],
		).not.toHaveProperty("released");
		const order: string[] = [];
		const f = writeFixture({ t1: chat({ turnStatus: "running" }) }, "running");
		f.stop.mockImplementation(async () => {
			order.push("stop");
			return { turnStatus: "idle" };
		});
		f.send.mockImplementation((async () => {
			order.push("send");
			return { turnStatus: "running" };
		}) as never);
		const text = await run(f.tools, "message_thread", {
			id: "t1",
			text: "stop that, do this",
			mode: "interrupt",
		});
		expect(order).toEqual(["stop", "send"]);
		expect(text).toContain("Stopped the running turn");
		expect(text).toContain("its new turn started");
		// an idle thread has nothing to interrupt
		const idle = writeFixture({ t1: chat() }, "running");
		await run(idle.tools, "message_thread", {
			id: "t1",
			text: "go",
			mode: "interrupt",
		});
		expect(idle.stop).not.toHaveBeenCalled();
	});

	it("the message_thread schema leaves the mode optional (queue is applied in execute) and rejects an unknown one; the description no longer says steer is queue", () => {
		const f = writeFixture({ t1: chat() });
		const tool = f.tools.message_thread as {
			inputSchema: z.ZodType;
			description: string;
		};
		expect(
			(tool.inputSchema.parse({ id: "t1", text: "x" }) as { mode?: string })
				.mode,
		).toBeUndefined();
		expect(
			tool.inputSchema.safeParse({ id: "t1", text: "x", mode: "now" }).success,
		).toBe(false);
		expect(tool.description).toContain('"interrupt"');
		expect(tool.description).not.toContain("same as");
		expect(tool.description).toContain('"steer" delivers it at the thread');
		expect(tool.description).toContain("10 s late");
		expect(tool.description).toContain("after its next tool call");
	});
});

describe("ySquaredTools: which thread did what, and when", () => {
	const seed = (crew: SqliteYSquaredCrew) => {
		const base = {
			userId: "u",
			projectId: "p",
			ySquaredId: "y2",
			prUrl: null,
			lastReply: null,
			waitingOn: null,
		};
		crew.noteThread(
			{ ...base, sessionId: "t1", title: "Docs", state: "working" },
			NOW - 3 * 86_400_000,
		);
		crew.noteThread(
			{
				...base,
				sessionId: "t1",
				title: "Docs",
				state: "finished",
				lastReply: "Docs are updated.",
				lastRequest: "Update the README",
			},
			NOW - 3 * 86_400_000 + 60_000,
		);
		crew.noteThread(
			{
				...base,
				sessionId: "t2",
				title: "Health endpoint",
				state: "finished",
				lastReply: "Added /health.",
				lastRequest: "Add a health endpoint",
			},
			NOW - 2 * 3_600_000,
		);
	};

	it("threads: last active, created, last request and reply; most recently active first; compact", async () => {
		const { tools } = fixture(seed);
		const text = await run(tools, "threads", {});
		expect(text.indexOf("Health endpoint")).toBeLessThan(
			text.indexOf('"Docs"'),
		);
		expect(text).toContain("last active 2 h ago · created 2026-11-12");
		expect(text).toContain("last active 3 days ago · created 2026-11-09");
		expect(text).toContain("last request: Add a health endpoint");
		expect(text).toContain("last reply: Added /health.");
		for (const block of text.split(/\n(?=- \[)/))
			expect(block.split("\n").length).toBeLessThanOrEqual(6);
	});

	it("thread: shows the same facts for one thread", async () => {
		const { tools } = fixture(seed);
		const text = await run(tools, "thread", { id: "t2" });
		expect(text).toContain("last active 2 h ago · created 2026-11-12");
		expect(text).toContain("Last request: Add a health endpoint");
		expect(text).toContain("Last reply: Added /health.");
	});

	it("says what is not recorded for a thread seeded from the sidebar", async () => {
		const crew = fixture();
		// The overview fills the empty crew from the sidebar once.
		await run(crew.tools, "threads", {});
		const text = await run(crew.tools, "thread", { id: "t1" });
		expect(text).toContain("created not recorded");
		expect(text).toContain("last active");
	});

	it("thread: reads the thread's full final reply, its questions and canvases, not the crew's 300 characters", async () => {
		const long = `Audit findings\n${"A finding about licences and secrets. ".repeat(400)}\nVERDICT: safe to open-source after rotating the two keys.`;
		const { tools } = fixture(seeded);
		const outcome = vi.fn(async () => ({
			items: [
				{
					kind: "agentMessage" as const,
					text: "Working on it.",
					phase: "commentary",
				},
				{ kind: "agentMessage" as const, text: long, phase: "final_answer" },
				{
					kind: "userQuestion" as const,
					questions: [
						{
							question: "Rotate the keys now?",
							options: [{ label: "Yes" }, { label: "Later" }],
						},
					],
				},
			],
			canvases: [{ title: "Audit board", revision: 2 }],
		}));
		const withOutcome = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			deps: {
				crew: () =>
					({
						list: async () => ({ reconciled: true, rows: [] }),
						thread: async () => store0("t4"),
					}) as never,
				now: () => NOW,
				outcome: outcome as never,
			},
		});
		void tools;
		const text = await run(withOutcome, "thread", { id: "t4" });
		expect(outcome).toHaveBeenCalledWith("u", "t4");
		expect(text).toContain("Audit findings");
		expect(text).toContain(
			"VERDICT: safe to open-source after rotating the two keys.",
		);
		expect(text).toContain("characters in the middle omitted");
		expect(text).not.toContain("Working on it.");
		expect(text).toContain("Rotate the keys now? [Yes / Later]");
		expect(text).toContain('"Audit board" (revision 2)');
		expect(text).toContain("Pull request: https://github.com/a/b/pull/8");
	});

	it("thread: still answers from the crew's short reply when the full read fails", async () => {
		const { tools } = fixture(seeded);
		const failing = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			deps: {
				crew: () =>
					({
						list: async () => ({ reconciled: true, rows: [] }),
						thread: async () => store0("t4"),
					}) as never,
				now: () => NOW,
				outcome: async () => {
					throw new Error("connection timeout");
				},
			},
		});
		void tools;
		expect(await run(failing, "thread", { id: "t4" })).toContain(
			"Last reply: Done.",
		);
	});
});

describe("a thread Y² just started can be found and linked", () => {
	const created = {
		id: "t-new",
		projectId: "p",
		title: "Add health",
		harness: "api",
		listedModelId: "m-y2",
		parentSessionId: null,
		agentRole: null,
		turnStatus: "running",
		createdAt: "2026-11-12T11:59:00Z",
		updatedAt: "2026-11-12T11:59:30Z",
	};
	function startFixture() {
		const crew = store();
		const tools = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			machines: {} as never,
			modelId: "m-y2",
			harnessId: "api",
			turnId: "turn-1",
			deps: {
				now: () => NOW,
				metadata: (async (_user: string, id: string) =>
					id === created.id ? created : null) as never,
				send: (async () => ({
					turnStatus: "running",
					sessionId: created.id,
				})) as never,
				outcome: (async () => null) as never,
				// The crew has not heard of the new thread yet.
				crew: () =>
					({
						list: async () => crew.list(),
						thread: async (id: string) => crew.thread(id),
						reconcile: async () => undefined,
						noteY2Sent: async () => undefined,
					}) as never,
			},
		});
		return { tools };
	}

	it("start_thread names the new thread's id", async () => {
		const { tools } = startFixture();
		expect(
			await run(tools, "start_thread", {
				title: "Add health",
				brief: "Add GET /health.",
			}),
		).toMatch(/^Started "Add health" \(id t-new\)/);
	});

	it("thread reads a thread the crew has not noted yet from its own row", async () => {
		const { tools } = startFixture();
		const text = await run(tools, "thread", { id: "t-new" });
		expect(text).toContain('"Add health" (id t-new)');
		expect(text).toContain("Status: working");
		expect(await run(tools, "thread", { id: "nope" })).toBe(
			"No such thread in this project.",
		);
	});
});
