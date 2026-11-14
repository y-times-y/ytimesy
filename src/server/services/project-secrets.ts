import { createHash } from "node:crypto";
import { FreestyleApiError } from "freestyle";
import {
	decryptSecret,
	encryptSecret,
	secretHint,
} from "#/domain/encrypted-secret";
import type { WorkspaceId } from "#/domain/ids";
import {
	findPastedSecrets,
	messageWithSecretsAsVariables,
	type PastedSecret,
} from "#/domain/pasted-secrets";
import {
	posixShellQuoted,
	privateDirectoryShell,
} from "#/domain/posix-command";
import {
	AGENT_SECRETS_DIRECTORY,
	AGENT_SECRETS_ENV_PATH,
	type AgentSecretName,
	agentSecretsEnvFile,
	ProjectSecretsPreparationFailure,
	type PublicProjectSecret,
	parseProjectSecretKind,
	parseProjectSecretName,
	parseProjectSecretValue,
} from "#/domain/project-secret";
import {
	deleteAccountSecret,
	deleteProjectSecretForOwner,
	listAccountSecrets,
	listProjectSecretsForOwner,
	loadAccountSecrets,
	loadProjectSecretsForOwner,
	saveAccountSecret,
	saveProjectSecretForOwner,
} from "#/server/adapters/project-secrets";
import { projectForOwner } from "#/server/adapters/projects";
import { loadSecretMasterKey } from "#/server/secrets/master-key";
import {
	PROVIDER_TIMEOUT_CODE,
	providerTimeoutError,
} from "../adapters/freestyle/bounded-fetch";
import { retryTransientProviderFailure } from "../adapters/freestyle/provider-retry";
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
	const own = await loadProjectSecretsForOwner(userId, projectId);
	const ownNames = new Set(own.map(({ name }) => name));
	const all = [
		...own,
		...(await loadSharedAccountSecrets(userId)).filter(
			({ name }) => !ownNames.has(name),
		),
	];
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
 * Makes the VM's env file hold exactly this turn's secrets (empty when the
 * project has none), so a removed or changed secret never outlives the next
 * turn. The private-directory check also reports the file's SHA-256 when the
 * command user already owns it, alone (0600), and can read it: a file that
 * already holds these exact contents that way is left as it is, saving the
 * write and the ownership round trips on most turns. Any other file is
 * rewritten and handed over as before.
 */
export async function writeAgentProjectSecrets(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
	secrets: AgentProjectSecrets,
) {
	const directory = await prepareAgentSecretsOperation(
		machines,
		vm,
		"directory",
		`${privateDirectoryShell(AGENT_SECRETS_DIRECTORY)}
${agentSecretsDigestShell()}`,
	);
	if (
		agentSecretsDigestFromOutput(directory.stdout) ===
		createHash("sha256").update(secrets.envFile).digest("hex")
	)
		return;
	await machines.writeTextFile(vm, AGENT_SECRETS_ENV_PATH, secrets.envFile);
	// The provider writes files as root, while commands run as the default
	// user; a file only root can read was skipped silently by every command.
	await prepareAgentSecretsOperation(
		machines,
		vm,
		"ownership",
		agentSecretsOwnershipShell(),
	);
}

/**
 * Each retry of a timed-out setup command gets a longer budget: a slow VM
 * (one answered with no exit status after ~18 s) needs more than 10 s, not
 * the same 10 s again.
 */
export const AGENT_SECRETS_SETUP_BUDGETS_MS = [10_000, 30_000, 60_000] as const;

/** Only these fixed, idempotent setup commands may be retried; never user work. */
async function prepareAgentSecretsOperation(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
	phase: "directory" | "ownership",
	command: string,
) {
	let attempt = 0;
	try {
		return await retryTransientProviderFailure(async () => {
			const budgetMs =
				AGENT_SECRETS_SETUP_BUDGETS_MS[
					Math.min(attempt++, AGENT_SECRETS_SETUP_BUDGETS_MS.length - 1)
				];
			const result = await machines.exec(vm, command, budgetMs);
			// The provider adapter maps an absent exit status to 124 as well.
			if (result.exitCode === 124 || !Number.isInteger(result.exitCode))
				throw providerTimeoutError(`project-secrets-${phase}`);
			if (result.exitCode !== 0)
				throw new ProjectSecretsPreparationFailure(phase, {
					kind: "command",
					exitCode: result.exitCode,
				});
			return result;
		});
	} catch (error) {
		if (
			error instanceof FreestyleApiError &&
			error.code === PROVIDER_TIMEOUT_CODE
		)
			throw new ProjectSecretsPreparationFailure(phase, { kind: "timeout" });
		throw error;
	}
}

/**
 * Prints `sha256:<hex>` for an env file the command user owns, alone (mode
 * 0600) and can read; prints nothing otherwise, and never fails (the
 * directory check before it decides the command's exit status).
 */
export function agentSecretsDigestShell() {
	const file = posixShellQuoted(AGENT_SECRETS_ENV_PATH);
	return `{ if [ -f ${file} ] && [ ! -L ${file} ] && [ -O ${file} ] && [ -r ${file} ] && [ -z "$(find ${file} -prune ! -perm 600)" ]; then digest="$( { sha256sum ${file} || shasum -a 256 ${file}; } 2>/dev/null | cut -d ' ' -f 1)"; [ -n "$digest" ] && printf 'sha256:%s\\n' "$digest"; fi; } 2>/dev/null; true`;
}

function agentSecretsDigestFromOutput(stdout: string) {
	return /^sha256:([0-9a-f]{64})$/m.exec(stdout)?.[1] ?? null;
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

/**
 * Saves credentials typed into a chat message as project secrets, so every
 * chat of the project has them, and returns the message with the values
 * replaced by their variable names. Never blocks the send: if saving fails,
 * the message goes through as typed.
 */
export async function saveSecretsPastedInMessage(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly text: string;
}): Promise<string> {
	const pasted = findPastedSecrets(input.text);
	if (!pasted.length) return input.text;
	const saved: PastedSecret[] = [];
	for (const secret of pasted) {
		try {
			await saveVisibleProjectSecret({
				userId: input.userId,
				projectId: input.projectId,
				name: secret.name,
				value: secret.value,
				kind: "runtime",
			});
			saved.push(secret);
		} catch (error) {
			console.warn("A secret pasted in a message was not saved.", {
				name: secret.name,
				reason: error instanceof Error ? error.message : "unknown",
			});
		}
	}
	return messageWithSecretsAsVariables(input.text, saved);
}

/** Account-wide secrets are a convenience: if they cannot load, the turn runs with the project's own. */
async function loadSharedAccountSecrets(userId: string) {
	try {
		return await loadAccountSecrets(userId);
	} catch (error) {
		console.warn("Account secrets could not be loaded.", {
			reason: error instanceof Error ? error.message : "unknown",
		});
		return [];
	}
}

/** Saves a secret every project of the user receives; a project's own secret of the same name wins. */
export async function saveAccountWideSecret(input: {
	readonly userId: string;
	readonly name: string;
	readonly value: string;
	readonly kind: unknown;
}): Promise<PublicProjectSecret> {
	const name = parseProjectSecretName(input.name);
	const kind = parseProjectSecretKind(input.kind);
	if (kind === "build")
		throw new Error("Build secrets cannot be shared across projects.");
	const value = parseProjectSecretValue(input.value, kind);
	return saveAccountSecret({
		userId: input.userId,
		name,
		kind,
		hint: secretHint(value),
		encrypted: encryptSecret(await loadSecretMasterKey(), value),
	});
}

export async function removeAccountWideSecret(input: {
	readonly userId: string;
	readonly secretId: string;
}) {
	await deleteAccountSecret(input);
}

export function listAccountWideSecrets(userId: string) {
	return listAccountSecrets(userId);
}
