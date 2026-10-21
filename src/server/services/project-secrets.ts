import {
	decryptSecret,
	encryptSecret,
	secretHint,
} from "#/domain/encrypted-secret";
import type { WorkspaceId } from "#/domain/ids";
import {
	posixShellQuoted,
	privateDirectoryShell,
} from "#/domain/posix-command";
import {
	AGENT_SECRETS_DIRECTORY,
	AGENT_SECRETS_ENV_PATH,
	type AgentSecretName,
	agentSecretsEnvFile,
	PROJECT_SECRETS_PREPARATION_FAILED,
	type PublicProjectSecret,
	parseProjectSecretKind,
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
	readonly kind: unknown;
}): Promise<PublicProjectSecret> {
	if (!(await projectForOwner(input.userId, input.projectId))) {
		throw new Error("Project is not available.");
	}
	const name = parseProjectSecretName(input.name);
	const kind = parseProjectSecretKind(input.kind);
	const value = parseProjectSecretValue(input.value, kind);
	const masterKey = await loadSecretMasterKey();
	return saveProjectSecretForOwner({
		userId: input.userId,
		projectId: input.projectId,
		name,
		kind,
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

/** The VM env file contents and the runtime values to redact, for one turn. */
export type AgentProjectSecrets = {
	readonly envFile: string;
	readonly redact: readonly string[];
	/** Every configured secret's name and kind, for the agent; never a value. */
	readonly names: readonly AgentSecretName[];
};

export async function loadAgentProjectSecrets(
	userId: string,
	projectId: string,
): Promise<AgentProjectSecrets> {
	const all = await loadProjectSecretsForOwner(userId, projectId);
	const names = all.map(({ name, kind }) => ({ name, kind }));
	const stored = all.filter((secret) => secret.kind !== "build");
	if (!stored.length)
		return { envFile: agentSecretsEnvFile([]), redact: [], names };
	const masterKey = await loadSecretMasterKey();
	const secrets = stored.map((secret) => ({
		name: secret.name,
		kind: secret.kind,
		value: decryptSecret(masterKey, secret.encrypted),
	}));
	return {
		envFile: agentSecretsEnvFile(secrets),
		redact: secrets
			.filter((secret) => secret.kind === "runtime")
			.map((secret) => secret.value),
		names,
	};
}

/**
 * Rewrites the VM's env file every turn (empty when the project has none), so
 * a removed or changed secret never outlives the next turn.
 */
export async function writeAgentProjectSecrets(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
	secrets: AgentProjectSecrets,
) {
	const prepared = await machines.exec(
		vm,
		privateDirectoryShell(AGENT_SECRETS_DIRECTORY),
		10_000,
	);
	if (prepared.exitCode) throw new Error(PROJECT_SECRETS_PREPARATION_FAILED);
	await machines.writeTextFile(vm, AGENT_SECRETS_ENV_PATH, secrets.envFile);
	await machines.exec(
		vm,
		`chmod 600 ${posixShellQuoted(AGENT_SECRETS_ENV_PATH)}`,
		10_000,
	);
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
	// Setup receives every build secret, plus any secret the recipe names.
	const selected = names
		? stored.filter(
				(secret) => secret.kind === "build" || names.includes(secret.name),
			)
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
