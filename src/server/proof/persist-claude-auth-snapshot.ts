import { Effect } from "effect";
import type { WorkspaceId } from "#/domain/ids";
import { snapshotAuthenticatedClaudeWorkspace } from "#/server/adapters/claude/login-session";
import {
	loadHarnessSnapshotId,
	saveConnectedAgentAccount,
} from "#/server/auth/agent-account";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

export type PersistClaudeAuthSnapshotResult =
	| { readonly kind: "existing"; readonly snapshotId: string }
	| { readonly kind: "created"; readonly snapshotId: string }
	| { readonly kind: "failed"; readonly message: string };

/**
 * Captures a private Claude snapshot into the signed-in user's agent_account.
 * Later chats copy this disk instead of starting Anthropic again.
 */
export function persistClaudeAuthSnapshotForUser(
	userId: string,
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	account: { readonly planType: string | null; readonly email?: string | null },
): Effect.Effect<PersistClaudeAuthSnapshotResult> {
	return Effect.gen(function* () {
		const existingId = yield* Effect.tryPromise(() =>
			loadHarnessSnapshotId(userId, "claude"),
		);
		if (existingId) {
			return { kind: "existing" as const, snapshotId: existingId };
		}
		const snapshot = yield* snapshotAuthenticatedClaudeWorkspace(
			machines,
			workspaceId,
		);
		if (!snapshot.ok) {
			return { kind: "failed" as const, message: snapshot.message };
		}
		yield* Effect.tryPromise(() =>
			saveConnectedAgentAccount(userId, {
				provider: "claude",
				snapshotId: snapshot.snapshotId,
				planType: account.planType,
				email: account.email ?? null,
			}),
		);
		return { kind: "created" as const, snapshotId: snapshot.snapshotId };
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				kind: "failed" as const,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		),
	);
}
