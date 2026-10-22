import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import { withAfterResponse } from "./after-response";
import {
	type ApiTurn,
	checkpointApiTurn,
	claimApiTurn,
	enqueueApiTurn,
	inheritedSubscriptionSettings,
	previousTurnMessages,
	renewApiTurn,
} from "./api-turns";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	release: vi.fn(),
	capture: vi.fn(),
	dispatch: vi.fn(),
	direct: vi.fn(),
	relay: vi.fn(),
}));
vi.mock("./turn-start", () => ({ startQueuedTurnsDirectly: mocks.direct }));
vi.mock("../jobs/conversation-delivery", () => ({
	relayConversationDeliveriesOnce: mocks.relay,
}));
vi.mock("./background-job-dispatch", () => ({
	dispatchBackgroundJob: mocks.dispatch,
}));
vi.mock("./analytics", () => ({ captureServerAnalytics: mocks.capture }));
vi.mock("./turn-history-mirror", () => ({ mirrorTurnHistory: vi.fn() }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: vi.fn(async () => undefined),
}));
vi.mock("./database", () => ({
	database: () => ({ connect: async () => mocks, query: mocks.query }),
}));
beforeEach(() => {
	mocks.dispatch.mockReset().mockResolvedValue(true);
	mocks.direct.mockReset().mockResolvedValue(false);
	mocks.relay.mockReset().mockResolvedValue(undefined);
	mocks.capture.mockReset();
	mocks.query.mockReset();
	mocks.release.mockReset();
});
const input = {
	userId: "owner",
	sessionId: "chat",
	connectionId: null,
	revision: subscriptionTurnRevision("low"),
	modelId: "model",
	routeId: "model",
	messages: [],
	items: [],
};

it("retries a disconnected heartbeat once with the same fenced turn identity", async () => {
	const error = Object.assign(new Error("private connection details"), {
		code: "ECONNRESET",
	});
	mocks.query.mockRejectedValueOnce(error).mockResolvedValue({ rowCount: 1 });
	expect(await renewApiTurn({ id: "turn", lease_id: "lease" } as ApiTurn)).toBe(
		true,
	);
	expect(mocks.query).toHaveBeenCalledTimes(2);
	expect(mocks.query.mock.calls[0]).toEqual(mocks.query.mock.calls[1]);
	expect(mocks.query.mock.calls[0][0]).toContain(
		"heartbeat_at>=now()-interval '45 seconds'",
	);
});

it("does not retry a rejected lease or an authentication error", async () => {
	const turn = { id: "turn", lease_id: "lease" } as ApiTurn;
	mocks.query.mockResolvedValueOnce({ rowCount: 0 });
	expect(await renewApiTurn(turn)).toBe(false);
	expect(mocks.query).toHaveBeenCalledOnce();
	mocks.query.mockReset();
	const error = Object.assign(new Error("private credentials"), {
		code: "28P01",
	});
	mocks.query.mockRejectedValue(error);
	await expect(renewApiTurn(turn)).rejects.toBe(error);
	expect(mocks.query).toHaveBeenCalledOnce();
});

it("claims in one round trip that bounds its own transaction before its lock", async () => {
	mocks.query.mockResolvedValue([
		{ fields: [], rows: [] },
		{ fields: [], rows: [] },
		{ fields: [], rows: [] },
		{ fields: [{ name: "id" }], rows: [{ id: "turn" }] },
		{ fields: [], rows: [] },
	]);
	expect(await claimApiTurn(2, 8)).toEqual({ id: "turn" });
	expect(mocks.query).toHaveBeenCalledOnce();
	const [batch, params] = mocks.query.mock.calls[0];
	expect(params).toBeUndefined();
	const statements = batch.split(";\n").map((part: string) => part.trim());
	expect(statements.slice(0, 3)).toEqual([
		"begin",
		"set local idle_in_transaction_session_timeout = '30s'",
		"set local statement_timeout = '20s'",
	]);
	expect(statements[3]).toMatch(
		/^with admission as \(select pg_try_advisory_xact_lock\(81738419\) as acquired\)\s+update api_turn/,
	);
	// The queued turn is read (and row-locked) only once the lock is held.
	expect(statements[3]).toContain(
		"select q.id from api_turn q where (select acquired from admission)",
	);
	expect(statements.at(-1)).toBe("commit;");
	expect(mocks.release).toHaveBeenCalledWith(false);
});

it("reports no claim when nothing was admitted", async () => {
	mocks.query.mockResolvedValue([
		{ fields: [], rows: [] },
		{ fields: [{ name: "id" }], rows: [] },
	]);
	expect(await claimApiTurn(2, 8)).toBeNull();
});

it("refuses an executor or chat id that is not a known literal", async () => {
	await expect(
		claimApiTurn(2, 8, "node'; drop table api_turn; --" as never),
	).rejects.toThrow("Unknown turn executor.");
	await expect(claimApiTurn(2, 8, "node", "x' or '1'='1")).rejects.toThrow(
		"Invalid chat id.",
	);
	expect(mocks.query).not.toHaveBeenCalled();
});

it("discards a connection whose rollback failed without hiding the claim error", async () => {
	const failure = new Error("connection lost during claim");
	mocks.query.mockImplementation(async (sql: string) => {
		if (sql === "rollback") throw new Error("rollback unavailable");
		throw failure;
	});
	await expect(claimApiTurn(2, 8)).rejects.toBe(failure);
	expect(mocks.release).toHaveBeenCalledWith(true);
});

it("rolls back and releases a healthy connection after a claim failure", async () => {
	const failure = new Error("statement timed out");
	mocks.query.mockImplementation(async (sql: string) => {
		if (sql === "rollback") return { rows: [] };
		throw failure;
	});
	await expect(claimApiTurn(2, 8)).rejects.toBe(failure);
	expect(mocks.query).toHaveBeenLastCalledWith("rollback");
	expect(mocks.release).toHaveBeenCalledWith(false);
});

it("inherits same-model subscription settings through owner-scoped ancestors", async () => {
	mocks.query.mockResolvedValue({
		rows: [{ connection_revision: subscriptionTurnRevision("medium", false) }],
	});
	expect(
		await inheritedSubscriptionSettings("owner", "child", "model"),
	).toEqual({ reasoning: "medium", fast: false });
	expect(mocks.query).toHaveBeenCalledWith(
		expect.stringContaining("t.model_id=$3"),
		["child", "owner", "model"],
	);
	mocks.query.mockResolvedValue({ rows: [] });
	expect(
		await inheritedSubscriptionSettings("owner", "child", "other"),
	).toBeNull();
});

/** The admission gate's answer: connected, the chat idle, nothing queued yet. */
const queueable = async (sql: string) => ({
	rows: sql.startsWith("with connection as")
		? [{ connected: true, found: true, turn_status: "idle", existing: false }]
		: [],
});

it("checks owner subscription and queues Codex without an API connection", async () => {
	mocks.query.mockImplementation(queueable);
	await enqueueApiTurn(input);
	const gate = mocks.query.mock.calls.find(([sql]) =>
		sql.startsWith("with connection as"),
	);
	expect(gate?.[0]).toContain("from agent_account where user_id=$2");
	expect(gate?.[0]).not.toContain("model_connection");
	expect(gate?.[1]).toEqual(["chat", "owner", null]);
	const queued = mocks.query.mock.calls.find(([sql]) =>
		sql.startsWith("with queued as (insert into api_turn"),
	);
	expect(queued?.[0]).toContain("update agent_session set harness=$14");
	expect(queued?.[1].slice(-2)).toEqual(["model", "codex"]);
	expect(mocks.release).toHaveBeenCalled();
	expect(mocks.capture).toHaveBeenCalledWith(
		"owner",
		"turn_started",
		{ runtime: "codex", role: "lead" },
		expect.objectContaining({
			key: expect.stringMatching(/^turn:.+:started$/),
		}),
	);
});

describe("waking the durable executor for a queued turn", () => {
	beforeEach(() => {
		vi.stubEnv("YTIMESY_MODEL_EXECUTION_TARGET", "durable-object");
		mocks.query.mockImplementation(queueable);
	});
	afterEach(() => vi.unstubAllEnvs());

	it("returns from a web request once the turn is committed, waking after the response", async () => {
		let woken = () => {};
		mocks.dispatch.mockReturnValue(
			new Promise<boolean>((resolve) => {
				woken = () => resolve(true);
			}),
		);
		const deferred: Promise<unknown>[] = [];
		await withAfterResponse(
			(work) => {
				deferred.push(work);
			},
			() => enqueueApiTurn(input),
		);
		// Committed and returned while the wake is still in flight.
		expect(mocks.query).toHaveBeenCalledWith("commit");
		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "model-admission" }),
		);
		// Beside the wake, the committed message and running turn go to the
		// chat's progress stream.
		expect(mocks.relay).toHaveBeenCalledWith("chat");
		expect(deferred).toHaveLength(2);
		woken();
		await Promise.all(deferred);
	});

	it("keeps a lost wake for the admission sweep without failing the send", async () => {
		mocks.dispatch.mockRejectedValue(new Error("executor unreachable"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const deferred: Promise<unknown>[] = [];
		await withAfterResponse(
			(work) => {
				deferred.push(work);
			},
			() => enqueueApiTurn(input),
		);
		await Promise.all(deferred);
		expect(warn).toHaveBeenCalledWith(
			"Cloudflare turn wake deferred; queued turn awaits recovery.",
		);
		warn.mockRestore();
	});

	it("starts the turn from the web Worker directly, dispatching admission only when that fails", async () => {
		mocks.direct.mockResolvedValue(true);
		await enqueueApiTurn(input);
		expect(mocks.direct).toHaveBeenCalledOnce();
		expect(mocks.dispatch).not.toHaveBeenCalled();
		mocks.direct.mockRejectedValue(new Error("binding unavailable"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await enqueueApiTurn(input);
		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "model-admission" }),
		);
		expect(warn).toHaveBeenCalledWith(
			"Direct turn start failed; dispatching admission.",
		);
		warn.mockRestore();
	});

	it("awaits the wake outside a web request (an executor enqueueing a turn)", async () => {
		let woken = false;
		mocks.dispatch.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			woken = true;
			return true;
		});
		await enqueueApiTurn(input);
		expect(woken).toBe(true);
		// An executor's own step relays its progress.
		expect(mocks.relay).not.toHaveBeenCalled();
	});
});

it("never turns a removed API connection into subscription billing", async () => {
	mocks.query.mockResolvedValue({ rows: [] });
	await expect(
		enqueueApiTurn({ ...input, revision: "api-revision" }),
	).rejects.toThrow("no longer available");
	expect(mocks.query).not.toHaveBeenCalledWith(
		expect.stringContaining("agent_account"),
		expect.anything(),
	);
	expect(mocks.query).toHaveBeenCalledWith("rollback");
});

it("does not queue when subscription credentials were revoked", async () => {
	mocks.query.mockResolvedValue({ rows: [] });
	await expect(enqueueApiTurn(input)).rejects.toThrow();
	expect(mocks.query).not.toHaveBeenCalledWith(
		expect.stringContaining("insert into api_turn"),
		expect.anything(),
	);
});

it("continues saved tool history however the last turn ended", async () => {
	const call = {
		role: "assistant" as const,
		content: [
			{
				type: "reasoning" as const,
				text: "",
				providerOptions: { openai: { encryptedContent: "sealed" } },
			},
			{
				type: "tool-call" as const,
				toolCallId: "call-1",
				toolName: "execute_command",
				input: { command: "pnpm test" },
			},
		],
	};
	const previous = {
		state: "completed",
		model_id: "model",
		connection_revision: input.revision,
		messages: [{ role: "user", content: "previous" }],
	};
	mocks.query.mockResolvedValue({ rows: [previous] });
	expect(
		await previousTurnMessages("owner", "chat", "model", input.revision),
	).toEqual(previous.messages);
	// A stopped turn keeps its native history; its unanswered call gets a stand-in.
	mocks.query.mockResolvedValue({
		rows: [
			{
				...previous,
				state: "cancelled",
				messages: [...previous.messages, call],
			},
		],
	});
	const stopped = await previousTurnMessages(
		"owner",
		"chat",
		"model",
		input.revision,
	);
	expect(stopped?.slice(0, 2)).toEqual([...previous.messages, call]);
	expect(stopped?.[2]).toMatchObject({
		role: "tool",
		content: [
			{
				toolCallId: "call-1",
				output: {
					type: "error-text",
					value: expect.stringContaining("stopped"),
				},
			},
		],
	});
	// Another model reads it provider-neutral: no reasoning, the call kept.
	mocks.query.mockResolvedValue({
		rows: [
			{ ...previous, state: "failed", messages: [...previous.messages, call] },
		],
	});
	const switched = await previousTurnMessages(
		"owner",
		"chat",
		"other",
		input.revision,
	);
	expect(JSON.stringify(switched)).not.toContain("sealed");
	expect(switched?.[1]).toMatchObject({
		role: "assistant",
		content: [{ type: "tool-call", toolCallId: "call-1" }],
	});
	expect(switched?.[2]).toMatchObject({
		role: "tool",
		content: [{ output: { value: expect.stringContaining("interrupted") } }],
	});
	// Nothing saved, or a turn still in flight: rebuild from the transcript.
	mocks.query.mockResolvedValue({ rows: [] });
	expect(
		await previousTurnMessages("owner", "chat", "model", input.revision),
	).toBeNull();
	mocks.query.mockResolvedValue({ rows: [{ ...previous, state: "running" }] });
	expect(
		await previousTurnMessages("owner", "chat", "model", input.revision),
	).toBeNull();
});

it("stores a tool output carrying NUL bytes without the jsonb escape Postgres rejects", async () => {
	mocks.query.mockResolvedValue({ rows: [{ version: "v1" }] });
	const output = "#!/bin/sh\u0000\u0000ELF binary launcher";
	await checkpointApiTurn(
		{ id: "turn", lease_id: "lease" } as ApiTurn,
		[
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "bash",
						output: { type: "text", value: output },
					},
				],
			},
		],
		[
			{
				kind: "dynamicToolCall",
				id: SessionItemId("call-1"),
				tool: "bash",
				input: "{}",
				output,
				status: "completed",
			},
		],
	);
	const [, params] = mocks.query.mock.calls[0] as [string, unknown[]];
	for (const param of params.slice(2, 4)) {
		expect(param).not.toContain("\\u0000");
		expect(param).toContain("ELF binary launcher");
	}
});
