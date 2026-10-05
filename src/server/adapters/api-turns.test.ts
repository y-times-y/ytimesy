import { beforeEach, expect, it, vi } from "vitest";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import {
	enqueueApiTurn,
	inheritedSubscriptionSettings,
	previousTurnMessages,
} from "./api-turns";

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("./database", () => ({
	database: () => ({ connect: async () => mocks, query: mocks.query }),
}));
beforeEach(() => {
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

it("checks owner subscription and queues Codex without an API connection", async () => {
	mocks.query.mockImplementation(async (sql: string) => ({
		rows: sql.includes("agent_account")
			? [{}]
			: sql.startsWith("select id,turn_status")
				? [{ id: "chat", turn_status: "idle" }]
				: [],
	}));
	await enqueueApiTurn(input);
	expect(mocks.query).toHaveBeenCalledWith(
		expect.stringContaining("agent_account"),
		["owner"],
	);
	expect(mocks.query).not.toHaveBeenCalledWith(
		expect.stringContaining("select id from model_connection"),
		expect.anything(),
	);
	expect(mocks.query).toHaveBeenCalledWith(
		expect.stringContaining("set harness=$5"),
		["chat", "owner", "model", "[]", "codex"],
	);
	expect(mocks.release).toHaveBeenCalled();
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

it("only continues completed compatible tool history", async () => {
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
	expect(
		await previousTurnMessages("owner", "chat", "other", input.revision),
	).toBeNull();
	mocks.query.mockResolvedValue({ rows: [{ ...previous, state: "failed" }] });
	expect(
		await previousTurnMessages("owner", "chat", "model", input.revision),
	).toBeNull();
});
