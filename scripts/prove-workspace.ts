import { Effect, Exit, Layer } from "effect";
import { CodexAppServerLive } from "#/server/adapters/codex/live";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import type { IsolatedWorkspaceProof } from "#/server/services/capabilities";
import { proveIsolatedWorkspace } from "#/server/services/prove-isolated-workspace";

const IntegrationProofLive = Layer.provideMerge(
	CodexAppServerLive,
	FreestyleWorkspaceMachinesLive,
);

function publicProof(proof: IsolatedWorkspaceProof) {
	const { connection } = proof.agent;
	if (connection.status === "awaiting_device_code") {
		return {
			workspace: {
				id: proof.workspace.workspaceId,
				state: proof.workspace.state,
				slug: proof.workspace.slug,
			},
			guest: proof.guest,
			agent: {
				status: connection.status,
				verificationUrl: connection.verificationUrl,
				loginIdPresent: Boolean(connection.loginId),
				userCodeLength: connection.userCode.length,
				codexVersion: proof.agent.codexVersion,
				notes: proof.agent.notes,
			},
		};
	}

	return {
		workspace: {
			id: proof.workspace.workspaceId,
			state: proof.workspace.state,
			slug: proof.workspace.slug,
		},
		guest: proof.guest,
		agent: {
			status: connection.status,
			codexVersion: proof.agent.codexVersion,
			notes: proof.agent.notes,
			message: "message" in connection ? connection.message : undefined,
			authMode: "authMode" in connection ? connection.authMode : undefined,
			planType: "planType" in connection ? connection.planType : undefined,
		},
	};
}

const exit = await Effect.runPromiseExit(
	proveIsolatedWorkspace.pipe(Effect.provide(IntegrationProofLive)),
);

if (Exit.isSuccess(exit)) {
	console.log(JSON.stringify(publicProof(exit.value), null, 2));
	process.exit(0);
}

console.error(String(exit.cause));
process.exit(1);
