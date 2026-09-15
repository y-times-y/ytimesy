import { Effect } from "effect";
import { sharedDesktopDeveloperInstructions } from "#/domain/agent-desktop";
import { failureMessage } from "#/domain/failure-message";
import type { WorkspaceId } from "#/domain/ids";
import {
	type ProjectCheckout,
	projectCheckoutFromFullName,
	projectCheckoutPath,
} from "#/domain/project-checkout";
import {
	cloneSelectedProjectScript,
	DEVELOPER_INSTRUCTIONS_PATH,
	PROJECT_CONTEXT_PATH,
	PROJECT_CWD_PATH,
	PROJECT_TOKEN_PATH,
	preparedCheckoutExistsCommand,
	redactInstallationToken,
} from "#/server/adapters/freestyle/clone-project";
import { githubInstallationAccessToken } from "#/server/adapters/github/installation-token";
import { listProjects, projectForOwner } from "#/server/adapters/projects";
import type { DesktopScope } from "./workspace-desktop";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Clones the GitHub repo into the guest home and writes the agent cwd file.
 * Installation tokens are written to a temp file on the VM and deleted during
 * the clone; they are never stored in git remotes.
 */
export function ensureProjectCheckout(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	checkout: ProjectCheckout | null,
): Effect.Effect<string | null, Error> {
	return Effect.gen(function* () {
		if (!checkout) {
			const home = yield* guestHome(machines, workspaceId);
			yield* writeDeveloperInstructions(machines, workspaceId, home);
			return null;
		}
		const home = yield* guestHome(machines, workspaceId);
		const destination = projectCheckoutPath(home, checkout.name);
		const existing = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				preparedCheckoutExistsCommand(destination),
				15_000,
			),
		);
		if (existing.stdout.includes("present")) {
			yield* Effect.tryPromise(() =>
				machines.writeTextFile(
					workspaceId,
					PROJECT_CWD_PATH,
					`${destination}\n`,
				),
			);
			yield* writeDeveloperInstructions(machines, workspaceId, destination);
			return destination;
		}
		const token = yield* Effect.tryPromise(() =>
			githubInstallationAccessToken(checkout.installationId),
		);
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
			`${sharedDesktopDeveloperInstructions({ cwd })} If ${PROJECT_CONTEXT_PATH} exists, treat it as this project's shared briefing and sibling traces.\n`,
		),
	).pipe(Effect.catchAll(() => Effect.void));
}

/**
 * Clone uses the signed-in owner's Postgres project, not the leftover
 * `.ytimesy/selected-project.json` GitHub picker.
 */
export function loadTenantProjectCheckout(scope: {
	readonly userId: string;
	readonly projectId?: string;
}): Effect.Effect<ProjectCheckout | null> {
	return Effect.tryPromise(async () => {
		const project = scope.projectId
			? await projectForOwner(scope.userId, scope.projectId)
			: ((await listProjects(scope.userId))[0] ?? null);
		if (!project) return null;
		return projectCheckoutFromFullName({
			fullName: project.fullName,
			branch: project.branch,
			installationId: project.installationId,
		});
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

export function preparePreparedGuest(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	scope: DesktopScope,
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const checkout = yield* loadTenantProjectCheckout(scope);
		yield* ensureProjectCheckout(machines, workspaceId, checkout);
	});
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
