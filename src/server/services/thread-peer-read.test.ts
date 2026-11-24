import { describe, expect, it, vi } from "vitest";
import {
	NO_PEER_THREAD,
	readPeerThread,
	sendPeerMessage,
} from "./thread-peer-read";

const chat = (over: Record<string, unknown> = {}) => ({
	id: "t2",
	projectId: "p1",
	title: "Fix login",
	turnStatus: "idle",
	parentSessionId: null,
	agentRole: null,
	...over,
});

function run(over: Record<string, unknown> | null, y2 = false, id = "t2") {
	const outcome = vi.fn(async () => ({
		items: [{ kind: "agentMessage", text: "Done, PR #4" }],
		canvases: [],
	}));
	return {
		outcome,
		text: readPeerThread(
			{ userId: "u1", projectId: "p1", selfId: "t1", id },
			{
				metadata: (async () => (over === null ? null : chat(over))) as never,
				outcome: outcome as never,
				isY2: async () => y2,
			},
		),
	};
}

describe("readPeerThread", () => {
	it("reads a same-project root thread's reply", async () => {
		expect(await run({}).text).toContain("Done, PR #4");
	});
	it.each([
		["unknown", null],
		["other project", { projectId: "p2" }],
		["a subagent", { parentSessionId: "t9" }],
		["a helper", { agentRole: "writer" }],
	])("refuses %s", async (_name, over) => {
		const r = run(over);
		expect(await r.text).toBe(NO_PEER_THREAD);
		expect(r.outcome).not.toHaveBeenCalled();
	});
	it("refuses Y² and itself", async () => {
		expect(await run({}, true).text).toBe(NO_PEER_THREAD);
		expect(await run({}, false, "t1").text).toBe(NO_PEER_THREAD);
	});
});

describe("sendPeerMessage", () => {
	const base = {
		userId: "u1",
		projectId: "p1",
		selfId: "t1",
		id: "t2",
		text: "Please rebase",
		mode: "queue" as const,
		turnId: "turn-1",
		machines: {} as never,
	};
	function go(target: Record<string, unknown> | null, over = {}) {
		const send = vi.fn(async () => ({ turnStatus: "running" }));
		const result = sendPeerMessage(
			{ ...base, ...over },
			{
				metadata: (async (_u: string, id: string) =>
					id === "t1"
						? chat({ id: "t1", title: "Main work" })
						: target === null
							? null
							: chat(target)) as never,
				isY2: async () => false,
				send: send as never,
			},
		);
		return { send, result };
	}
	it("sends a wrapped peer message through the send path", async () => {
		const { send, result } = go({ listedModelId: "m", harness: "api" });
		expect(await result).toContain("its turn started");
		const body = (send.mock.calls[0] as unknown[])[2] as { text: string };
		expect(body.text).toContain('[Message from thread "Main work" (id t1)');
		expect(body.text).toContain("Please rebase");
	});
	it("steers a running thread with a released row", async () => {
		const { send, result } = go(
			{ turnStatus: "running" },
			{ mode: "steer" as const },
		);
		expect(await result).toContain("next step");
		expect((send.mock.calls[0] as unknown[])[2]).toMatchObject({
			released: true,
		});
	});
	it.each([
		["unknown", null],
		["other project", { projectId: "p2" }],
		["a helper", { agentRole: "writer" }],
	])("refuses %s without sending", async (_n, target) => {
		const { send, result } = go(target);
		expect(await result).toBe(NO_PEER_THREAD);
		expect(send).not.toHaveBeenCalled();
	});
});
