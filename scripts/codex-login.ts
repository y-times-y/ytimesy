import { Effect, Exit } from "effect";
import {
	resumeCodexSession,
	startInteractiveDeviceCodeLogin,
} from "#/server/adapters/codex/login-session";
import { publicLoginStatus } from "#/server/adapters/codex/login-status";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { PROOF_LOGIN_LIFETIME } from "#/server/adapters/freestyle/proof-vm";
import {
	readAuthSnapshotState,
	writeProofVmState,
} from "#/server/proof/codex-login-state";
import { persistCodexAuthSnapshotIfMissing } from "#/server/proof/persist-codex-auth-snapshot";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import type { ProofWorkspace } from "#/server/services/workspace-machines";

const program = Effect.gen(function* () {
	const machines = yield* WorkspaceMachineService;
	const storedSnapshot = yield* Effect.tryPromise(() =>
		readAuthSnapshotState(),
	);

	let workspace: ProofWorkspace;
	let usedSnapshotId: string | null = null;
	if (storedSnapshot) {
		const fromSnapshot = yield* Effect.either(
			Effect.tryPromise(() =>
				machines.createProofWorkspace({
					...PROOF_LOGIN_LIFETIME,
					snapshotId: storedSnapshot.snapshotId,
				}),
			),
		);
		if (fromSnapshot._tag === "Right") {
			workspace = fromSnapshot.right;
			usedSnapshotId = storedSnapshot.snapshotId;
		} else {
			workspace = yield* Effect.tryPromise(() =>
				machines.createProofWorkspace(PROOF_LOGIN_LIFETIME),
			);
		}
	} else {
		workspace = yield* Effect.tryPromise(() =>
			machines.createProofWorkspace(PROOF_LOGIN_LIFETIME),
		);
	}

	let status = usedSnapshotId
		? yield* resumeCodexSession(machines, workspace.workspaceId)
		: yield* startInteractiveDeviceCodeLogin(machines, workspace.workspaceId);

	if (usedSnapshotId && status.stage === "failed") {
		status = yield* startInteractiveDeviceCodeLogin(
			machines,
			workspace.workspaceId,
		);
	}

	yield* Effect.tryPromise(() =>
		writeProofVmState({
			workspaceId: workspace.workspaceId,
			slug: workspace.slug,
			startedAt: new Date().toISOString(),
			bootedFromSnapshotId: usedSnapshotId ?? workspace.bootedFromSnapshotId,
		}),
	);

	const snapshot =
		status.stage === "authenticated"
			? yield* persistCodexAuthSnapshotIfMissing(
					machines,
					workspace.workspaceId,
				)
			: null;

	return {
		workspace: {
			id: workspace.workspaceId,
			slug: workspace.slug,
			state: workspace.state,
			bootedFromSnapshotId: usedSnapshotId ?? workspace.bootedFromSnapshotId,
		},
		login: publicLoginStatus(status),
		snapshot,
	};
});

const exit = await Effect.runPromiseExit(
	program.pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
);

if (Exit.isSuccess(exit)) {
	console.log(JSON.stringify(exit.value, null, 2));
	if (exit.value.login.stage === "awaiting_device_code") {
		console.log("\n========================================");
		console.log("CODEX LOGIN REQUIRED");
		console.log(`Open: ${exit.value.login.verificationUrl}`);
		console.log(`Code: ${exit.value.login.userCode}`);
		console.log("========================================\n");
		console.log("After authorizing, run: pnpm prove:codex-login:status");
		console.log(
			"That command snapshots the VM so later boots skip ChatGPT login.",
		);
	}
	process.exit(0);
}

console.error(String(exit.cause));
process.exit(1);
