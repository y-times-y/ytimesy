import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	ClaudeRelay,
	claudeRelayCallTag,
	isClaudeRelayBoxMessage,
	relayClaudeCall,
	relayedClaudeTools,
} from "./claude-relay";

function sql() {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query: string, ...bindings: (string | number | null)[]) {
			const statement = db.prepare(query);
			if (/^\s*select/i.test(query)) {
				const rows = statement.all(...bindings);
				return { toArray: () => rows.map((row) => ({ ...row })) };
			}
			statement.run(...bindings);
			return { toArray: () => [] };
		},
	};
}

class Socket {
	readonly sent: string[] = [];
	send(data: string) {
		this.sent.push(data);
	}
	close() {}
	frames() {
		return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
	}
}

function relay() {
	let now = 1_000_000;
	type Sink = { send(data: string): void; close(): void };
	const boxes = new Map<string, Sink[]>();
	const calls = new Map<string, Sink[]>();
	const store = new ClaudeRelay(
		sql(),
		{
			box: (turnId) => boxes.get(turnId) ?? [],
			call: (id) => calls.get(claudeRelayCallTag(id)) ?? [],
		},
		() => now,
	);
	return {
		store,
		boxes,
		calls,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const CALL = {
	t: "call" as const,
	name: "read",
	args: { path: "a.ts" },
	invocationId: "toolu_1",
	timeoutMs: 60_000,
	graceMs: 0,
};

describe("the chat object's Claude relay", () => {
	it("sends a call to the turn's box, again until acked, and its answer to the call's socket", () => {
		const { store, boxes, calls, advance } = relay();
		const box = new Socket();
		const caller = new Socket();
		boxes.set("t1", [box]);
		calls.set(claudeRelayCallTag("c1"), [caller]);
		store.call("t1", "c1", CALL);
		expect(box.frames()).toEqual([
			{
				t: "claude-call",
				id: "c1",
				name: "read",
				args: { path: "a.ts" },
				invocationId: "toolu_1",
				timeoutMs: 60_000,
				graceMs: 0,
			},
		]);
		// Not again within a few seconds of sending.
		store.deliver("t1");
		expect(box.sent).toHaveLength(1);
		advance(5_000);
		store.deliver("t1");
		expect(box.sent).toHaveLength(2);
		store.ack(["c1"]);
		advance(10_000);
		store.deliver("t1");
		expect(box.sent).toHaveLength(2);
		store.reply("c1", { text: "1 line", isError: false });
		expect(caller.frames()).toEqual([
			{ t: "reply", reply: { text: "1 line", isError: false } },
		]);
		// Answered: nothing of it is kept.
		store.deliver("t1", true);
		expect(box.sent).toHaveLength(2);
	});

	it("keeps a call while no box is connected and sends it once one is", () => {
		const { store, boxes } = relay();
		store.call("t1", "c1", CALL);
		const box = new Socket();
		boxes.set("t1", [box]);
		store.deliver("t1", true);
		expect(box.frames().map((frame) => frame.id)).toEqual(["c1"]);
	});

	it("drops a call whose edge request went away before the box took it, not one it took", () => {
		const { store, boxes } = relay();
		store.call("t1", "gone", CALL);
		store.call("t1", "taken", CALL);
		store.ack(["taken"]);
		store.callClosed("gone");
		store.callClosed("taken");
		const box = new Socket();
		boxes.set("t1", [box]);
		store.deliver("t1", true);
		expect(box.sent).toEqual([]);
	});

	it("only sends a turn's calls to that turn's box", () => {
		const { store, boxes } = relay();
		const other = new Socket();
		boxes.set("t2", [other]);
		store.call("t1", "c1", CALL);
		store.deliver("t2", true);
		expect(other.sent).toEqual([]);
	});

	it("keeps the tools a box published for its turn", () => {
		const { store } = relay();
		expect(store.listedTools("t1")).toBeNull();
		const tools = [{ name: "read", description: "Read", inputSchema: {} }];
		store.tools("t1", tools);
		expect(store.listedTools("t1")).toEqual(tools);
		expect(store.listedTools("t2")).toBeNull();
	});

	it("tells its own box messages apart", () => {
		expect(isClaudeRelayBoxMessage({ t: "claude-reply" })).toBe(true);
		expect(isClaudeRelayBoxMessage({ t: "claude-tools" })).toBe(true);
		expect(isClaudeRelayBoxMessage({ t: "progress" })).toBe(false);
		expect(isClaudeRelayBoxMessage(null)).toBe(false);
	});
});

/** A connected pair of in-memory WebSockets, as the runtime gives a Worker and an object. */
function socketPair() {
	type Listener = (event: { data?: unknown }) => void;
	type End = {
		listeners: { message: Listener[]; close: Listener[] };
		peer: End | null;
		closed: boolean;
		accept(): void;
		addEventListener(type: "message" | "close", listener: Listener): void;
		send(data: string): void;
		close(): void;
	};
	const make = (): End => {
		const listeners = { message: [] as Listener[], close: [] as Listener[] };
		return {
			listeners,
			peer: null,
			closed: false,
			accept() {},
			addEventListener(type: "message" | "close", listener: Listener) {
				listeners[type].push(listener);
			},
			send(data: string) {
				const peer = this.peer;
				if (this.closed || !peer) return;
				queueMicrotask(() => {
					for (const listener of peer.listeners.message) listener({ data });
				});
			},
			close() {
				if (this.closed) return;
				this.closed = true;
				const peer = this.peer;
				if (peer && !peer.closed) {
					peer.closed = true;
					for (const listener of peer.listeners.close) listener({});
				}
			},
		};
	};
	const worker = make();
	const object = make();
	worker.peer = object;
	object.peer = worker;
	return { worker, object };
}

describe("a relayed call, from the edge request to the box and back", () => {
	it("holds the run's MCP call in the edge request until the box answers through the object", async () => {
		const { store, boxes, calls } = relay();
		const box = new Socket();
		boxes.set("t1", [box]);
		const seen: Request[] = [];
		const chat = {
			fetch: async (request: Request) => {
				seen.push(request);
				const id = new URL(request.url).searchParams.get("id") ?? "";
				const pair = socketPair();
				calls.set(claudeRelayCallTag(id), [
					{ send: (data: string) => pair.object.send(data), close: () => {} },
				]);
				pair.object.addEventListener("message", (event) =>
					store.call("t1", id, JSON.parse(String(event.data))),
				);
				return { status: 101, webSocket: pair.worker } as unknown as Response;
			},
		};
		const answer = relayClaudeCall(chat, "Bearer grant", {
			name: "read",
			args: { path: "a.ts" },
			timeoutMs: 60_000,
			graceMs: 0,
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		const [frame] = box.frames();
		expect(frame).toMatchObject({ t: "claude-call", name: "read" });
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer grant");
		expect(seen[0]?.headers.get("upgrade")).toBe("websocket");
		store.reply(String(frame?.id), { text: "1 line", isError: false });
		await expect(answer).resolves.toEqual({ text: "1 line", isError: false });
	});

	it("answers an error the run can act on when the object refuses the call", async () => {
		const chat = { fetch: async () => new Response(null, { status: 401 }) };
		const answer = await relayClaudeCall(chat, "Bearer forged", {
			name: "read",
			args: {},
			timeoutMs: 1_000,
			graceMs: 0,
		});
		expect(answer.isError).toBe(true);
	});

	it("lists the tools once the box has published them", async () => {
		let asks = 0;
		const tools = await relayedClaudeTools(
			async () =>
				++asks < 3
					? null
					: [{ name: "read", description: "", inputSchema: {} }],
			async () => {},
		);
		expect(tools.map((tool) => tool.name)).toEqual(["read"]);
		expect(asks).toBe(3);
	});
});
