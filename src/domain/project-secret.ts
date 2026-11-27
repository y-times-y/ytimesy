import { posixShellQuoted } from "./posix-command";
import { isReaderRole, type SubagentRole } from "./subagent";

/**
 * Where a task VM keeps the project's environment variables and runtime
 * secrets. One fixed path, because agent commands, services and commits run
 * through execs whose $HOME can differ. The directory is private (0700).
 *
 * Not under /tmp: the VM image (Ubuntu) empties /tmp on every boot
 * (`D /tmp` in tmpfiles.d), so a chat whose VM was stopped and started again
 * lost its secrets while its turn still counted them as written; /var/tmp is
 * kept across reboots.
 */
export const AGENT_SECRETS_DIRECTORY = "/var/tmp/ytimesy-secrets";
/** Where VMs prepared before 2026-11-23 keep them; scrubbed with the current one. */
export const LEGACY_AGENT_SECRETS_DIRECTORY = "/tmp/ytimesy-secrets";
export const AGENT_SECRETS_ENV_PATH = `${AGENT_SECRETS_DIRECTORY}/agent.env`;

/**
 * Whether a session's workspace gets the project's env file and is told the
 * secret names. Read-only subagents (researcher, reviewer, checker) only
 * read and review, so they never receive secrets: their commands run as the
 * reader Linux user, which cannot read the 0700 secrets directory nor write
 * the env file. They still redact the values from their output.
 */
export function sessionReceivesProjectSecrets(session: {
	readonly agentRole?: SubagentRole | null;
}) {
	return !isReaderRole(session.agentRole);
}

/** Thrown when the env file's private directory cannot be prepared on the VM. */
export const PROJECT_SECRETS_PREPARATION_FAILED =
	"Could not prepare project secrets in the workspace.";

/** Fixed setup metadata only: never command output or a secret value. */
export class ProjectSecretsPreparationFailure extends Error {
	constructor(
		readonly phase: "directory" | "ownership",
		readonly failure:
			| { readonly kind: "timeout" }
			| { readonly kind: "command"; readonly exitCode: number },
	) {
		super(PROJECT_SECRETS_PREPARATION_FAILED);
		this.name = "ProjectSecretsPreparationFailure";
	}
}

/** Shell that loads the project's variables when present. */
export const SOURCE_AGENT_SECRETS = `if [ -r ${AGENT_SECRETS_ENV_PATH} ]; then . ${AGENT_SECRETS_ENV_PATH}; elif [ -r ${LEGACY_AGENT_SECRETS_DIRECTORY}/agent.env ]; then . ${LEGACY_AGENT_SECRETS_DIRECTORY}/agent.env; fi`;

/**
 * Points the legacy path at the current directory, so a box still running a
 * program from before the move (it sources the legacy path until it updates)
 * reads the file the edge now writes. Never replaces a real legacy
 * directory; /tmp is emptied on boot, so the link only lasts until then.
 */
export const LINK_LEGACY_AGENT_SECRETS = `if [ ! -e ${LEGACY_AGENT_SECRETS_DIRECTORY} ] || [ -L ${LEGACY_AGENT_SECRETS_DIRECTORY} ]; then ln -sfn ${AGENT_SECRETS_DIRECTORY} ${LEGACY_AGENT_SECRETS_DIRECTORY} 2>/dev/null || true; fi`;

/**
 * Shell run before any VM snapshot: deletes the env file and proves it is gone,
 * so plaintext values never land in a reusable or retained image. The next turn
 * writes the file again.
 */
export const SCRUB_AGENT_SECRETS = `rm -rf ${AGENT_SECRETS_DIRECTORY} ${LEGACY_AGENT_SECRETS_DIRECTORY} && test ! -e ${AGENT_SECRETS_DIRECTORY} && test ! -e ${LEGACY_AGENT_SECRETS_DIRECTORY}`;

/** Holds the names of the runtime secrets in the env file, for the commit guard. */
const REDACTED_NAMES_VARIABLE = "YTIMESY_REDACTED_SECRETS";

export const PROJECT_SECRET_KINDS = [
	"environment",
	"runtime",
	"build",
] as const;
export type ProjectSecretKind = (typeof PROJECT_SECRET_KINDS)[number];

/** Runtime secrets are matched by value; very short values would redact ordinary text. */
const MIN_RUNTIME_SECRET_LENGTH = 6;

export const REDACTED = "[REDACTED]";

const RESERVED_SECRET_NAMES = new Set([
	"PATH",
	"HOME",
	"DISPLAY",
	"USER",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TERM",
	REDACTED_NAMES_VARIABLE,
]);

export type PublicProjectSecret = {
	readonly id: string;
	readonly name: string;
	readonly kind: ProjectSecretKind;
	readonly hint: string;
	readonly updatedAt: string;
	/** What an agent that tested it saved: provider, identity, what it can do. */
	readonly description?: string;
	/** Imported from a local .env and not yet reviewed (saved again or removed). */
	readonly imported?: true;
};

export function parseProjectSecretKind(value: unknown): ProjectSecretKind {
	const kind = PROJECT_SECRET_KINDS.find((candidate) => candidate === value);
	if (!kind) throw new Error("Choose a secret type.");
	return kind;
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

export function parseProjectSecretValue(
	value: string,
	kind: ProjectSecretKind = "environment",
) {
	const secret = value.trim();
	if (secret.length < 1) {
		throw new Error("A secret value is required.");
	}
	if (kind === "runtime" && secret.length < MIN_RUNTIME_SECRET_LENGTH) {
		throw new Error(
			`Runtime secrets must be at least ${MIN_RUNTIME_SECRET_LENGTH} characters so they can be redacted; use an environment variable for shorter values.`,
		);
	}
	if (secret.length > 8_192) {
		throw new Error("Secret values must be 8192 characters or fewer.");
	}
	return secret;
}

/** The VM env file: environment variables and runtime secrets, never build secrets. */
export function agentSecretsEnvFile(
	secrets: readonly {
		readonly name: string;
		readonly value: string;
		readonly kind: ProjectSecretKind;
	}[],
) {
	const exposed = secrets.filter((secret) => secret.kind !== "build");
	if (exposed.length === 0) return "# No project secrets configured.\n";
	const redacted = exposed
		.filter((secret) => secret.kind === "runtime")
		.map((secret) => secret.name);
	return `${[
		...exposed.map(
			(secret) => `export ${secret.name}=${posixShellQuoted(secret.value)}`,
		),
		`${REDACTED_NAMES_VARIABLE}=${posixShellQuoted(redacted.join(" "))}`,
	].join("\n")}\n`;
}

export type AgentSecretName = {
	readonly name: string;
	readonly kind: ProjectSecretKind;
	/** What it is and what it can do, saved by an agent that tested it (describe_secret). */
	readonly description?: string | null;
};

/** The tool that saves what a tested secret is and can do. */
export const DESCRIBE_SECRET_TOOL = "describe_secret";
export const SECRET_DESCRIPTION_LIMIT = 500;

/** Said wherever the agent is told its secrets, so it checks before it claims one is missing. */
export const SECRETS_CHECK_RULE =
	"Before saying a credential, key or token is unavailable, check the environment variable names (`printenv NAME >/dev/null`, or `env | cut -d= -f1`); never print values.";

/** Most names the compact line lists; the rest are counted. */
const SECRETS_LINE_LIMIT = 40;

/**
 * The compact line for surfaces that do not carry the full instructions (the
 * Claude Code prompt): names only, then the check rule. Empty with no secrets.
 */
export function secretsContextLine(
	secrets: readonly AgentSecretName[] | undefined,
) {
	if (!secrets?.length) return "";
	const names = secrets
		.filter((secret) => secret.kind !== "build")
		.map((secret) => secret.name);
	if (!names.length) return "";
	const shown = names.slice(0, SECRETS_LINE_LIMIT);
	const more =
		names.length > shown.length
			? ` and ${names.length - shown.length} more`
			: "";
	return `Secrets available in this environment (names only, values are never shown): ${shown.join(", ")}${more}. ${SECRETS_CHECK_RULE}`;
}

/**
 * Tells the agent which project secrets exist and how each reaches it, by name
 * only, so it uses the variable instead of guessing or printing the environment.
 */
export function projectSecretsInstructions(
	secrets: readonly AgentSecretName[],
	options: { readonly describeTool?: boolean } = {},
) {
	if (!secrets.length) return "";
	const listed = (kind: ProjectSecretKind) =>
		secrets
			.filter((secret) => secret.kind === kind)
			.map((secret) =>
				secret.description
					? `${secret.name} (${secret.description})`
					: secret.name,
			)
			.join(", ");
	const unverified = secrets
		.filter((secret) => secret.kind !== "build" && !secret.description)
		.map((secret) => secret.name);
	const lines = [
		listed("runtime") &&
			`Runtime secrets (their values are replaced with ${REDACTED} in tool output, and commits containing them are refused): ${listed("runtime")}.`,
		listed("environment") && `Environment variables: ${listed("environment")}.`,
		listed("build") &&
			`Build secrets (environment setup only, not set for you): ${listed("build")}.`,
	].filter(Boolean);
	return `Project secrets are set in every command's environment. ${lines.join(" ")} Reference them by name (for example "$NAME"); never print, echo or write their values to files, and never display them on screen: screenshots are not redacted. ${SECRETS_CHECK_RULE}${options.describeTool && unverified.length ? ` Not yet identified: ${unverified.join(", ")}. Before you rely on one of these, or ask the user for a credential, identify it (its name, the first four characters and the length of its value, how this repository uses it), test it from the shell with that service's read-only whoami or list call (look it up in the service's documentation), then save what you learned with ${DESCRIBE_SECRET_TOOL}: the service, whose identity it is, what it can do, how you tested it. Never put a value in the description.` : ""}`;
}

/**
 * Shell run after `git add -A` in a repository: refuses when the staged
 * changes, or a commit of this branch not yet on a remote (content or
 * message), contain a runtime secret's value. Unstages first so nothing is
 * committed. Only HEAD's history: other local refs (helper results under
 * refs/ytimesy/agents, other branches) are not what this commit pushes, and
 * scanning them refused chats for values those refs only snapshot.
 */
export const SECRET_COMMIT_GUARD = `if [ -r ${AGENT_SECRETS_ENV_PATH} ]; then ( . ${AGENT_SECRETS_ENV_PATH}; for name in $${REDACTED_NAMES_VARIABLE}; do value="\${!name}"; if [ -n "$value" ] && { git diff --cached; git log -p --format=%B HEAD --not --remotes; } | grep -qF -- "$value"; then git reset -q; echo "Refusing to commit: the changes or an unpushed commit contain the value of runtime secret $name. Remove it and use the environment variable instead." >&2; exit 3; fi; done ); fi`;

/** Encoded variants are matched only for values at least this long, to avoid false positives. */
const MIN_ENCODED_SECRET_LENGTH = 8;

const base64 = (bytes: Uint8Array) => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

/**
 * The forms a value commonly takes in command output: as written, JSON-escaped,
 * URL-encoded, hex, and base64 or base64url. Base64 inside a larger encoded blob
 * depends on the value's byte offset, so the stable middle of each of the three
 * alignments is matched as well.
 */
export function secretForms(secret: string): string[] {
	const forms = new Set([secret]);
	if (secret.length >= MIN_ENCODED_SECRET_LENGTH) {
		const bytes = new TextEncoder().encode(secret);
		forms.add(JSON.stringify(secret).slice(1, -1));
		forms.add(encodeURIComponent(secret));
		const hex = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		forms.add(hex);
		forms.add(hex.toUpperCase());
		const padded = base64(bytes);
		const encoded = [padded, padded.replace(/=+$/, "")];
		for (const offset of [0, 1, 2]) {
			const shifted = base64(
				new Uint8Array([...new Uint8Array(offset), ...bytes]),
			);
			// Drop the first group (mixed with preceding bytes) and the last partial one.
			const start = offset ? 4 : 0;
			const end =
				start + Math.floor((bytes.length - (offset ? 3 - offset : 0)) / 3) * 4;
			const middle = shifted.slice(start, end);
			if (middle.length >= MIN_ENCODED_SECRET_LENGTH) encoded.push(middle);
		}
		for (const form of encoded) {
			forms.add(form);
			forms.add(form.replaceAll("+", "-").replaceAll("/", "_"));
		}
	}
	return [...forms].filter((form) => form.length >= MIN_RUNTIME_SECRET_LENGTH);
}

/** Replaces every runtime secret value, and its common encodings, in strings anywhere inside `value`. */
export function redactSecretValues<T>(value: T, secrets: readonly string[]): T {
	const usable = secrets
		.filter((secret) => secret.length >= MIN_RUNTIME_SECRET_LENGTH)
		.flatMap(secretForms)
		.sort((a, b) => b.length - a.length);
	if (!usable.length) return value;
	const visit = (item: unknown): unknown => {
		if (typeof item === "string")
			return usable.reduce(
				(text, secret) => text.split(secret).join(REDACTED),
				item,
			);
		if (Array.isArray(item)) return item.map(visit);
		if (item && typeof item === "object" && item.constructor === Object)
			return Object.fromEntries(
				Object.entries(item).map(([key, entry]) => [key, visit(entry)]),
			);
		return item;
	};
	return visit(value) as T;
}
