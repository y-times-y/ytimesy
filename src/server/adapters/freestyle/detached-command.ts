import {
	posixShellCommand,
	posixShellQuoted as quote,
} from "#/domain/posix-command";
import { commandOutputListener } from "../command-output";
import { ResumeLater } from "../resumable-commands";
import type { RuntimeCommandResult } from "../workspace-runtime";

const OUTPUT_LIMIT = 1024 * 1024;
const POLL_MS = 5_000;
/** While someone watches the output (a live setup view), it is read this often. */
const WATCHED_POLL_MS = 2_000;
/**
 * Most setup commands (a small repository's fetch and checkout, a restore)
 * finish in one to four seconds: status reads stay a quarter second apart
 * for the first second, half a second until four, then back off to the poll
 * interval. Backing off to 5 s after 1.75 s made a 2 s fetch take 6.75 s.
 */
const FIRST_POLLS_MS = [
	250, 250, 250, 250, 500, 500, 500, 500, 500, 500, 1_000, 1_000, 1_000, 1_000,
	2_000, 2_000,
] as const;

/** The wait before the status read after `polls` reads found it still running. */
export function detachedPollDelay(polls: number, watched: boolean) {
	const steady = watched ? WATCHED_POLL_MS : POLL_MS;
	return Math.min(FIRST_POLLS_MS[polls] ?? steady, steady);
}
/** Bytes of output a watched poll reads back. */
const WATCHED_TAIL_BYTES = 4_096;
const TAIL_MARKER = "\n--ytimesy-output--\n";
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
	const listener = commandOutputListener();
	let reported = "";
	for (let polls = 0; ; polls++) {
		// A watched command's status read also returns its output's tail.
		const status = await exec(
			listener
				? `cat ${quote(`${directory}/status`)} 2>/dev/null || true; printf %s ${quote(TAIL_MARKER)}; tail -c ${WATCHED_TAIL_BYTES} ${quote(`${directory}/out`)} 2>/dev/null || true`
				: `cat ${quote(`${directory}/status`)} 2>/dev/null || true`,
		);
		const marker = status.stdout.indexOf(TAIL_MARKER);
		const code = (
			marker >= 0 ? status.stdout.slice(0, marker) : status.stdout
		).trim();
		if (listener && marker >= 0) {
			const tail = status.stdout.slice(marker + TAIL_MARKER.length);
			if (tail !== reported) {
				reported = tail;
				// The live view is best effort: it never fails the command.
				await Promise.resolve(listener(tail)).catch(() => undefined);
			}
		}
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
		const poll = detachedPollDelay(polls, Boolean(listener));
		if (Date.now() + poll > deadline) throw new ResumeLater();
		await sleep(poll);
	}
}
