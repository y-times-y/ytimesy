import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	toRelease: vi.fn(),
	marked: vi.fn(async () => undefined),
	held: vi.fn(),
}));
vi.mock("../adapters/archive", () => ({
	archivedChatsToRelease: mocks.toRelease,
	markMachineReleased: mocks.marked,
	expiredArchives: vi.fn(async () => []),
	projectRootChatIds: vi.fn(),
	setChatArchived: vi.fn(),
	setProjectArchived: vi.fn(),
}));
vi.mock("../adapters/agent-sessions", () => ({
	providerRefsHeldOutside: mocks.held,
}));
vi.mock("./agent-session-machine", () => ({
	deleteAgentSessionMachine: vi.fn(),
}));
vi.mock("./cancel-server-turn", () => ({ cancelServerTurn: vi.fn() }));
vi.mock("./projects", () => ({ removeProjectMachine: vi.fn() }));

import { releaseArchivedMachines } from "./archive";

const chat = (id: string, providerRef: string) => ({
	id,
	userId: "user",
	providerRef,
});

describe("releaseArchivedMachines", () => {
	beforeEach(() => {
		mocks.toRelease.mockReset();
		mocks.marked.mockClear();
		mocks.held.mockReset();
		mocks.held.mockResolvedValue(new Set());
	});

	it("destroys the machine of a checkpointed archived chat and marks it done", async () => {
		mocks.toRelease.mockResolvedValue([chat("c1", "vm-1")]);
		const destroy = vi.fn(async () => undefined);
		expect(await releaseArchivedMachines({ destroy })).toBe(1);
		expect(destroy).toHaveBeenCalledWith("vm-1");
		expect(mocks.marked).toHaveBeenCalledWith("user", "c1");
	});

	it("never destroys a machine another chat still holds, but still marks the chat", async () => {
		mocks.toRelease.mockResolvedValue([chat("c1", "vm-shared")]);
		mocks.held.mockResolvedValue(new Set(["vm-shared"]));
		const destroy = vi.fn(async () => undefined);
		await releaseArchivedMachines({ destroy });
		expect(destroy).not.toHaveBeenCalled();
		expect(mocks.marked).toHaveBeenCalledWith("user", "c1");
	});

	it("leaves a chat unmarked when the destroy fails, so the next run retries it", async () => {
		mocks.toRelease.mockResolvedValue([chat("c1", "vm-1"), chat("c2", "vm-2")]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const destroy = vi
			.fn<(id: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error("provider down"))
			.mockResolvedValueOnce(undefined);
		expect(await releaseArchivedMachines({ destroy })).toBe(1);
		expect(mocks.marked).toHaveBeenCalledTimes(1);
		expect(mocks.marked).toHaveBeenCalledWith("user", "c2");
		warn.mockRestore();
	});
});
