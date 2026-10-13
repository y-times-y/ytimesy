import { Freestyle } from "freestyle";
import { posixShellQuoted } from "#/domain/posix-command";
import type { ProgressFiles } from "../session-progress";
import watcher from "../session-progress-watch.py?raw";

/** A dedicated read-only PTY, never the user's interactive terminal. */
export async function watchSessionProgress(input: {
	apiKey: string;
	providerRef: string;
	paths: Record<string, string>;
	signal: AbortSignal;
	onFiles: (files: ProgressFiles) => void;
	onClose: () => void;
}) {
	const vm = new Freestyle({ apiKey: input.apiKey }).vms.ref(input.providerRef);
	if (input.signal.aborted || (await vm.data()).state !== "running") {
		input.onClose();
		return () => {};
	}
	let buffer = "";
	const decoder = new TextDecoder();
	const session = await vm.pty.open({
		exec: `stty -echo -onlcr; exec python3 -u -c ${posixShellQuoted(watcher)} ${posixShellQuoted(JSON.stringify(input.paths))}`,
		onData(bytes) {
			buffer += decoder.decode(bytes, { stream: true });
			if (buffer.length > 24 * 1024 * 1024) {
				input.onClose();
				return;
			}
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line && line !== "heartbeat") {
					try {
						input.onFiles(
							JSON.parse(Buffer.from(line, "base64").toString("utf8")),
						);
					} catch {
						input.onClose();
					}
				}
				newline = buffer.indexOf("\n");
			}
		},
		onExit: input.onClose,
		onClose: input.onClose,
		onError: input.onClose,
	});
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		input.signal.removeEventListener("abort", close);
		session.detach();
		void vm.pty.close(session.sessionId).catch(() => undefined);
	};
	input.signal.addEventListener("abort", close, { once: true });
	if (input.signal.aborted) close();
	return close;
}
