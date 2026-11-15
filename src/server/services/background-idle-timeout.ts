import { z } from "zod";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import type { SessionItem } from "#/domain/session-item";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { COMMAND_ROOTS } from "./api-agent-command-tools";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * A VM that starts a background command gets the longer idle timeout
 * (keepAwakeForBackground, product-vm.ts). This gives it back the short one
 * once no background command runs on it any more, so a chat VM pauses a
 * minute after its last traffic again instead of three.
 *
 * The machine is the record, for every chat on it (a subagent may share its
 * parent's VM): a background command runs while its `<id>.background` marker
 * has no `<id>.status` beside it and its job script (`bash <root>/<id>.sh`)
 * is still a process. `ps` sees every user's processes, so a read-only
 * helper's view of the machine counts the builder's commands too.
 */
const RUNNING_SCRIPT = `import json, pathlib, subprocess, sys
roots = pathlib.Path(sys.argv[1])
listed = subprocess.run(['ps', '-A', '-o', 'args='], capture_output=True, text=True)
if listed.returncode != 0:
    sys.exit(2)
processes = listed.stdout
running = []
if roots.is_dir() and not roots.is_symlink():
    for meta in roots.glob('*/*.background'):
        identifier = meta.name[:-len('.background')]
        if (meta.parent / (identifier + '.status')).exists():
            continue
        if str(meta.parent / (identifier + '.sh')) in processes:
            running.append(identifier)
print(json.dumps(running))`;

/** The ids of the background commands still running on the machine (any chat's). */
export async function backgroundCommandsRunningOn(
	machines: Pick<WorkspaceMachines, "exec">,
	vm: WorkspaceId,
	roots: string = COMMAND_ROOTS,
): Promise<string[]> {
	const result = await machines.exec(
		vm,
		`python3 -c ${quote(RUNNING_SCRIPT)} ${quote(roots)}`,
		15_000,
	);
	// Unknown is not "none": the caller then leaves the timeout alone.
	if (result.exitCode)
		throw new Error("Could not list the machine's background commands.");
	return z.array(z.string()).parse(JSON.parse(result.stdout));
}

export type IdleTimeoutSettlement =
	| "settled"
	| "kept"
	| "unsupported"
	| "failed";

/**
 * Best effort, never throws: when no background command runs on the VM any
 * more, sets its idle timeout back to the short one. Checked again after the
 * change: a command launched meanwhile (another chat on the same VM) gets the
 * longer timeout back, and so does one found running on the first look (a
 * launch whose raise an earlier settlement overwrote). Call it only for a VM
 * known to be running: its guest command would otherwise resume a paused VM.
 */
export async function settleBackgroundIdleTimeout(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
	options: { roots?: string } = {},
): Promise<IdleTimeoutSettlement> {
	if (!machines.settleIdleTimeout) return "unsupported";
	try {
		const running = () =>
			backgroundCommandsRunningOn(machines, vm, options.roots);
		if ((await running()).length) {
			await machines.keepAwakeForBackground?.(vm);
			return "kept";
		}
		await machines.settleIdleTimeout(vm);
		if ((await running()).length) {
			await machines.keepAwakeForBackground?.(vm);
			return "kept";
		}
		return "settled";
	} catch (error) {
		console.warn("The VM's idle timeout was not settled.", {
			vm,
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		});
		return "failed";
	}
}

/**
 * At a turn's end: a chat that ran background commands and has none open any
 * more settles its VM's idle timeout. Chats that never ran one cost nothing
 * (no guest command). The caller passes only a turn that used its machine,
 * so the check never resumes a paused VM. Never throws.
 */
export async function settleIdleTimeoutAfterTurn(
	input: AgentToolWorkspaceInput & { items: readonly SessionItem[] },
	settle: typeof settleBackgroundIdleTimeout = settleBackgroundIdleTimeout,
): Promise<IdleTimeoutSettlement | "skipped"> {
	let ranBackground = false;
	for (const item of input.items) {
		if (item.kind !== "dynamicToolCall" || !item.background) continue;
		if (item.background.exitCode === undefined) return "skipped";
		ranBackground = true;
	}
	if (!ranBackground) return "skipped";
	try {
		const { machines, vm } = await resolveToolWorkspace(input);
		return await settle(machines, vm);
	} catch (error) {
		console.warn("The VM's idle timeout was not settled.", {
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		});
		return "failed";
	}
}
