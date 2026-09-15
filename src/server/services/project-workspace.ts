import { Effect } from "effect";
import { sharedDesktopDeveloperInstructions } from "#/domain/agent-desktop";
import { failureMessage } from "#/domain/failure-message";
import type { WorkspaceId } from "#/domain/ids";
import { projectCheckoutPath } from "#/domain/project-checkout";
import {
	cloneSelectedProjectScript,
	DEVELOPER_INSTRUCTIONS_PATH,
	PROJECT_TOKEN_PATH,
	redactInstallationToken,
} from "#/server/adapters/freestyle/clone-project";
import { readGitHubAppCredentials } from "#/server/adapters/github/credentials";
import { liveGitHubProjectDeps, loadProjectCheckout } from "./github-projects";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Clones the selected GitHub repo into the guest home and writes the Codex
 * cwd file. Installation tokens are written to a temp file on the VM and
 * deleted during the clone; they are never stored in git remotes.
 */
export function ensureProjectCheckout(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<string | null, Error> {
	return Effect.gen(function* () {
		const deps = liveGitHubProjectDeps();
		const checkout = yield* loadProjectCheckout(deps);
		if (!checkout) {
			const home = yield* guestHome(machines, workspaceId);
			yield* writeDeveloperInstructions(machines, workspaceId, home);
			return null;
		}
		const credentials = yield* readGitHubAppCredentials(deps.env);
		const token = yield* Effect.tryPromise(() =>
			deps.github.installationToken({
				credentials,
				installationId: checkout.installationId,
			}),
		);
		const home = yield* guestHome(machines, workspaceId);
		const destination = projectCheckoutPath(home, checkout.name);
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(workspaceId, PROJECT_TOKEN_PATH, `${token}\n`),
		);
		const cloned = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				cloneSelectedProjectScript({
					owner: checkout.owner,
					name: checkout.name,
					branch: checkout.branch,
					destination,
				}),
				180_000,
			),
		);
		if (cloned.exitCode !== 0) {
			yield* Effect.tryPromise(() =>
				machines.exec(workspaceId, `rm -f ${PROJECT_TOKEN_PATH}`, 10_000),
			).pipe(Effect.catchAll(() => Effect.void));
			throw new Error(
				`Could not clone ${checkout.fullName}: ${redactInstallationToken((cloned.stderr || cloned.stdout).trim() || "git clone failed.")}`,
			);
		}
		yield* writeDeveloperInstructions(machines, workspaceId, destination);
		return destination;
	}).pipe(Effect.mapError((cause) => new Error(failureMessage(cause))));
}

export function writeDeveloperInstructions(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	cwd: string,
): Effect.Effect<void> {
	return Effect.tryPromise(() =>
		machines.writeTextFile(
			workspaceId,
			DEVELOPER_INSTRUCTIONS_PATH,
			`${sharedDesktopDeveloperInstructions({ cwd })}\n`,
		),
	).pipe(Effect.catchAll(() => Effect.void));
}

function guestHome(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<string> {
	return Effect.tryPromise(() =>
		machines.exec(workspaceId, `printf '%s' "\${HOME:-/home/ubuntu}"`, 15_000),
	).pipe(
		Effect.map((result) => {
			const home = result.stdout.trim();
			return home || "/home/ubuntu";
		}),
		Effect.catchAll(() => Effect.succeed("/home/ubuntu")),
	);
}
