import { randomUUID } from "node:crypto";
import type { VmPty } from "freestyle";
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
		return { exitCode, stdout: output + decoder.decode(), stderr: "" };
	} finally {
		clearTimeout(timer);
		try {
			await pty.close(session?.sessionId ?? slug);
		} finally {
			session?.detach();
		}
	}
}
