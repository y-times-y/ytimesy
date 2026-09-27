import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { reconcileCodexRefreshRequests } from "./codex-refresh-reconciliation";
import type { WorkspaceMachines } from "./workspace-machines";

describe("Codex refresh reconciliation", () => {
	it("services a running shared child in its own session scope", async () => {
		const machines = {
			exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
			readTextFile: vi.fn(async () => null),
		} as unknown as WorkspaceMachines;
		const service = vi.fn(async (selected: WorkspaceMachines) => {
			await selected.readTextFile(
				WorkspaceId("vm-1"),
				"/tmp/ytimesy-codex-refresh-request.json",
			);
		});
		const result = await reconcileCodexRefreshRequests(machines, {
			list: async () => [
				{
					id: "child-1",
					userId: "user-1",
					providerRef: "vm-1",
					taskPlacement: "shared",
				},
			],
			service,
		});
		expect(result).toEqual({ observed: 1, failed: 0 });
		expect(machines.readTextFile).toHaveBeenCalledWith(
			WorkspaceId("vm-1"),
			"/tmp/ytimesy-sessions/child-1/ytimesy-codex-refresh-request.json",
		);
	});
});
