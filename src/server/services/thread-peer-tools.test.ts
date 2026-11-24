import { describe, expect, it, vi } from "vitest";
import { peerMessageText, startedByPeerMessage } from "#/domain/thread-peer";
import { ALREADY_PEER_STARTED, threadPeerTools } from "./thread-peer-tools";

const run = (tools: ReturnType<typeof threadPeerTools>, input: unknown) =>
	(
		tools.message_thread as unknown as {
			execute: (i: unknown, o: unknown) => Promise<string>;
		}
	).execute(input, { toolCallId: "c", messages: [] });

function setup(started = false) {
	const send = vi.fn(async () => "Sent");
	return {
		send,
		tools: threadPeerTools({
			read: async () => "text",
			send,
			startedByPeer: () => started,
		}),
	};
}

describe("message_thread (worker)", () => {
	it("sends in queue mode by default", async () => {
		const { tools, send } = setup();
		await run(tools, { id: "t2", text: "hi" });
		expect(send).toHaveBeenCalledWith({ id: "t2", text: "hi", mode: "queue" });
	});
	it("stops after three sends in one turn", async () => {
		const { tools, send } = setup();
		for (let i = 0; i < 3; i++) await run(tools, { id: "t2", text: `m${i}` });
		expect(await run(tools, { id: "t2", text: "m4" })).toMatch(/at most 3/);
		expect(send).toHaveBeenCalledTimes(3);
	});
	it("refuses when a peer message started the turn", async () => {
		const { tools, send } = setup(true);
		expect(await run(tools, { id: "t2", text: "back" })).toBe(
			ALREADY_PEER_STARTED,
		);
		expect(send).not.toHaveBeenCalled();
	});
});

describe("startedByPeerMessage", () => {
	const peer = peerMessageText({ title: "A", id: "t1" }, "do x");
	it("is true when the latest user message is a peer message", () => {
		expect(
			startedByPeerMessage([
				{ kind: "userMessage", text: "hello" },
				{ kind: "userMessage", text: peer },
				{ kind: "agentMessage", text: "ok" },
			]),
		).toBe(true);
	});
	it("is false once the person writes again", () => {
		expect(
			startedByPeerMessage([
				{ kind: "userMessage", text: peer },
				{ kind: "userMessage", text: "thanks, now message B" },
			]),
		).toBe(false);
	});
	it("is false without a user message", () => {
		expect(startedByPeerMessage([])).toBe(false);
	});
});

describe("parsePeerMessage", () => {
	it("splits a peer message into sender and body", async () => {
		const { parsePeerMessage } = await import("#/domain/thread-peer");
		const text = peerMessageText(
			{ title: 'Fix "login"', id: "t1" },
			"Rebase\n\nplease",
		);
		expect(parsePeerMessage(text)).toEqual({
			from: "Fix login",
			body: "Rebase\n\nplease",
		});
		expect(parsePeerMessage("hello")).toBeNull();
	});
});
