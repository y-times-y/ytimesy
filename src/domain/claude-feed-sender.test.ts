import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CLAUDE_AGENT_RUNNER_SCRIPT } from "./claude-agent-runner";
import { CLAUDE_FEED_PROTOCOL } from "./claude-feed";
import { CLAUDE_FEED_SENDER_SOURCE } from "./claude-feed-sender";

type Entry = { offset: number; next: number; line: string };
const sender = new Function(
	`${CLAUDE_FEED_SENDER_SOURCE}; return { feedFlushDelay, feedBeatDue, feedBackoff, feedBatch, feedEntry, feedUrgent, feedStalled };`,
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
};

describe("Claude feed sender cadence", () => {
	it("sends every second when watched, every 10 s otherwise, and urgent lines at once", () => {
		expect(sender.feedFlushDelay("live", null, false, 5_000)).toBeNull();
		expect(sender.feedFlushDelay("live", 5_000, false, 5_200)).toBe(800);
		expect(sender.feedFlushDelay("live", 5_000, false, 6_500)).toBe(0);
		expect(sender.feedFlushDelay("quiet", 5_000, false, 6_000)).toBe(9_000);
		expect(sender.feedFlushDelay("quiet", 5_000, false, 15_000)).toBe(0);
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
	expect(sender.feedBatch(entries, 0, 900_000)?.entries).toHaveLength(10_000);
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
