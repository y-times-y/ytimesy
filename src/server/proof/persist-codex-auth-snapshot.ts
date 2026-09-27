import { Effect } from "effect";
import { AuthSnapshotId, type WorkspaceId } from "#/domain/ids";
import { snapshotAuthenticatedCodexWorkspace } from "#/server/adapters/codex/login-session";
import {
	loadAgentSnapshotId,
	saveConnectedAgentAccount,
} from "#/server/auth/agent-account";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import {
	type ProofAuthSnapshotState,
	readAuthSnapshotState,
	writeAuthSnapshotState,
} from "./codex-login-state";

export type PersistCodexAuthSnapshotResult =
	| { readonly kind: "existing"; readonly snapshot: ProofAuthSnapshotState }
	| { readonly kind: "created"; readonly snapshot: ProofAuthSnapshotState }
	| { readonly kind: "replaced"; readonly snapshot: ProofAuthSnapshotState }
	| { readonly kind: "failed"; readonly message: string };

function snapshotRecord(
	snapshotId: string,
	sourceWorkspaceId: WorkspaceId,
): ProofAuthSnapshotState {
	return {
		snapshotId,
		sourceWorkspaceId,
		createdAt: new Date().toISOString(),
		public: false,
	};
}

export function persistCodexAuthSnapshotIfMissing(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<PersistCodexAuthSnapshotResult> {
	return Effect.gen(function* () {
		const existing = yield* Effect.tryPromise(() => readAuthSnapshotState());
		if (existing) {
			return { kind: "existing" as const, snapshot: existing };
		}
		return yield* captureAndStore(machines, workspaceId, "created");
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				kind: "failed" as const,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		),
	);
}

/**
 * Captures a private Codex snapshot into the signed-in user's agent_account.
 * Does not write the shared CLI file under `.ytimesy/`.
 */
export function persistCodexAuthSnapshotForUser(
	userId: string,
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	account: { readonly planType: string | null; readonly email?: string | null },
): Effect.Effect<PersistCodexAuthSnapshotResult> {
	return Effect.gen(function* () {
		const existingId = yield* Effect.tryPromise(() =>
			loadAgentSnapshotId(userId),
		);
		if (existingId) {
			return {
				kind: "existing" as const,
				snapshot: snapshotRecord(existingId, workspaceId),
			};
		}
		const snapshot = yield* captureSnapshot(machines, workspaceId);
		if (snapshot.kind === "failed") return snapshot;
		yield* Effect.tryPromise(() =>
			saveConnectedAgentAccount(userId, {
				provider: "codex",
				snapshotId: snapshot.snapshot.snapshotId,
				planType: account.planType,
				email: account.email ?? null,
			}),
		);
		return snapshot;
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				kind: "failed" as const,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		),
	);
}

export function refreshCodexAuthSnapshotForUser(
	userId: string,
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	account: { readonly planType: string | null; readonly email?: string | null },
): Effect.Effect<PersistCodexAuthSnapshotResult> {
	return Effect.gen(function* () {
		const captured = yield* captureSnapshot(machines, workspaceId);
		if (captured.kind === "failed") return captured;
		yield* Effect.tryPromise(() =>
			saveConnectedAgentAccount(userId, {
				provider: "codex",
				snapshotId: captured.snapshot.snapshotId,
				planType: account.planType,
				email: account.email ?? null,
			}),
		);
		return { kind: "replaced" as const, snapshot: captured.snapshot };
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				kind: "failed" as const,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		),
	);
}

export function replaceCodexAuthSnapshot(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<PersistCodexAuthSnapshotResult> {
	return Effect.gen(function* () {
		const previous = yield* Effect.tryPromise(() => readAuthSnapshotState());
		const captured = yield* captureAndStore(machines, workspaceId, "replaced");
		if (
			captured.kind === "replaced" &&
			previous &&
			previous.snapshotId !== captured.snapshot.snapshotId
		) {
			yield* Effect.tryPromise(() =>
				machines.destroySnapshot(AuthSnapshotId(previous.snapshotId)),
			).pipe(Effect.catchAll(() => Effect.void));
		}
		return captured;
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				kind: "failed" as const,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		),
	);
}

function captureSnapshot(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<PersistCodexAuthSnapshotResult> {
	return Effect.gen(function* () {
		const snapshot = yield* snapshotAuthenticatedCodexWorkspace(
			machines,
			workspaceId,
		);
		if (!snapshot.ok) {
			return { kind: "failed" as const, message: snapshot.message };
		}
		return {
			kind: "created" as const,
			snapshot: snapshotRecord(snapshot.snapshotId, workspaceId),
		};
	});
}

function captureAndStore(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	kind: "created" | "replaced",
): Effect.Effect<PersistCodexAuthSnapshotResult> {
	return Effect.gen(function* () {
		const snapshot = yield* captureSnapshot(machines, workspaceId);
		if (snapshot.kind === "failed") return snapshot;
		yield* Effect.tryPromise(() => writeAuthSnapshotState(snapshot.snapshot));
		return { kind, snapshot: snapshot.snapshot };
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				kind: "failed" as const,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		),
	);
}
