import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { durableObjectState } from "./support/durable-object-state";

const mocks = vi.hoisted(() => ({
	step: vi.fn(),
	query: vi.fn(),
	startJob: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {},
	DurableObject: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));
vi.mock("../src/server/adapters/database-scope", () => ({
	withDatabaseScope: async (_url: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query: mocks.query }),
}));
vi.mock("../src/server/jobs/model-workflow-executor", () => ({
	executeModelStep: mocks.step,
	executeWorkflowRequest: vi.fn(),
}));
vi.mock("../src/server/edge/background-jobs", () => ({
	BackgroundJobRunner: class {},
	admitQueuedTurns: vi.fn(),
	runBackgroundJob: vi.fn(),
	startBackgroundJob: mocks.startJob,
}));

import { ModelConversation } from "../src/server/edge/executor";

const scope = {
	userId: "u",
	sessionId: "00000000-0000-4000-8000-000000000003",
};
const turn = {
	turnId: "00000000-0000-4000-8000-000000000001",
	leaseId: "00000000-0000-4000-8000-000000000002",
};
function conversation() {
	const state = durableObjectState();
	const object = new ModelConversation(
		state.ctx as never,
		{
			HYPERDRIVE: { connectionString: "fixture" },
			DATABASE_URL: "postgres://fixture",
			MODEL_WORKFLOW_SECRET: "s".repeat(32),
			MODEL_EXECUTION_ENABLED: "1",
		} as never,
	);
	const sql = state.ctx.storage.sql;
	return { object, state, sql };
}
beforeEach(() => {
	vi.stubEnv("BACKGROUND_EXECUTION_ENABLED", "1");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
});

it("runs steps one alarm at a time and admits the next turn when done", async () => {
	mocks.step
		.mockResolvedValueOnce("continue")
		.mockResolvedValueOnce("completed");
	const { object, state, sql } = conversation();
	expect(await object.startTurn(scope, turn)).toBe(true);
	expect(await object.startTurn(scope, turn)).toBe(true);
	expect(
		await object.startTurn(scope, { ...turn, leaseId: scope.sessionId }),
	).toBe(false);
	expect(state.alarm.at).not.toBeNull();
	await object.alarm();
	expect(mocks.step.mock.calls[0][0]).toEqual({ ...turn, index: 1 });
	expect(mocks.step.mock.calls[0][4]).toBe(false);
	await object.alarm();
	expect(mocks.step.mock.calls[1][0]).toEqual({ ...turn, index: 2 });
	expect(sql.exec("select * from turn_loop").toArray()).toEqual([]);
	expect(state.alarm.at).toBeNull();
	expect(mocks.startJob.mock.calls[0][1]).toMatchObject({
		kind: "model-admission",
	});
});

it("ignores an alarm that fires while this instance's step still runs, instead of resuming that step", async () => {
	let finish = (_outcome: string) => {};
	mocks.step.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const { object, state, sql } = conversation();
	await object.startTurn(scope, turn);
	const running = object.alarm();
	await vi.waitFor(() => expect(mocks.step).toHaveBeenCalledTimes(1));
	// The room's lease write during the step re-armed the alarm; it fires early.
	await object.alarm();
	expect(mocks.step).toHaveBeenCalledTimes(1);
	expect(sql.exec("select resumes from turn_loop").toArray()).toEqual([
		{ resumes: 1 },
	]);
	finish("completed");
	await running;
	expect(sql.exec("select * from turn_loop").toArray()).toEqual([]);
	expect(state.alarm.at).toBeNull();
});

it("resumes a step whose previous attempt was interrupted, then gives up after repeated interruptions", async () => {
	mocks.step.mockResolvedValue("continue");
	const { object, sql } = conversation();
	await object.startTurn(scope, turn);
	sql.exec(
		"insert into model_step values(?,?,1,'processing',null,?)",
		turn.turnId,
		turn.leaseId,
		Date.now(),
	);
	await object.alarm();
	expect(mocks.step.mock.calls[0][4]).toBe(true);
	mocks.step.mockClear();
	sql.exec("update turn_loop set step_index=1,resumes=3");
	await object.alarm();
	expect(mocks.step).not.toHaveBeenCalled();
	expect(sql.exec("select * from turn_loop").toArray()).toEqual([]);
});

it("retries later instead of failing when infrastructure errors", async () => {
	mocks.step.mockRejectedValueOnce(new Error("database unavailable"));
	const { object, state, sql } = conversation();
	await object.startTurn(scope, turn);
	const before = Date.now();
	await object.alarm();
	expect(sql.exec("select step_index as i from turn_loop").toArray()).toEqual([
		{ i: 1 },
	]);
	expect(state.alarm.at).toBeGreaterThanOrEqual(before + 5_000);
});

it("renews the lease and chat coordination before resuming", async () => {
	mocks.query
		.mockResolvedValueOnce({ rowCount: 1, rows: [] })
		.mockResolvedValueOnce({
			rowCount: 1,
			rows: [
				{
					id: turn.turnId,
					session_id: scope.sessionId,
					user_id: scope.userId,
					state: "running",
					fresh: true,
					legacy: false,
					cancel_requested: false,
					version: "v1",
				},
			],
		})
		.mockResolvedValueOnce({
			rowCount: 1,
			rows: [{ messages: [{ role: "user", content: "hi" }], items: [] }],
		});
	mocks.step.mockImplementation(
		async (step, _machines, receipts, _signal, resume) => {
			const claim = await receipts.claim(step, resume);
			return claim.kind === "claimed" && claim.resumed
				? "completed"
				: "unavailable";
		},
	);
	const { object, state, sql } = conversation();
	await object.startTurn(scope, turn);
	await state.ctx.storage.put("identity", scope);
	sql.exec(
		"insert into model_step values(?,?,1,'processing',null,?)",
		turn.turnId,
		turn.leaseId,
		Date.now(),
	);
	await object.alarm();
	expect(mocks.query.mock.calls[0][0]).toContain("set lease_id=$3");
	const rotated = mocks.query.mock.calls[0][1][2];
	expect(rotated).not.toBe(turn.leaseId);
	expect(mocks.query.mock.calls[1][1]).toEqual([turn.turnId, rotated]);
	expect(mocks.query.mock.calls[1][0]).not.toContain("t.*");
	expect(mocks.query.mock.calls[2][0]).toContain("select messages,items");
	expect(
		sql.exec("select current_lease_id as l from turn_loop").toArray(),
	).toEqual([]);
	expect(mocks.startJob).toHaveBeenCalled();
});

it("cancels a turn between steps once its runner deadline has passed", async () => {
	mocks.query
		.mockResolvedValueOnce({
			rowCount: 1,
			rows: [
				{
					id: turn.turnId,
					session_id: scope.sessionId,
					user_id: scope.userId,
					state: "running",
					fresh: true,
					legacy: false,
					cancel_requested: false,
					past_deadline: true,
					version: "v1",
				},
			],
		})
		.mockResolvedValueOnce({ rowCount: 1, rows: [] })
		.mockResolvedValueOnce({
			rowCount: 1,
			rows: [{ messages: [], items: [] }],
		});
	let kind = "";
	mocks.step.mockImplementation(
		async (step, _machines, receipts, _signal, resume) => {
			const claim = await receipts.claim(step, resume);
			kind = claim.kind;
			return "unavailable";
		},
	);
	const { object, state } = conversation();
	await object.startTurn(scope, turn);
	await state.ctx.storage.put("identity", scope);
	await object.alarm();
	expect(mocks.query.mock.calls[0][0]).toContain("as past_deadline");
	expect(mocks.query.mock.calls[0][0]).toContain("turn-deadline");
	expect(mocks.query.mock.calls[1][0]).toContain("set cancel_requested=true");
	expect(mocks.query.mock.calls[1][1]).toEqual([turn.turnId, turn.leaseId]);
	expect(kind).toBe("cancelled");
});

it("refuses to run another chat's turn handed to this chat", async () => {
	mocks.query.mockResolvedValueOnce({
		rowCount: 1,
		rows: [
			{
				id: turn.turnId,
				session_id: "00000000-0000-4000-8000-000000000009",
				user_id: scope.userId,
				state: "running",
				fresh: true,
				legacy: false,
				cancel_requested: false,
				version: "v1",
			},
		],
	});
	let kind = "";
	mocks.step.mockImplementation(
		async (step, _machines, receipts, _signal, resume) => {
			kind = (await receipts.claim(step, resume)).kind;
			return "unavailable";
		},
	);
	const { object, state } = conversation();
	await object.startTurn(scope, turn);
	await state.ctx.storage.put("identity", scope);
	await object.alarm();
	expect(kind).toBe("unavailable");
	// Its history was never read.
	expect(mocks.query).toHaveBeenCalledTimes(1);
});

it("shares the alarm between the turn loop and the room lease", async () => {
	mocks.step.mockResolvedValue("continue");
	const { object, state, sql } = conversation();
	sql.exec(
		"insert into conversation_wake values('room',?)",
		Date.now() + 30_000,
	);
	await object.startTurn(scope, turn);
	expect(state.alarm.at).toBeLessThanOrEqual(Date.now());
	sql.exec("delete from turn_loop");
	await object.alarm();
	expect(state.alarm.at).toBeGreaterThan(Date.now() + 20_000);
});

it("starts a turn sent while the previous one was still ending once that one ends", async () => {
	const next = {
		turnId: "00000000-0000-4000-8000-000000000004",
		leaseId: "00000000-0000-4000-8000-000000000005",
	};
	mocks.step
		.mockResolvedValueOnce("cancelled")
		.mockResolvedValueOnce("completed");
	const { object, state, sql } = conversation();
	expect(await object.startTurn(scope, turn)).toBe(true);
	// Admitted after the stopped turn showed idle, before its loop ended.
	expect(await object.startTurn(scope, next)).toBe(true);
	expect(await object.startTurn(scope, next)).toBe(true);
	expect(
		await object.startTurn(scope, { ...next, leaseId: turn.leaseId }),
	).toBe(false);
	await object.alarm();
	expect(mocks.step.mock.calls[0][0]).toEqual({ ...turn, index: 1 });
	expect(
		sql.exec("select turn_id as t, step_index as i from turn_loop").toArray(),
	).toEqual([{ t: next.turnId, i: 1 }]);
	expect(state.alarm.at).not.toBeNull();
	await object.alarm();
	expect(mocks.step.mock.calls[1][0]).toEqual({ ...next, index: 1 });
	expect(sql.exec("select * from turn_loop").toArray()).toEqual([]);
	expect(sql.exec("select * from turn_queue").toArray()).toEqual([]);
	expect(state.alarm.at).toBeNull();
});

it("keeps a waiting turn's lease fresh until it starts", async () => {
	const next = {
		turnId: "00000000-0000-4000-8000-000000000004",
		leaseId: "00000000-0000-4000-8000-000000000005",
	};
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	try {
		const { object } = conversation();
		await object.startTurn(scope, turn);
		await object.startTurn(scope, next);
		mocks.query.mockResolvedValue({ rowCount: 1, rows: [] });
		// The stopped turn's step outlasts the 45-second freshness window.
		mocks.step.mockImplementationOnce(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
			return "cancelled";
		});
		mocks.step.mockResolvedValueOnce("completed");
		await object.alarm();
		const refreshes = mocks.query.mock.calls.filter(([query]) =>
			String(query).includes("set heartbeat_at=now()"),
		);
		// Once when the step began, every 15 seconds during it, and once when dequeued.
		expect(refreshes.length).toBeGreaterThanOrEqual(5);
		for (const [, bindings] of refreshes)
			expect(bindings).toEqual([[next.turnId], [next.leaseId]]);
	} finally {
		vi.useRealTimers();
	}
});

it("settles Stop on a waiting turn at once instead of leaving it queued", async () => {
	vi.stubEnv("YTIMESY_REALTIME_SECRET", "r".repeat(32));
	const { signDeliveryRequest } = await import("../src/domain/delivery-auth");
	const next = {
		turnId: "00000000-0000-4000-8000-000000000004",
		leaseId: "00000000-0000-4000-8000-000000000005",
	};
	const { object, sql } = conversation();
	await object.startTurn(scope, turn);
	await object.startTurn(scope, next);
	mocks.query.mockResolvedValue({ rowCount: 1, rows: [] });
	const url = "https://chat.internal/turn/cancel";
	const body = JSON.stringify({ ...scope, ...next });
	const response = await object.fetch(
		new Request(url, {
			method: "POST",
			headers: await signDeliveryRequest("r".repeat(32), "POST", url, body),
			body,
		}),
	);
	expect(response.status).toBe(204);
	const settle = mocks.query.mock.calls.find(([query]) =>
		String(query).includes("set state='cancelled'"),
	);
	expect(settle?.[1]).toEqual([next.turnId, next.leaseId]);
	expect(sql.exec("select * from turn_queue").toArray()).toEqual([]);
	// The active turn keeps running and still ends on its own.
	expect(sql.exec("select turn_id as t from turn_loop").toArray()).toEqual([
		{ t: turn.turnId },
	]);
});

it("stops the turn running in this object the moment its Stop arrives", async () => {
	vi.stubEnv("YTIMESY_REALTIME_SECRET", "r".repeat(32));
	const { signDeliveryRequest } = await import("../src/domain/delivery-auth");
	const { registerLiveTurn } = await import(
		"../src/server/services/live-turn-abort"
	);
	const { ApiTurnCancelled } = await import("../src/domain/api-turn-failure");
	const { object } = conversation();
	const control = async (action: string) => {
		const url = `https://chat.internal/turn/${action}`;
		const body = JSON.stringify({ ...scope, ...turn });
		return object.fetch(
			new Request(url, {
				method: "POST",
				headers: await signDeliveryRequest("r".repeat(32), "POST", url, body),
				body,
			}),
		);
	};
	expect((await control("acquire")).status).toBe(204);
	const abort = vi.fn();
	const forget = registerLiveTurn(turn.turnId, abort);
	try {
		expect((await control("cancel")).status).toBe(204);
		expect(abort).toHaveBeenCalledOnce();
		expect(abort.mock.calls[0][0]).toBeInstanceOf(ApiTurnCancelled);
	} finally {
		forget();
	}
});

it("leaves a turn it does not hold running when a stale Stop arrives", async () => {
	vi.stubEnv("YTIMESY_REALTIME_SECRET", "r".repeat(32));
	const { signDeliveryRequest } = await import("../src/domain/delivery-auth");
	const { registerLiveTurn } = await import(
		"../src/server/services/live-turn-abort"
	);
	const { object } = conversation();
	const abort = vi.fn();
	const forget = registerLiveTurn(turn.turnId, abort);
	try {
		const url = "https://chat.internal/turn/cancel";
		const body = JSON.stringify({ ...scope, ...turn });
		const response = await object.fetch(
			new Request(url, {
				method: "POST",
				headers: await signDeliveryRequest("r".repeat(32), "POST", url, body),
				body,
			}),
		);
		expect(response.status).toBe(409);
		expect(abort).not.toHaveBeenCalled();
	} finally {
		forget();
	}
});
