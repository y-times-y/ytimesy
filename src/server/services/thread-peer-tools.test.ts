import { describe, expect, it, vi } from "vitest";
import { threadPeerTools } from "./thread-peer-tools";

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
	const tools = threadPeerTools({
		userId: "u1",
		projectId: "p1",
		selfId: "t1",
		deps: {
			metadata: (async () => (over === null ? null : chat(over))) as never,
			outcome: outcome as never,
			isY2: async () => y2,
		},
	});
	const read = tools.read_thread as unknown as {
		execute: (i: unknown, o: unknown) => Promise<string>;
	};
	return {
		outcome,
		text: read.execute({ id }, { toolCallId: "c", messages: [] }),
	};
}

describe("read_thread", () => {
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
		expect(await r.text).toBe("No such thread in this project.");
		expect(r.outcome).not.toHaveBeenCalled();
	});
	it("refuses Y² and itself", async () => {
		expect(await run({}, true).text).toBe("No such thread in this project.");
		expect(await run({}, false, "t1").text).toBe(
			"No such thread in this project.",
		);
	});
});
