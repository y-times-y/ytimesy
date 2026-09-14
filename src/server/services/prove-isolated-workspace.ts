import { Effect } from "effect";
import {
	CodexAppServer,
	type IsolatedWorkspaceProof,
	WorkspaceMachineService,
} from "./capabilities";
import { WorkspaceProvisionError } from "./errors";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Boots a throwaway Freestyle VM, checks the guest, and starts Codex ChatGPT
 * device-code login through app-server. The VM is deleted before this effect
 * completes, including on failure. A pending device code is not treated as an
 * authenticated session, and turn/start is not sent.
 */
export const proveIsolatedWorkspace: Effect.Effect<
	IsolatedWorkspaceProof,
	WorkspaceProvisionError,
	WorkspaceMachineService | CodexAppServer
> = Effect.scoped(
	Effect.gen(function* () {
		const machines = yield* WorkspaceMachineService;
		const codex = yield* CodexAppServer;
		const workspace = yield* tryWorkspace(
			() => machines.createProofWorkspace(),
			"create",
		);

		yield* Effect.addFinalizer(() =>
			tryWorkspace(
				() => machines.destroy(workspace.workspaceId),
				"destroy",
				workspace.workspaceId,
			).pipe(Effect.catchAll((error) => Effect.logError(error.message))),
		);

		const uname = yield* guestCommand(
			machines,
			workspace.workspaceId,
			"uname -a",
		);
		const python = yield* guestCommand(
			machines,
			workspace.workspaceId,
			"python3 --version",
		);
		const agent = yield* codex.installAndProbeDeviceCode(workspace.workspaceId);

		return {
			workspace,
			guest: {
				uname: uname.stdout.trim() || uname.stderr.trim(),
				python:
					python.exitCode === 0
						? python.stdout.trim() || python.stderr.trim()
						: null,
			},
			agent: {
				connection: agent.connection,
				codexVersion: agent.codexVersion,
				notes: agent.notes,
			},
		} satisfies IsolatedWorkspaceProof;
	}),
);

function tryWorkspace<A>(
	run: () => Promise<A>,
	operation: "create" | "destroy",
	providerWorkspaceId?: string,
) {
	return Effect.tryPromise({
		try: run,
		catch: (cause) =>
			cause instanceof WorkspaceProvisionError
				? cause
				: new WorkspaceProvisionError({
						operation,
						message: cause instanceof Error ? cause.message : String(cause),
						providerWorkspaceId,
					}),
	});
}

function guestCommand(
	machines: WorkspaceMachines,
	workspaceId: IsolatedWorkspaceProof["workspace"]["workspaceId"],
	command: string,
) {
	return Effect.tryPromise({
		try: () => machines.exec(workspaceId, command, 30_000),
		catch: (cause) =>
			new WorkspaceProvisionError({
				operation: "create",
				message: cause instanceof Error ? cause.message : String(cause),
				providerWorkspaceId: workspaceId,
			}),
	});
}
