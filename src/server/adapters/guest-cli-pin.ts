import { Effect } from "effect";
import { guestCliPinSealScript } from "#/domain/guest-cli-pin";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

export function ensureGuestCliPin(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<void> {
	return Effect.tryPromise(() =>
		machines.exec(
			workspaceId,
			`bash -lc ${posixShellQuoted(guestCliPinSealScript())}`,
			15_000,
		),
	).pipe(
		Effect.as(undefined),
		Effect.catchAll(() => Effect.void),
	);
}
