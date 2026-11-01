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

/**
 * Saves variables a local .env held ("Continue your agent session"), marked
 * imported for review in Settings. A name the user already set in ytimesy is
 * kept as it is; invalid names and values are skipped with the reason.
 */
export async function saveImportedProjectSecrets(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly variables: readonly {
		readonly name: string;
		readonly value: string;
	}[];
}) {
	if (!(await projectForOwner(input.userId, input.projectId))) {
		throw new Error("Project is not available.");
	}
	const existing = await listProjectSecretsForOwner(
		input.userId,
		input.projectId,
	);
	const kept = new Set(
		existing.filter((secret) => !secret.imported).map((secret) => secret.name),
	);
	const saved: string[] = [];
	const skipped: { name: string; reason: string }[] = [];
	const masterKey = input.variables.length ? await loadSecretMasterKey() : null;
	for (const variable of input.variables) {
		let name: string;
		let value: string;
		try {
			name = parseProjectSecretName(variable.name);
			// Runtime secrets are redacted from what the agent sees; values too
			// short to redact safely become plain environment variables.
			const kind =
				variable.value.trim().length >= 6 ? "runtime" : "environment";
			value = parseProjectSecretValue(variable.value, kind);
			if (kept.has(name)) {
				skipped.push({ name, reason: "Already set in ytimesy." });
				continue;
			}
			await saveProjectSecretForOwner({
				userId: input.userId,
				projectId: input.projectId,
				name,
				kind,
				hint: secretHint(value),
				encrypted: encryptSecret(masterKey as Uint8Array, value),
				imported: true,
			});
			saved.push(name);
		} catch (error) {
			skipped.push({
				name: variable.name.slice(0, 128),
				reason: error instanceof Error ? error.message : "Not saved.",
			});
		}
	}
	return { saved, skipped };
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
	// The provider writes files as root, while commands run as the default
	// user; a file only root can read was skipped silently by every command.
	const owned = await machines.exec(vm, agentSecretsOwnershipShell(), 10_000);
	if (owned.exitCode) throw new Error(PROJECT_SECRETS_PREPARATION_FAILED);
}

/** Hands the env file to the command user (0600) and proves it can read it. */
export function agentSecretsOwnershipShell() {
	const file = posixShellQuoted(AGENT_SECRETS_ENV_PATH);
	return `{ [ -O ${file} ] || sudo -n chown "$(id -u):$(id -g)" ${file}; } && chmod 600 ${file} && [ -r ${file} ]`;
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
