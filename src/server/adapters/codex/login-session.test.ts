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

it("defers runtime upgrades while a native turn is running", async () => {
	const machines = {
		readTextFile: vi.fn(async (_id, path: string) =>
			path.endsWith(".hash")
				? "old-runtime-fingerprint"
				: JSON.stringify({ stage: "authenticated", turnStatus: "running" }),
		),
		writeTextFile: vi.fn(),
		exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
	} as unknown as WorkspaceMachines;
	await Effect.runPromise(
		ensureCurrentLoginDaemon(machines, WorkspaceId("runner")),
	);
	expect(machines.exec).toHaveBeenCalledTimes(1);
	expect(machines.writeTextFile).not.toHaveBeenCalled();
});
