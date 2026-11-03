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
 * Readers run every command in a network namespace of their own (created as
 * root, entered before switching to the reader): the builder's Chrome
 * DevTools (9222), debug adapters, desktop viewer, dev servers and cloud
 * metadata are out of reach, on 127.0.0.1, ::1 and every other address,
 * whatever they listen on. Freestyle's kernel has no iptables owner match,
 * so a per-user firewall rule never installed there. The reader's own
 * loopback comes up inside, for servers it starts itself; it has no other
 * network. If the namespace cannot be created the command never runs.
 */
export const READER_NETWORK_NAMESPACE = `sudo -n unshare --net -- sh -c 'ip link set lo up >/dev/null 2>&1; exec "$@"' ytimesy-reader-net`;

/** Preparation refuses the reader where network namespaces are unavailable. */
export const READER_NETWORK_ISOLATION_CHECK = `sudo -n unshare --net -- true || { echo "ytimesy: network namespaces are unavailable; the read-only agent cannot be isolated from the builder's loopback services" >&2; exit 1; }`;

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
 * stay 0700; the checkout is made readable to the reader
 * ({@link readerCheckoutAccessScript}), dotenv files excepted.
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
		READER_NETWORK_ISOLATION_CHECK,
		...SHARED_RUNTIME_PARENTS.map(
			(directory) =>
				`sudo -n install -d -m 1777 ${directory} && sudo -n chmod 1777 ${directory}`,
		),
		'chmod o-rw,o+x "$HOME"',
		`if [ -d ${AGENT_SECRETS_DIRECTORY} ]; then chmod 0700 ${AGENT_SECRETS_DIRECTORY}; fi`,
		...(input.checkout ? [readerCheckoutAccessScript(input.checkout)] : []),
	].join("\n");
}

/** Checkout files a reader never reads, whatever their mode or ACL says. */
const READER_PRIVATE_CHECKOUT_FILES = `\\( -name '.env*' -o -name .git-credentials -o -name .netrc \\)`;

/**
 * Lets the reader read (never write) the checkout. Setup that ran under
 * umask 077 (a Git transfer, a detached setup command, a restore) leaves
 * files 0600 and directories 0700, and every read the reader tried failed.
 * Where setfacl exists the grant is a POSIX ACL for the reader user alone,
 * with a default ACL on each directory so files created later inherit it
 * whatever the creator's umask; otherwise "other" gets r and X (the modes
 * umask 022 would have produced). Symbolic links are never followed, so a
 * link in the checkout cannot grant anything outside it. Dotenv and
 * credential files then lose the grant and their world bits. Files another
 * user owns (root after a restore, sudo installs) need sudo; if neither
 * works the reader still starts, and reads what it can.
 */
export function readerCheckoutAccessScript(checkout: string) {
	const c = shellQuote(checkout);
	const u = READER_LINUX_USER;
	return `ytimesy_reader_grant() {
  if command -v setfacl >/dev/null 2>&1; then
    $1 find ${c} -type d -exec setfacl -m u:${u}:rX,d:u:${u}:rX {} + && $1 find ${c} -type f -exec setfacl -m u:${u}:rX {} +
  else
    $1 find ${c} \\( -type d -o -type f \\) -exec chmod o+rX {} +
  fi
}
ytimesy_reader_revoke() {
  $1 find ${c} -type f ${READER_PRIVATE_CHECKOUT_FILES} -exec chmod o-rwx {} + || return 1
  if command -v setfacl >/dev/null 2>&1; then $1 find ${c} -type f ${READER_PRIVATE_CHECKOUT_FILES} -exec setfacl -x u:${u} {} +; fi
}
if [ -d ${c} ]; then
  ytimesy_reader_grant "sudo -n" 2>/dev/null || ytimesy_reader_grant "" 2>/dev/null || true
  ytimesy_reader_revoke "sudo -n" 2>/dev/null || ytimesy_reader_revoke "" 2>/dev/null || true
fi`;
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
 * One guest command run as the reader in its own network namespace: its own
 * HOME (the scratch directory), the command passed base64-encoded so quoting
 * never multiplies.
 */
export function readerCommand(sessionId: string, command: string) {
	const scratch = readerScratchDirectory(sessionId);
	const encoded = Buffer.from(command, "utf8").toString("base64");
	return `${READER_NETWORK_NAMESPACE} sudo -n -u ${READER_LINUX_USER} -- env HOME=${scratch} USER=${READER_LINUX_USER} LOGNAME=${READER_LINUX_USER} TMPDIR=${scratch} ${READER_GIT_ENVIRONMENT} bash -c "$(printf %s ${encoded} | base64 -d)"`;
}

/**
 * A read-only Claude Code helper's run, as the reader (the checkout
 * stays unwritable) but outside the network namespace: Claude Code
 * must reach ytimesy's edge for every model request. Its commands can
 * therefore reach the VM's loopback services, unlike a reader on our own
 * harness. Only Claude Code read-only helpers use it.
 */
export function readerNetworkedCommand(sessionId: string, command: string) {
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
