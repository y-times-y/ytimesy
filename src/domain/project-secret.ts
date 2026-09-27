import { posixShellQuoted } from "./posix-command";

export const AGENT_SECRETS_ENV_NAME = ".ytimesy-agent-secrets.env";

const RESERVED_SECRET_NAMES = new Set([
	"PATH",
	"HOME",
	"DISPLAY",
	"USER",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TERM",
]);

export type PublicProjectSecret = {
	readonly id: string;
	readonly name: string;
	readonly hint: string;
	readonly updatedAt: string;
};

export function agentSecretsEnvPath(home: string) {
	const trimmed = home.replace(/\/+$/, "");
	return `${trimmed || "/home/ubuntu"}/${AGENT_SECRETS_ENV_NAME}`;
}

export function parseProjectSecretName(value: string) {
	const name = value.trim();
	if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
		throw new Error(
			"Secret names must be uppercase letters, digits, and underscores.",
		);
	}
	if (RESERVED_SECRET_NAMES.has(name)) {
		throw new Error(`${name} is reserved and cannot be a project secret.`);
	}
	return name;
}

export function parseProjectSecretValue(value: string) {
	const secret = value.trim();
	if (secret.length < 1) {
		throw new Error("A secret value is required.");
	}
	if (secret.length > 8_192) {
		throw new Error("Secret values must be 8192 characters or fewer.");
	}
	return secret;
}

export function agentSecretsEnvFile(
	secrets: readonly { readonly name: string; readonly value: string }[],
) {
	if (secrets.length === 0) return "# No project secrets configured.\n";
	return `${secrets
		.map((secret) => `export ${secret.name}=${posixShellQuoted(secret.value)}`)
		.join("\n")}\n`;
}

export function agentSecretsDeveloperNote(names: readonly string[]) {
	if (names.length === 0) return "";
	return ` Project secrets are already exported as ${names.join(", ")}. Use those environment variables. Never print, log, echo, or quote their values.`;
}
