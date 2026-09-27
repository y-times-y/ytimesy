import { Effect } from "effect";
import {
	decryptSecret,
	encryptSecret,
	secretHint,
} from "#/domain/encrypted-secret";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
import {
	agentSecretsEnvFile,
	agentSecretsEnvPath,
	type PublicProjectSecret,
	parseProjectSecretName,
	parseProjectSecretValue,
} from "#/domain/project-secret";
import {
	deleteProjectSecretForOwner,
	listProjectSecretsForOwner,
	loadProjectSecretsForOwner,
	saveProjectSecretForOwner,
} from "#/server/adapters/project-secrets";
import { projectForOwner } from "#/server/adapters/projects";
import { loadSecretMasterKey } from "#/server/secrets/master-key";
import type { WorkspaceMachines } from "./workspace-machines";

export async function listVisibleProjectSecrets(
	userId: string,
	projectId: string,
): Promise<readonly PublicProjectSecret[]> {
	if (!(await projectForOwner(userId, projectId))) {
		throw new Error("Project is not available.");
	}
	return listProjectSecretsForOwner(userId, projectId);
}

export async function saveVisibleProjectSecret(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly name: string;
	readonly value: string;
}): Promise<PublicProjectSecret> {
	if (!(await projectForOwner(input.userId, input.projectId))) {
		throw new Error("Project is not available.");
	}
	const name = parseProjectSecretName(input.name);
	const value = parseProjectSecretValue(input.value);
	const masterKey = await loadSecretMasterKey();
	return saveProjectSecretForOwner({
		userId: input.userId,
		projectId: input.projectId,
		name,
		hint: secretHint(value),
		encrypted: encryptSecret(masterKey, value),
	});
}

export async function removeVisibleProjectSecret(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly secretId: string;
}): Promise<void> {
	if (!(await projectForOwner(input.userId, input.projectId))) {
		throw new Error("Project is not available.");
	}
	await deleteProjectSecretForOwner(input);
}

export function injectProjectSecrets(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	scope: { readonly userId: string; readonly projectId?: string },
): Effect.Effect<readonly string[]> {
	return Effect.tryPromise(async () => {
		if (!scope.projectId) return [];
		const environment = await loadProjectSecretEnvironment(
			scope.userId,
			scope.projectId,
		);
		const secrets = Object.entries(environment).map(([name, value]) => ({
			name,
			value,
		}));
		const home = await guestHome(machines, workspaceId);
		const path = agentSecretsEnvPath(home);
		await machines.writeTextFile(
			workspaceId,
			path,
			agentSecretsEnvFile(secrets),
		);
		await machines.exec(
			workspaceId,
			`chmod 600 ${posixShellQuoted(path)}`,
			10_000,
		);
		return secrets.map((secret) => secret.name);
	}).pipe(Effect.catchAll(() => Effect.succeed([])));
}

export async function loadProjectSecretEnvironment(
	userId: string,
	projectId: string,
	names?: readonly string[],
): Promise<Record<string, string>> {
	if (!(await projectForOwner(userId, projectId)))
		throw new Error("Project is not available.");
	const stored = await loadProjectSecretsForOwner(userId, projectId);
	if (names?.some((name) => !stored.some((secret) => secret.name === name)))
		throw new Error(
			"A required build secret is missing. Add it in project settings.",
		);
	const selected = names
		? stored.filter((secret) => names.includes(secret.name))
		: stored;
	if (!selected.length) return {};
	const masterKey = await loadSecretMasterKey();
	return Object.fromEntries(
		selected.map((secret) => [
			secret.name,
			decryptSecret(masterKey, secret.encrypted),
		]),
	);
}

async function guestHome(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
) {
	try {
		const result = await machines.exec(
			workspaceId,
			`printf '%s' "\${HOME:-/home/ubuntu}"`,
			15_000,
		);
		return result.stdout.trim() || "/home/ubuntu";
	} catch {
		return "/home/ubuntu";
	}
}
