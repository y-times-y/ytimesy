import { AGENT_SECRETS_DIRECTORY } from "./project-secret";

/**
 * Read-only subagents (researcher, reviewer, checker) share the parent's VM
 * but run every guest operation as this Linux user. The checkout, home and
 * secrets belong to the builder's user, so the reader can read code but
 * cannot write it, cannot read secrets (0700) and cannot signal the
 * builder's processes. Its only private writable place is its scratch
 * directory. The runtime enforces this, not the prompt.
 */
export const READER_LINUX_USER = "ytimesy-reader";
export const READER_SCRATCH_ROOT = "/tmp/ytimesy-agents";

export function readerScratchDirectory(sessionId: string) {
	const safe = sessionId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
	return `${READER_SCRATCH_ROOT}/${safe || "agent"}`;
}

/**
 * Root shell that creates the reader user (idempotent). Baked into the tools
 * snapshot (scripts/build-tools-snapshot.ts); the runtime runs it again with
 * `sudo -n` on VMs booted from an older image.
 */
export const READER_USER_SETUP_SCRIPT = `id -u ${READER_LINUX_USER} >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir ${READER_SCRATCH_ROOT} --shell /bin/bash ${READER_LINUX_USER}
install -d -o root -g root -m 0755 ${READER_SCRATCH_ROOT}`;

/**
 * Runs READER_USER_SETUP_SCRIPT as root from the builder's user (passwordless
 * sudo). Anything that hands a directory to the reader runs it first: VMs
 * booted from an image older than the reader user lack it.
 */
export function readerUserSetupCommand() {
	const encoded = Buffer.from(READER_USER_SETUP_SCRIPT, "utf8").toString(
		"base64",
	);
	return `sudo -n bash -c "$(printf %s ${encoded} | base64 -d)"`;
}

/**
 * Runtime directories every session writes under; sticky like /tmp so a
 * reader can add its own entries only. The first session to run a command
 * creates them as its own user (0755), and on a shared VM that is the
 * builder, so without this a reader cannot create its entry and every
 * command it runs fails before it starts: its command records
 * (`commandRoot`, api-agent-command-tools.ts), its process scopes
 * (`COMMAND_SCOPES_DIRECTORY`, api-command-scope.ts) and its runtime root
 * (`sessionRuntimeRoot`, session-workspace-machines.ts).
 */
export const SHARED_RUNTIME_PARENTS = [
	"/tmp/ytimesy-api-commands",
	"/tmp/ytimesy-api-command-scopes",
	"/tmp/ytimesy-sessions",
] as const;

/**
 * Prepares the shared VM for one reader, run as the builder's user (who has
 * passwordless sudo). The home directory gets traverse-only access for
 * others (no listing), so the reader reaches the checkout by path; secrets
 * stay 0700; dotenv files in the checkout lose their world bits.
 */
export function readerPreparationScript(input: {
	readonly sessionId: string;
	readonly checkout?: string;
}) {
	const scratch = readerScratchDirectory(input.sessionId);
	return [
		"set -e",
		readerUserSetupCommand(),
		`sudo -n install -d -o ${READER_LINUX_USER} -g ${READER_LINUX_USER} -m 0700 ${scratch}`,
		...SHARED_RUNTIME_PARENTS.map(
			(directory) =>
				`sudo -n install -d -m 1777 ${directory} && sudo -n chmod 1777 ${directory}`,
		),
		'chmod o-rw,o+x "$HOME"',
		`if [ -d ${AGENT_SECRETS_DIRECTORY} ]; then chmod 0700 ${AGENT_SECRETS_DIRECTORY}; fi`,
		...(input.checkout
			? [
					`find ${shellQuote(input.checkout)} -maxdepth 4 -name node_modules -prune -o -name '.env*' -type f -exec chmod o-rwx {} + 2>/dev/null || true`,
				]
			: []),
	].join("\n");
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Git refuses a repository another user owns ("dubious ownership"), which is
 * every checkout a reader looks at; command-scope config marks them safe
 * (safe.directory is honored there, unlike in a repository's own config).
 */
const READER_GIT_ENVIRONMENT =
	"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'";

/**
 * One guest command run as the reader: its own HOME (the scratch
 * directory), the command passed base64-encoded so quoting never multiplies.
 */
export function readerCommand(sessionId: string, command: string) {
	const scratch = readerScratchDirectory(sessionId);
	const encoded = Buffer.from(command, "utf8").toString("base64");
	return `sudo -n -u ${READER_LINUX_USER} -- env HOME=${scratch} USER=${READER_LINUX_USER} LOGNAME=${READER_LINUX_USER} TMPDIR=${scratch} ${READER_GIT_ENVIRONMENT} bash -c "$(printf %s ${encoded} | base64 -d)"`;
}

/**
 * Where the runtime may write a file for a reader: its scratch, its session
 * runtime root, single-use payload files directly in /tmp, and the attempt
 * loop's per-attempt directories (the runtime creates each one for its
 * checker, owned by the reader).
 */
export function readerMayWrite(
	path: string,
	sessionId: string,
	sessionRoot: string,
) {
	if (path.includes("/../") || path.endsWith("/..")) return false;
	const scratch = readerScratchDirectory(sessionId);
	return (
		path.startsWith(`${scratch}/`) ||
		path.startsWith(`${sessionRoot}/`) ||
		/^\/tmp\/ytimesy-attempts\/[a-zA-Z0-9-]+\/\d+\/./.test(path) ||
		/^\/tmp\/ytimesy-[a-z-]+-[0-9a-f-]{36}\.[a-z]+$/.test(path)
	);
}
