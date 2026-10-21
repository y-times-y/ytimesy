import { posixShellQuoted } from "#/domain/posix-command";
import {
	READER_LINUX_USER,
	readerCommand,
	readerMayWrite,
	readerPreparationScript,
} from "#/domain/subagent-reader";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import type { WorkspaceMachines } from "./workspace-machines";

/** Runtime control files the reader's own runtime reads with the provider's privileges. */
const RUNTIME_READABLE = new Set<string>([PROJECT_CWD_PATH]);

const prepared = new Map<string, Promise<void>>();

/**
 * A read-only subagent's view of the shared VM (docs/subagents.md,
 * "Read-only enforcement"): every guest command runs as ytimesy-reader, so
 * the operating system refuses writes to the checkout, reads of the
 * secrets directory and signals to the builder's processes, whatever the
 * model asks for. The runtime may write files only into the reader's
 * scratch, its runtime root and one-off payload files, each handed to the
 * reader user. Provider capabilities that run as the default user (the
 * browser, language tools) are not offered.
 *
 * `base` is the unwrapped machines, used as the default user only to
 * prepare the VM and hand files over; `scope` rewrites the session's
 * runtime paths like sessionScopedWorkspaceMachines does, inside the
 * reader's command.
 */
export function readerWorkspaceMachines(
	base: WorkspaceMachines,
	input: {
		readonly sessionId: string;
		readonly sessionRoot: string;
		readonly scope: (text: string) => string;
	},
): WorkspaceMachines {
	const { sessionId, sessionRoot, scope } = input;
	const prepare = (vm: Parameters<WorkspaceMachines["exec"]>[0]) => {
		const key = `${vm}:${sessionId}`;
		let ready = prepared.get(key);
		if (!ready) {
			ready = (async () => {
				const checkout = (
					await base.readTextFile(vm, PROJECT_CWD_PATH)
				)?.trim();
				const result = await base.exec(
					vm,
					`${readerPreparationScript({
						sessionId,
						checkout: checkout?.startsWith("/") ? checkout : undefined,
					})}\nsudo -n install -d -o ${READER_LINUX_USER} -g ${READER_LINUX_USER} -m 0700 ${posixShellQuoted(sessionRoot)}`,
					30_000,
				);
				if (result.exitCode !== 0)
					throw new Error(
						`The read-only agent could not be isolated: ${result.stderr.slice(-400)}`,
					);
			})();
			prepared.set(key, ready);
			ready.catch(() => prepared.delete(key));
		}
		return ready;
	};
	const runAsReader = (
		vm: Parameters<WorkspaceMachines["exec"]>[0],
		command: string,
		timeoutMs?: number,
	) => base.exec(vm, readerCommand(sessionId, command), timeoutMs);
	return {
		...base,
		runCapability: undefined,
		exec: async (vm, command, timeoutMs) => {
			await prepare(vm);
			return runAsReader(vm, scope(command), timeoutMs);
		},
		writeTextFile: async (vm, requested, contents) => {
			const path = scope(requested);
			if (!readerMayWrite(path, sessionId, sessionRoot))
				throw new Error(
					`A read-only agent cannot write ${requested}; use its scratch directory.`,
				);
			await prepare(vm);
			await base.writeTextFile(vm, path, scope(contents));
			const handed = await base.exec(
				vm,
				`sudo -n chown ${READER_LINUX_USER}:${READER_LINUX_USER} ${posixShellQuoted(path)} && sudo -n chmod 0600 ${posixShellQuoted(path)}`,
				15_000,
			);
			if (handed.exitCode !== 0)
				throw new Error("The file could not be handed to the read-only agent.");
		},
		readTextFile: async (vm, requested) => {
			if (RUNTIME_READABLE.has(requested))
				return base.readTextFile(vm, requested);
			const path = posixShellQuoted(scope(requested));
			await prepare(vm);
			const result = await runAsReader(
				vm,
				`if [ -e ${path} ]; then cat -- ${path}; else exit 44; fi`,
				30_000,
			);
			if (result.exitCode === 44) return null;
			if (result.exitCode !== 0)
				throw new Error(`The read-only agent cannot read ${requested}.`);
			return result.stdout;
		},
	};
}

/** Test seam: forget which VMs were prepared. */
export function forgetPreparedReaders() {
	prepared.clear();
}
