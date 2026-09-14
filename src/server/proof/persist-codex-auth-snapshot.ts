import { Effect } from "effect";
import { AuthSnapshotId, type WorkspaceId } from "#/domain/ids";
import { snapshotAuthenticatedCodexWorkspace } from "#/server/adapters/codex/login-session";
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

function captureAndStore(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	kind: "created" | "replaced",
): Effect.Effect<PersistCodexAuthSnapshotResult> {
	return Effect.gen(function* () {
		const snapshot = yield* snapshotAuthenticatedCodexWorkspace(
			machines,
			workspaceId,
		);
		if (!snapshot.ok) {
			return { kind: "failed" as const, message: snapshot.message };
		}
		const record = snapshotRecord(snapshot.snapshotId, workspaceId);
		yield* Effect.tryPromise(() => writeAuthSnapshotState(record));
		return { kind, snapshot: record };
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				kind: "failed" as const,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		),
	);
}
