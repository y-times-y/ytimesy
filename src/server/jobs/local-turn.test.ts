import { beforeEach, expect, it, vi } from "vitest";
import { refusingWorkspaceMachines, runQueuedLocalTurn } from "./local-turn";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	run: vi.fn(async () => "completed"),
}));
vi.mock("../adapters/api-turns", () => ({ claimApiTurn: mocks.claim }));
vi.mock("../adapters/agent-capacity", () => ({
	modelConcurrencyLimits: () => ({ fleet: 50 }),
}));
vi.mock("./api-turn", () => ({ runApiTurn: mocks.run }));

beforeEach(() => vi.clearAllMocks());

it("refuses every machine call, naming it, and is not a thenable", async () => {
	const machines = refusingWorkspaceMachines("Y² has no machine.");
	await expect(
		machines.provisionSession("slug", "snap", "large" as never),
	).rejects.toThrow("Y² has no machine. (provisionSession)");
	expect((machines as unknown as { then?: unknown }).then).toBeUndefined();
	await expect(Promise.resolve(machines)).resolves.toBe(machines);
});

it("claims the chat's own queued node turn and runs it without machines", async () => {
	const turn = { id: "turn", session_id: "chat" };
	mocks.claim.mockResolvedValue(turn);
	expect(await runQueuedLocalTurn("chat")).toBe("completed");
	expect(mocks.claim).toHaveBeenCalledWith(2, 50, "node", "chat");
	expect(mocks.run).toHaveBeenCalledWith(expect.anything(), turn);
});

it("leaves a turn another process claimed alone", async () => {
	mocks.claim.mockResolvedValue(null);
	expect(await runQueuedLocalTurn("chat")).toBeNull();
	expect(mocks.run).not.toHaveBeenCalled();
});
