import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CLAUDE_AGENT_RUNNER_SCRIPT } from "./claude-agent-runner";
import { CLAUDE_FEED_PROTOCOL, claudeFeedMessage } from "./claude-feed";
import { CLAUDE_FEED_SENDER_SOURCE } from "./claude-feed-sender";

type Entry = { offset: number; next: number; line: string };
const sender = new Function(
	`${CLAUDE_FEED_SENDER_SOURCE}; return { feedFlushDelay, feedBeatDue, feedBackoff, feedBatch, feedEntry, feedUrgent, feedStalled, feedInboxDue };`,
)() as {
	feedFlushDelay: (
		mode: string,
		pendingSince: number | null,
		urgent: boolean,
		now: number,
	) => number | null;
	feedBeatDue: (lastSentAt: number, now: number) => boolean;
	feedBackoff: (attempt: number) => number;
	feedBatch: (
		buffer: Entry[],
		from: number,
		maxChars: number,
	) => { from: number; to: number; entries: [number, string][] } | null;
	feedEntry: (offset: number, line: string) => Entry;
	feedUrgent: (message: unknown) => boolean;
	feedStalled: (stalls: number) => boolean;
	feedInboxDue: (known: boolean, key: string, fetchedKey: string) => boolean;
};

describe("Claude feed sender cadence", () => {
	it("sends every second when watched, every 30 s otherwise, and urgent lines at once", () => {
		expect(sender.feedFlushDelay("live", null, false, 5_000)).toBeNull();
		expect(sender.feedFlushDelay("live", 5_000, false, 5_200)).toBe(800);
		expect(sender.feedFlushDelay("live", 5_000, false, 6_500)).toBe(0);
		expect(sender.feedFlushDelay("quiet", 5_000, false, 6_000)).toBe(29_000);
		expect(sender.feedFlushDelay("quiet", 5_000, false, 34_999)).toBe(1);
		expect(sender.feedFlushDelay("quiet", 5_000, false, 35_000)).toBe(0);
		expect(sender.feedFlushDelay("quiet", 5_000, true, 5_000)).toBe(0);
	});
	it("beats after 20 s without sending, and backs off reconnects up to a minute", () => {
		expect(sender.feedBeatDue(0, 19_999)).toBe(false);
		expect(sender.feedBeatDue(0, 20_000)).toBe(true);
		expect([0, 1, 2, 5, 6, 20].map(sender.feedBackoff)).toEqual([
			1_000, 2_000, 4_000, 32_000, 60_000, 60_000,
		]);
	});
	it("treats the run's start, a tool call and its result as urgent", () => {
		expect(sender.feedUrgent({ type: "system", subtype: "init" })).toBe(true);
		expect(sender.feedUrgent({ type: "result" })).toBe(true);
		expect(
			sender.feedUrgent({
				type: "assistant",
				message: { content: [{ type: "tool_use" }] },
			}),
		).toBe(true);
		expect(
			sender.feedUrgent({
				type: "assistant",
				message: { content: [{ type: "text" }] },
			}),
		).toBe(false);
		expect(sender.feedUrgent({ type: "user" })).toBe(false);
	});
	it("gives lines their byte offsets in the out file and replaces an oversized one", () => {
		const first = sender.feedEntry(0, '{"text":"héllo"}');
		expect(first).toEqual({ offset: 0, next: 18, line: '{"text":"héllo"}' });
		const huge = sender.feedEntry(18, "x".repeat(600 * 1024));
		expect(huge.next).toBe(18 + 600 * 1024 + 1);
		expect(huge.line).toBe('{"type":"ytimesy_oversize"}');
		// Small in bytes, too large once encoded for the socket.
		const quoted = sender.feedEntry(0, '"'.repeat(480 * 1024));
		expect(quoted.line).toBe('{"type":"ytimesy_oversize"}');
	});
	it("asks the inbox over HTTP only for a key not fetched, or when the feed cannot tell", () => {
		// Not connected, or an object that sends no inbox frames: always ask.
		expect(sender.feedInboxDue(false, "", "")).toBe(true);
		expect(sender.feedInboxDue(true, "", "")).toBe(false);
		expect(sender.feedInboxDue(true, "", "m1")).toBe(false);
		expect(sender.feedInboxDue(true, "m1", "")).toBe(true);
		expect(sender.feedInboxDue(true, "m1", "m1")).toBe(false);
		expect(sender.feedInboxDue(true, "m1,m2", "m1")).toBe(true);
	});
	it("gives up after five connections in a row that ended with lines unacknowledged", () => {
		expect([1, 4, 5].map(sender.feedStalled)).toEqual([false, false, true]);
	});
	it("batches from an offset up to a size, always at least one line", () => {
		const buffer = [
			sender.feedEntry(0, "a".repeat(50)),
			sender.feedEntry(51, "b".repeat(50)),
			sender.feedEntry(102, "c".repeat(50)),
		];
		expect(sender.feedBatch(buffer, 51, 1_000)).toMatchObject({
			from: 51,
			to: 153,
			entries: [
				[51, "b".repeat(50)],
				[102, "c".repeat(50)],
			],
		});
		expect(sender.feedBatch(buffer, 0, 10)?.entries.length).toBe(1);
		expect(sender.feedBatch(buffer, 153, 1_000)).toBeNull();
	});
});

it("caps short-line batches at the receiver entry limit", () => {
	const entries = Array.from({ length: 10_005 }, (_, index) =>
		sender.feedEntry(index * 2, "x"),
	);
	const first = sender.feedBatch(entries, 0, 900_000);
	expect(first?.entries).toHaveLength(10_000);
	// The receiver takes it whole, and the rest follows in the next batch.
	expect(claudeFeedMessage.safeParse({ type: "lines", ...first }).success).toBe(
		true,
	);
	expect(sender.feedBatch(entries, first?.to ?? 0, 900_000)?.entries).toEqual(
		entries.slice(10_000).map((entry) => [entry.offset, entry.line]),
	);
});

describe("the actual runner's feed", () => {
	it("pushes the lines it prints, with their offsets, resends on need and reports its exit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "claude-feed-"));
		const server = new WebSocketServer({
			port: 0,
			handleProtocols: (protocols) =>
				protocols.has(CLAUDE_FEED_PROTOCOL) ? CLAUDE_FEED_PROTOCOL : false,
		});
		await new Promise((resolve) => server.once("listening", resolve));
		const protocols: string[] = [];
		const received: [number, string][] = [];
		const messages: { type: string; [key: string]: unknown }[] = [];
		let receivedTo = 0;
		let askedAgain = false;
		server.on("connection", (socket, request) => {
			protocols.push(String(request.headers["sec-websocket-protocol"]));
			socket.on("message", (data) => {
				const message = JSON.parse(String(data));
				messages.push(message);
				const ack = () =>
					socket.send(
						JSON.stringify({ type: "ack", receivedTo, mode: "live" }),
					);
				if (message.type === "lines") {
					// The first batch is "lost": the object asks for it again.
					if (!askedAgain) {
						askedAgain = true;
						return socket.send(JSON.stringify({ type: "need", from: 0 }));
					}
					if (message.from !== receivedTo) return;
					received.push(...message.entries);
					receivedTo = message.to;
				}
				ack();
			});
		});
		try {
			writeFileSync(join(directory, "runner.mjs"), CLAUDE_AGENT_RUNNER_SCRIPT);
			writeFileSync(
				join(directory, "sdk.mjs"),
				`export async function* query() {
	yield { type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" };
	yield { type: "assistant", message: { content: [{ type: "text", text: "héllo" }] } };
	yield { type: "result", subtype: "success", result: "done" };
}`,
			);
			const { port } = server.address() as AddressInfo;
			writeFileSync(
				join(directory, "options.json"),
				JSON.stringify({
					model: "local-test",
					disallowedTools: [],
					feed: {
						url: `ws://127.0.0.1:${port}/claude-code/feed`,
						turnId: "22222222-2222-4222-8222-222222222222",
						run: 2,
					},
				}),
			);
			writeFileSync(
				join(directory, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						ytimesy: {
							type: "http",
							url: "http://127.0.0.1:9/unused",
							headers: { Authorization: "Bearer ytcc1.body.signature" },
						},
					},
				}),
			);
			writeFileSync(join(directory, "system"), "Local functional test.");
			writeFileSync(join(directory, "prompt"), "Return a result.");
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					join(directory, "runner.mjs"),
					join(directory, "sdk.mjs"),
					directory,
					directory,
				],
				{ encoding: "utf8", timeout: 20_000 },
			);
			expect(protocols).toEqual([
				`${CLAUDE_FEED_PROTOCOL}, ytcc1.body.signature`,
			]);
			expect(messages[0]).toEqual({
				type: "hello",
				turnId: "22222222-2222-4222-8222-222222222222",
				run: 2,
				receivedFrom: 0,
				inbox: true,
			});
			// Exactly what it printed, at the same byte offsets, once.
			const printed = stdout.split("\n").slice(0, -1);
			let offset = 0;
			const expected = printed.map((line): [number, string] => {
				const entry: [number, string] = [offset, line];
				offset += Buffer.byteLength(line) + 1;
				return entry;
			});
			expect(received).toEqual(expected);
			expect(receivedTo).toBe(Buffer.byteLength(stdout));
			expect(messages.at(-1)).toEqual({ type: "exit", status: 0 });
		} finally {
			server.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
	it("writes a failed run's stack to stderr before its feed says goodbye", async () => {
		const directory = mkdtempSync(join(tmpdir(), "claude-feed-"));
		const server = new WebSocketServer({
			port: 0,
			handleProtocols: (protocols) =>
				protocols.has(CLAUDE_FEED_PROTOCOL) ? CLAUDE_FEED_PROTOCOL : false,
		});
		await new Promise((resolve) => server.once("listening", resolve));
		let stderr = "";
		let exited = false;
		let exitMessage: unknown = null;
		/** Whether the stack was on stderr while the runner still waited on the feed. */
		let stackBeforeGoodbye: boolean | null = null;
		server.on("connection", (socket) => {
			let receivedTo = 0;
			socket.on("message", async (data) => {
				const message = JSON.parse(String(data));
				if (message.type === "lines") receivedTo = message.to;
				if (message.type === "exit") {
					exitMessage = message;
					// The runner holds its exit until this socket answers (or 5 s).
					for (
						let waited = 0;
						waited < 2_000 && !stderr.includes("boom");
						waited += 20
					)
						await new Promise((resolve) => setTimeout(resolve, 20));
					stackBeforeGoodbye = stderr.includes("boom") && !exited;
					return socket.send(JSON.stringify({ type: "stop" }));
				}
				socket.send(JSON.stringify({ type: "ack", receivedTo, mode: "live" }));
			});
		});
		try {
			writeFileSync(join(directory, "runner.mjs"), CLAUDE_AGENT_RUNNER_SCRIPT);
			writeFileSync(
				join(directory, "sdk.mjs"),
				`export async function* query() {
	yield { type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" };
	throw new Error("boom");
}`,
			);
			const { port } = server.address() as AddressInfo;
			writeFileSync(
				join(directory, "options.json"),
				JSON.stringify({
					model: "local-test",
					disallowedTools: [],
					feed: {
						url: `ws://127.0.0.1:${port}/claude-code/feed`,
						turnId: "22222222-2222-4222-8222-222222222222",
						run: 1,
					},
				}),
			);
			writeFileSync(
				join(directory, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						ytimesy: {
							type: "http",
							url: "http://127.0.0.1:9/unused",
							headers: { Authorization: "Bearer ytcc1.body.signature" },
						},
					},
				}),
			);
			writeFileSync(join(directory, "system"), "Local functional test.");
			writeFileSync(join(directory, "prompt"), "Return a result.");
			const child = spawn(process.execPath, [
				join(directory, "runner.mjs"),
				join(directory, "sdk.mjs"),
				directory,
				directory,
			]);
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const code = await new Promise<number | null>((resolve) =>
				child.on("exit", (status) => {
					exited = true;
					resolve(status);
				}),
			);
			expect(code).toBe(1);
			expect(exitMessage).toEqual({ type: "exit", status: 1 });
			expect(stderr).toMatch(/Error: boom\n\s+at /);
			expect(stackBeforeGoodbye).toBe(true);
		} finally {
			server.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
	it("still prints every line and exits normally when the feed cannot be reached", async () => {
		const directory = mkdtempSync(join(tmpdir(), "claude-feed-"));
		try {
			writeFileSync(join(directory, "runner.mjs"), CLAUDE_AGENT_RUNNER_SCRIPT);
			writeFileSync(
				join(directory, "sdk.mjs"),
				`export async function* query() { yield { type: "system", subtype: "init" }; yield { type: "result" }; }`,
			);
			writeFileSync(
				join(directory, "options.json"),
				JSON.stringify({
					model: "local-test",
					disallowedTools: [],
					feed: {
						url: "ws://127.0.0.1:9/claude-code/feed",
						turnId: "22222222-2222-4222-8222-222222222222",
						run: 1,
					},
				}),
			);
			writeFileSync(
				join(directory, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						ytimesy: { headers: { Authorization: "Bearer ytcc1.a.b" } },
					},
				}),
			);
			writeFileSync(join(directory, "system"), "Local functional test.");
			writeFileSync(join(directory, "prompt"), "Return a result.");
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					join(directory, "runner.mjs"),
					join(directory, "sdk.mjs"),
					directory,
					directory,
				],
				{ encoding: "utf8", timeout: 20_000 },
			);
			expect(
				stdout
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line).type),
			).toEqual(["system", "result"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});

/**
 * Runs the actual runner against a local object: a feed socket that acks
 * (and, when it takes inbox frames, sends the key the test sets) and an MCP
 * endpoint that counts the hooks' inbox requests. The fake SDK calls the
 * runner's own hooks, as Claude Code would after tool calls and before
 * stopping, and prints how many inbox requests each one made.
 */
async function runInboxScenario(sendsInbox: boolean) {
	const directory = mkdtempSync(join(tmpdir(), "claude-feed-"));
	const server = new WebSocketServer({
		port: 0,
		handleProtocols: (protocols) =>
			protocols.has(CLAUDE_FEED_PROTOCOL) ? CLAUDE_FEED_PROTOCOL : false,
	});
	await new Promise((resolve) => server.once("listening", resolve));
	const hellos: unknown[] = [];
	let feedSocket: import("ws").WebSocket | null = null;
	let inboxRequests = 0;
	const http = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://local");
		if (url.pathname === "/ready") {
			response.end(JSON.stringify(feedSocket !== null));
			return;
		}
		if (url.pathname === "/count") {
			response.end(String(inboxRequests));
			return;
		}
		if (url.pathname === "/key") {
			// An older object never sends inbox frames.
			if (sendsInbox)
				feedSocket?.send(
					JSON.stringify({ type: "inbox", key: url.searchParams.get("key") }),
				);
			response.end("ok");
			return;
		}
		inboxRequests++;
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "sent text" } }),
		);
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const control = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	server.on("connection", (socket) => {
		let receivedTo = 0;
		socket.on("message", (data) => {
			const message = JSON.parse(String(data));
			if (message.type === "hello") {
				hellos.push(message);
				socket.send(
					JSON.stringify({
						type: "ack",
						receivedTo,
						mode: "quiet",
						...(sendsInbox ? { ping: true } : {}),
					}),
				);
				if (sendsInbox) {
					socket.send(JSON.stringify({ type: "mode", mode: "quiet" }));
					socket.send(JSON.stringify({ type: "inbox", key: "" }));
				}
				feedSocket = socket;
				return;
			}
			if (message.type === "lines") receivedTo = message.to;
			socket.send(JSON.stringify({ type: "ack", receivedTo, mode: "quiet" }));
		});
	});
	try {
		writeFileSync(join(directory, "runner.mjs"), CLAUDE_AGENT_RUNNER_SCRIPT);
		writeFileSync(
			join(directory, "sdk.mjs"),
			`const control = ${JSON.stringify(control)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = async (path) => (await fetch(control + path)).text();
export async function* query({ options }) {
	yield { type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" };
	while ((await get("/ready")) !== "true") await sleep(20);
	await sleep(150);
	const afterTool = options.hooks.PostToolUse[0].hooks[0];
	const beforeStop = options.hooks.Stop[0].hooks[0];
	const steps = [];
	const step = async (name, hook) => {
		const output = await hook();
		steps.push({ name, requests: Number(await get("/count")), output: JSON.stringify(output) });
	};
	await step("idle", afterTool);
	await get("/key?key=m1");
	await sleep(150);
	await step("sent", afterTool);
	await step("again", afterTool);
	await get("/key?key=m1,m2");
	await sleep(150);
	await step("another", afterTool);
	await step("stop", beforeStop);
	yield { type: "ytimesy_test", steps };
	yield { type: "result", subtype: "success", result: "done" };
}`,
		);
		const { port } = server.address() as AddressInfo;
		writeFileSync(
			join(directory, "options.json"),
			JSON.stringify({
				model: "local-test",
				disallowedTools: [],
				feed: {
					url: `ws://127.0.0.1:${port}/claude-code/feed`,
					turnId: "22222222-2222-4222-8222-222222222222",
					run: 1,
				},
			}),
		);
		writeFileSync(
			join(directory, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					ytimesy: {
						type: "http",
						url: `${control}/mcp`,
						headers: { Authorization: "Bearer ytcc1.body.signature" },
					},
				},
			}),
		);
		writeFileSync(join(directory, "system"), "Local functional test.");
		writeFileSync(join(directory, "prompt"), "Return a result.");
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				join(directory, "runner.mjs"),
				join(directory, "sdk.mjs"),
				directory,
				directory,
			],
			{ encoding: "utf8", timeout: 20_000 },
		);
		const report = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.find((message) => message.type === "ytimesy_test");
		return {
			hellos,
			steps: report.steps as {
				name: string;
				requests: number;
				output: string;
			}[],
		};
	} finally {
		server.close();
		http.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("the actual runner's inbox hooks", () => {
	it("ask over HTTP only for a sent message the object announced, and always before stopping", async () => {
		const { hellos, steps } = await runInboxScenario(true);
		expect(hellos).toEqual([expect.objectContaining({ inbox: true })]);
		expect(steps.map((step) => [step.name, step.requests])).toEqual([
			["idle", 0],
			["sent", 1],
			["again", 1],
			["another", 2],
			["stop", 3],
		]);
		expect(JSON.parse(steps[1].output)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: "sent text",
			},
		});
		expect(JSON.parse(steps[2].output)).toEqual({});
	}, 30_000);
	it("keep asking after every tool call when the object sends no inbox frames (an older edge)", async () => {
		const { steps } = await runInboxScenario(false);
		expect(steps.map((step) => [step.name, step.requests])).toEqual([
			["idle", 1],
			["sent", 2],
			["again", 3],
			["another", 4],
			["stop", 5],
		]);
	}, 30_000);
});

describe("the feed's keep-alive and mode", () => {
	/** createFeed against a fake socket the test drives. */
	class FakeSocket {
		static last: FakeSocket | null = null;
		sent: string[] = [];
		onopen: (() => void) | null = null;
		onmessage: ((event: { data: string }) => void) | null = null;
		onclose: (() => void) | null = null;
		onerror: (() => void) | null = null;
		constructor() {
			FakeSocket.last = this;
		}
		send(text: string) {
			this.sent.push(text);
		}
		close() {}
		receive(message: unknown) {
			this.onmessage?.({ data: JSON.stringify(message) });
		}
	}
	const createFeed = new Function(
		"WebSocket",
		`${CLAUDE_FEED_SENDER_SOURCE}; return createFeed;`,
	)(FakeSocket) as (config: Record<string, unknown>) => {
		push: (line: string, message: unknown) => void;
		inboxDue: () => string | null;
		inboxFetched: (key: string) => void;
	};
	const open = () => {
		const feed = createFeed({
			url: "ws://feed",
			turnId: "22222222-2222-4222-8222-222222222222",
			run: 1,
			grant: "g",
		});
		const socket = FakeSocket.last as FakeSocket;
		socket.onopen?.();
		return { feed, socket };
	};
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	it("pings an object that answers pings without waking, and beats to an older one", () => {
		const current = open();
		current.socket.receive({
			type: "ack",
			receivedTo: 0,
			mode: "quiet",
			ping: true,
		});
		vi.advanceTimersByTime(20_500);
		expect(current.socket.sent.slice(1)).toEqual(["ping"]);
		const older = open();
		older.socket.receive({ type: "ack", receivedTo: 0, mode: "quiet" });
		vi.advanceTimersByTime(20_500);
		expect(older.socket.sent.slice(1)).toEqual([
			JSON.stringify({ type: "beat" }),
		]);
	});
	it("sends a quiet batch within a second once the object says someone watches", () => {
		const { feed, socket } = open();
		socket.receive({ type: "ack", receivedTo: 0, mode: "quiet", ping: true });
		feed.push('{"type":"assistant"}', { type: "assistant" });
		vi.advanceTimersByTime(5_000);
		expect(socket.sent).toHaveLength(1);
		socket.receive({ type: "mode", mode: "live" });
		vi.advanceTimersByTime(300);
		expect(JSON.parse(socket.sent[1] ?? "{}").type).toBe("lines");
	});
	it("tells the hooks to ask over HTTP until the object said what is waiting", () => {
		const { feed, socket } = open();
		expect(feed.inboxDue()).toBeNull();
		socket.receive({ type: "ack", receivedTo: 0, mode: "quiet", ping: true });
		expect(feed.inboxDue()).toBeNull();
		socket.receive({ type: "inbox", key: "" });
		expect(feed.inboxDue()).toBe("");
		socket.receive({ type: "inbox", key: "m1" });
		expect(feed.inboxDue()).toBe("m1");
		feed.inboxFetched("m1");
		expect(feed.inboxDue()).toBe("");
		// A lost socket: HTTP again until the next connection says.
		socket.onclose?.();
		expect(feed.inboxDue()).toBeNull();
	});
});
