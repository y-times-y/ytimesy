import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { codexRuntimeForSession } from "./codex-runtime";
import type { WorkspaceMachines } from "./workspace-machines";

describe("Codex runtime selection", () => {
	const session = { userId: "owner", id: "chat", providerRef: "executor" };
	it("does not provision a runner during reads", async () => {
		const runtime = {
			machines: {} as WorkspaceMachines,
			workspaceId: WorkspaceId("runner"),
			root: "/durable/chat",
		};
		const codexRuntime = vi.fn(async () => runtime);
		const base = { codexRuntime } as unknown as WorkspaceMachines;
		expect(await codexRuntimeForSession(base, session)).toBe(runtime);
		expect(codexRuntime).toHaveBeenCalledWith({
			userId: "owner",
			sessionId: "chat",
			executorId: "executor",
			executorMachines: base,
			provision: false,
		});
	});
	it("propagates runner preparation errors rather than silently reverting to VM execution", async () => {
		const base = {
			codexRuntime: vi.fn(async () => {
				throw new Error("ownership rejected");
			}),
		} as unknown as WorkspaceMachines;
		await expect(codexRuntimeForSession(base, session, true)).rejects.toThrow(
			"ownership rejected",
		);
	});
});
