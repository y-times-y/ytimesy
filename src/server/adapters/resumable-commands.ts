import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Thrown when a detached command is still running as the current invocation's
 * time budget runs out; the caller re-runs its work later and re-attaches.
 */
export class ResumeLater extends Error {
	constructor() {
		super("Detached command still running; resume later.");
	}
}

type ResumableCommand = { commandId: string; deadline: number };
const context = new AsyncLocalStorage<ResumableCommand>();

/** Long commands started inside run() are detached under commandId and re-attachable. */
export function withResumableCommand<T>(
	command: ResumableCommand,
	run: () => Promise<T>,
) {
	return context.run(command, run);
}

export function resumableCommand() {
	return context.getStore();
}
