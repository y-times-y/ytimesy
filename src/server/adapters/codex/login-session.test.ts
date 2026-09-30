import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import { ensureCurrentLoginDaemon } from "./login-session";

it("surfaces a failed daemon restart instead of submitting to a dead process", async () => {
	const machines = {
		readTextFile: vi.fn(async () => null),
		writeTextFile: vi.fn(async () => undefined),
		exec: vi.fn(async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "runner unavailable",
		})),
	} as unknown as WorkspaceMachines;
	await expect(
		Effect.runPromise(
			ensureCurrentLoginDaemon(machines, WorkspaceId("runner")),
		),
	).rejects.toThrow();
});
