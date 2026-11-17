import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	noteUserHub: vi.fn(),
	noteCrewWaiting: vi.fn(),
	projectYMode: vi.fn(async () => ({ enabled: true })),
	harnessVariantForUser: vi.fn(async () => "variant"),
}));
vi.mock("../adapters/y-squared-crew-client", () => ({
	noteCrewWaiting: mocks.noteCrewWaiting,
}));
vi.mock("../adapters/user-hub-notes", () => ({
	noteUserHub: mocks.noteUserHub,
}));
// A partial module mock, as the api-turn suites use: members the mock lacks
// must not be touched until they are called.
vi.mock("../adapters/y-mode", () => ({ projectYMode: mocks.projectYMode }));
vi.mock("../adapters/dev-eval-users", () => ({
	harnessVariantForUser: mocks.harnessVariantForUser,
}));

import { localTurnPorts } from "./turn-ports-local";

describe("localTurnPorts (the Durable Object's ports)", () => {
	it("calls the very modules runApiTurn used to import, with the same arguments and results", async () => {
		localTurnPorts.noteUserHub("u1", ["a", "b"]);
		expect(mocks.noteUserHub).toHaveBeenCalledWith("u1", ["a", "b"]);
		const hint = {
			sessionId: "s",
			userId: "u1",
			projectId: "p1",
			ySquaredId: null,
			waitingOn: "question",
		};
		localTurnPorts.noteCrewWaiting(hint);
		expect(mocks.noteCrewWaiting).toHaveBeenCalledWith(hint);
		await expect(localTurnPorts.projectYMode("u1", "p1")).resolves.toEqual({
			enabled: true,
		});
		expect(mocks.projectYMode).toHaveBeenCalledWith("u1", "p1");
		await expect(localTurnPorts.harnessVariantForUser("u1")).resolves.toBe(
			"variant",
		);
	});

	it("looks a function up when it is called, not when the ports are built", async () => {
		// Replacing the module's function after construction is seen (a test's spy).
		mocks.projectYMode.mockResolvedValueOnce({ enabled: false });
		await expect(localTurnPorts.projectYMode("u2", "p2")).resolves.toEqual({
			enabled: false,
		});
	});

	it("has no model access override: the Durable Object holds the key", () => {
		expect(localTurnPorts.modelAccess).toBeUndefined();
	});
});
