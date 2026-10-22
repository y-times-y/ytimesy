import {
	posixShellCommand,
	posixShellQuoted as quote,
} from "#/domain/posix-command";
import { ResumeLater } from "../resumable-commands";
import type { RuntimeCommandResult } from "../workspace-runtime";

const OUTPUT_LIMIT = 1024 * 1024;
const POLL_MS = 5_000;
/** Directory removed before a build VM is snapshotted (see activateEnvironmentBuild). */
export const DETACHED_COMMAND_ROOT = "/tmp/ytimesy-detached";

type ShortExec = (command: string) => Promise<RuntimeCommandResult>;

/**
 * Runs a command detached from this connection, so it survives the caller
 * stopping. Starting is idempotent per id: a caller that restarts re-attaches to
 * the same process (or its finished result) instead of launching it again. The
 * guest `timeout` bounds the command even if nobody polls.
 */
export async function runDetachedCommand(
	exec: ShortExec,
	id: string,
	argv: string[],
	env: Record<string, string>,
	timeoutMs: number,
	deadline: number,
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<RuntimeCommandResult> {
	if (!/^[a-f0-9]{16,64}$/.test(id)) throw new Error("Invalid command id.");
	const directory = `${DETACHED_COMMAND_ROOT}/${id}`;
	const seconds = Math.ceil(timeoutMs / 1000);
	// Secrets go in a 0600 script, in a 0700 directory, deleted as soon as the
	// command exits. Only those are made under umask 077: the command itself
	// keeps the VM's umask, or a checkout it writes is 0600 and a read-only
	// helper (another Linux user) cannot read it.
	const script = [
		...Object.entries(env).map(
			([name, value]) => `export ${name}=${quote(value)}`,
		),
		`exec ${posixShellCommand(["timeout", "--signal=TERM", "--kill-after=10s", `${seconds}s`, ...argv])}`,
	].join("\n");
	const started = await exec(
		// Only the launch is backgrounded; setup must finish before "started" is read.
		`d=${quote(directory)}; if [ ! -f "$d/started" ]; then (umask 077; mkdir -p "$d" && printf '%s' ${quote(Buffer.from(script, "utf8").toString("base64"))} | base64 -d >"$d/run.sh") || exit 1; setsid nohup bash -c 'bash "$1/run.sh" >"$1/out" 2>&1; echo $? >"$1/status.tmp"; mv "$1/status.tmp" "$1/status"; rm -f "$1/run.sh"' _ "$d" </dev/null >/dev/null 2>&1 & date +%s >"$d/started"; fi; cat "$d/started"`,
	);
	const startedAt = Number(started.stdout.trim()) * 1000;
	if (started.exitCode !== 0 || !Number.isFinite(startedAt) || !startedAt)
		throw new Error("Detached command could not be started.");
	for (;;) {
		const status = await exec(
			`cat ${quote(`${directory}/status`)} 2>/dev/null || true`,
		);
		const code = status.stdout.trim();
		const timedOut = Date.now() > startedAt + timeoutMs + 60_000;
		if (code || timedOut) {
			const output = await exec(
				`tail -c ${OUTPUT_LIMIT} ${quote(`${directory}/out`)} 2>/dev/null || true`,
			);
			return {
				exitCode: code ? Number(code) : 124,
				stdout: output.stdout,
				stderr: "",
			};
		}
		if (Date.now() + POLL_MS > deadline) throw new ResumeLater();
		await sleep(POLL_MS);
	}
}
