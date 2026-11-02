import { AsyncLocalStorage } from "node:async_hooks";

/** Receives a running command's latest output (its tail), as it grows. */
export type CommandOutputListener = (tail: string) => Promise<void> | void;

const context = new AsyncLocalStorage<CommandOutputListener>();

/**
 * Long commands started inside run() report their output while they run
 * (detached commands poll it; see detached-command.ts). Others report nothing.
 */
export function withCommandOutput<T>(
	listener: CommandOutputListener,
	run: () => Promise<T>,
) {
	return context.run(listener, run);
}

export function commandOutputListener() {
	return context.getStore();
}
