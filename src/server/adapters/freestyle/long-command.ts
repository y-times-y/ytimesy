import { randomUUID } from "node:crypto";
import { FreestyleApiError, type VmPty } from "freestyle";
import { posixShellCommand } from "#/domain/posix-command";
import type { RuntimeCommandResult } from "../workspace-runtime";

const OUTPUT_LIMIT = 1024 * 1024;

/** Guest timeout survives a worker crash; closing the PTY kills, not just detaches. */
export async function runLongCommand(
	pty: Pick<VmPty, "open" | "close">,
	argv: string[],
	env: Record<string, string>,
	timeoutMs: number,
): Promise<RuntimeCommandResult> {
	const slug = `setup-${randomUUID()}`;
	let output = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	let finish!: (exitCode: number) => void;
	let fail!: () => void;
	const completed = new Promise<number>((resolve, reject) => {
		finish = (exitCode) => {
			if (settled) return;
			settled = true;
			resolve(exitCode);
		};
		fail = () => {
			if (settled) return;
			settled = true;
			reject(new Error("Environment command connection was interrupted."));
		};
	});
	// A fast process can exit while open() is still resolving its session handle.
	void completed.catch(() => undefined);
	const decoder = new TextDecoder();
	let session: Awaited<ReturnType<VmPty["open"]>> | undefined;
	let result: RuntimeCommandResult;
	try {
		timer = setTimeout(() => finish(124), timeoutMs + 15_000);
		session = await pty.open({
			slug,
			replaceOnExit: false,
			exec: posixShellCommand([
				"timeout",
				"--signal=TERM",
				"--kill-after=10s",
				`${Math.ceil(timeoutMs / 1000)}s`,
				"env",
				...Object.entries(env).map(([name, value]) => `${name}=${value}`),
				...argv,
			]),
			onData: (data) => {
				output = (output + decoder.decode(data, { stream: true })).slice(
					-OUTPUT_LIMIT,
				);
			},
			onExit: finish,
			onError: fail,
			onClose: fail,
		});
		const exitCode = await completed;
		result = { exitCode, stdout: output + decoder.decode(), stderr: "" };
	} catch (error) {
		// The command's own failure wins; cleanup still runs but cannot replace it.
		clearTimeout(timer);
		await closeSession(pty, session, slug);
		throw error;
	}
	clearTimeout(timer);
	const cleanupError = await closeSession(pty, session, slug);
	if (cleanupError) throw cleanupError;
	return result;
}

/** Closes (kills) the guest session; returns a cleanup failure instead of throwing it. */
async function closeSession(
	pty: Pick<VmPty, "close">,
	session: Awaited<ReturnType<VmPty["open"]>> | undefined,
	slug: string,
): Promise<unknown> {
	try {
		await pty.close(session?.sessionId ?? slug);
		return undefined;
	} catch (error) {
		// Exited guest sessions are already gone; other cleanup failures remain errors.
		return error instanceof FreestyleApiError && error.status === 404
			? undefined
			: error;
	} finally {
		session?.detach();
	}
}
