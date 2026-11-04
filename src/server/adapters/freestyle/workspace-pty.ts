import type { PtySession, PtySessionEvents } from "freestyle";
import { Freestyle } from "freestyle";
import {
	WORKSPACE_PTY_SLUG,
	workspacePtyCommand,
} from "#/domain/workspace-terminal";
import { boundedFreestyleFetch } from "./bounded-fetch";
import { admitVmResume, recentAdmissionCovers } from "./usage-admission";
import { waitUntilGuestReady } from "./wait-until-running";

/** Runs one shell command on a workspace VM (the terminal's git setup); a missing status is a timeout. */
export function workspaceVmExec(apiKey: string, providerRef: string) {
	const vm = new Freestyle({
		apiKey,
		fetch: boundedFreestyleFetch(),
	}).vms.ref(providerRef);
	return async (command: string, timeoutMs: number) => {
		const result = await vm.exec({ command, timeoutMs });
		return { exitCode: result.statusCode ?? 124 };
	};
}

export async function openWorkspacePty(input: {
	readonly apiKey: string;
	readonly providerRef: string;
	readonly directory: string;
	readonly cols: number;
	readonly rows: number;
	readonly events: PtySessionEvents;
}): Promise<PtySession> {
	const client = new Freestyle({
		apiKey: input.apiKey,
		fetch: boundedFreestyleFetch(),
	});
	const vm = client.vms.ref(input.providerRef);
	const data = await vm.data();
	// A running machine admitted in the last minute (its wake, a Files read)
	// is not admitted again; anything else is.
	if (!(data.state === "running" && recentAdmissionCovers(data, 60)))
		await admitVmResume(vm, data);
	if (data.state === "paused" || data.state === "stopped") {
		await vm.start();
	}
	// A machine that was not running yet has a guest that may not answer yet;
	// a running one was just read as running.
	if (data.state !== "running") await waitUntilGuestReady(vm, "Workspace VM");
	return vm.pty.open({
		slug: WORKSPACE_PTY_SLUG,
		cols: input.cols,
		rows: input.rows,
		replaceOnExit: true,
		exec: workspacePtyCommand(input.directory),
		...input.events,
	});
}
