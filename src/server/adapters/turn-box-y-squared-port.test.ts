import { describe, expect, it, vi } from "vitest";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";

vi.mock("./database", () => ({
	database: () => {
		throw new Error("no database in this test");
	},
}));

import type { ApiTurn } from "./api-turns";
import { ySquaredPort } from "./turn-box-y-squared-port";

const Y2 = "11111111-1111-4111-8111-111111111111";
const THREAD = "33333333-3333-4333-8333-333333333333";
const HELPER = "44444444-4444-4444-8444-444444444444";
const OTHER_PROJECT = "55555555-5555-4555-8555-555555555555";
const chats: Record<string, Record<string, unknown>> = {
	[Y2]: {
		id: Y2,
		projectId: "p1",
		parentSessionId: null,
		agentRole: null,
		harness: "api",
	},
	[THREAD]: {
		id: THREAD,
		projectId: "p1",
		parentSessionId: null,
		agentRole: null,
		harness: "codex",
		turnStatus: "running",
	},
	[HELPER]: {
		id: HELPER,
		projectId: "p1",
		parentSessionId: THREAD,
		agentRole: "researcher",
		harness: "api",
	},
	[OTHER_PROJECT]: {
		id: OTHER_PROJECT,
		projectId: "p2",
		parentSessionId: null,
		agentRole: null,
		harness: "api",
	},
};

function world(options: { yEnabled?: boolean; ySquaredId?: string } = {}) {
	const calls: { dep: string; args: unknown[] }[] = [];
	const record =
		(dep: string, answer: unknown = null) =>
		async (...args: unknown[]) => {
			calls.push({ dep, args });
			return answer;
		};
	const crew = {
		list: record("crew.list", { reconciled: true, rows: [] }),
		thread: record("crew.thread"),
		reconcile: record("crew.reconcile"),
		noteY2Sent: record("crew.noteY2Sent"),
		noteWaiting: record("crew.noteWaiting"),
		schedule: record("crew.schedule", { ok: true }),
	};
	const run = {
		list: record("list", []),
		crew: () => crew,
		now: () => 0,
		metadata: async (_user: string, id: string) => chats[id] ?? null,
		outcome: record("outcome"),
		canvas: record("canvas"),
		download: record("download", "AAAA"),
		send: record("send", { turnStatus: "running" }),
		stop: record("stop", { turnStatus: "idle" }),
	} as never;
	const turn = { id: "t1", user_id: "u1", session_id: Y2 } as ApiTurn;
	return {
		calls,
		call: (dep: Parameters<typeof ySquaredPort>[1], args: unknown[]) =>
			ySquaredPort(turn, dep, JSON.parse(JSON.stringify(args)), {
				run,
				machines: () => ({ marker: "edge" }) as never,
				owner: (async (_u: string, id: string) => chats[id] ?? null) as never,
				yMode: (async () => ({
					enabled: options.yEnabled ?? true,
					ySquaredId: options.ySquaredId ?? Y2,
				})) as never,
			}),
	};
}
const refused = (promise: Promise<unknown>) =>
	expect(promise).rejects.toBeInstanceOf(TurnBoxPortForbidden);

describe("ySquared port: a box's Y² reaches only its own project's threads", () => {
	it("serves only the project's Y² chat", async () => {
		await refused(world({ ySquaredId: THREAD }).call("list", ["u1", "p1"]));
		await refused(world({ yEnabled: false }).call("list", ["u1", "p1"]));
		expect(await world().call("list", ["u1", "p1"])).toEqual([]);
	});

	it("refuses another user, another project and a thread that is not a root of this project", async () => {
		const w = world();
		await refused(w.call("list", ["u2", "p1"]));
		await refused(w.call("list", ["u1", "p2"]));
		await refused(w.call("outcome", ["u1", OTHER_PROJECT]));
		await refused(w.call("outcome", ["u1", HELPER]));
		await refused(w.call("outcome", ["u1", Y2]));
		expect(await w.call("metadata", ["u1", OTHER_PROJECT])).toBeNull();
		await refused(w.call("download", ["u1", THREAD, "a1"]));
	});

	it("sends with the thread's own harness and the edge's machines, never the box's scope", async () => {
		const w = world();
		await w.call("send", [
			{
				userId: "u1",
				projectId: "p1",
				sessionId: THREAD,
				harnessId: "evil",
				createNew: false,
			},
			{ text: "hi", modelId: "m1", idempotencyKey: "k1" },
		]);
		const send = w.calls.find((c) => c.dep === "send");
		expect(send?.args[0]).toEqual({ marker: "edge" });
		expect(send?.args[1]).toEqual({
			userId: "u1",
			projectId: "p1",
			harnessId: "codex",
			sessionId: THREAD,
			createNew: false,
		});
		await refused(
			w.call("send", [
				{ userId: "u1", projectId: "p1", sessionId: OTHER_PROJECT },
				{ text: "hi", modelId: "m1", idempotencyKey: "k2" },
			]),
		);
		// A new thread takes Y²'s own harness.
		await w.call("send", [
			{ userId: "u1", projectId: "p1", createNew: true, harnessId: "evil" },
			{ text: "new\n\nbrief", modelId: "m1", idempotencyKey: "k3" },
		]);
		expect(
			(
				w.calls.filter((c) => c.dep === "send")[1]?.args[1] as {
					harnessId: string;
				}
			).harnessId,
		).toBe("api");
	});

	it("stops only a thread of the project; a schedule is always this Y² chat's", async () => {
		const w = world();
		await w.call("stop", [
			{ userId: "u1", projectId: "p1", sessionId: THREAD },
		]);
		expect(w.calls.find((c) => c.dep === "stop")?.args[1]).toMatchObject({
			sessionId: THREAD,
			harnessId: "codex",
		});
		await w.call("crewSchedule", [
			{ action: "list" },
			{ userId: "u2", ySquaredId: THREAD },
		]);
		expect(w.calls.find((c) => c.dep === "crew.schedule")?.args[1]).toEqual({
			userId: "u1",
			ySquaredId: Y2,
		});
		await w.call("crewNoteY2Sent", [null]);
		await refused(w.call("crewNoteY2Sent", [OTHER_PROJECT]));
	});
});
