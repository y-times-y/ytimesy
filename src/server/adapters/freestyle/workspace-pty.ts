import type { PtySession, PtySessionEvents } from "freestyle";
import { Freestyle } from "freestyle";
import {
	WORKSPACE_PTY_SLUG,
	workspacePtyCommand,
} from "#/domain/workspace-terminal";
import { boundedFreestyleFetch } from "./bounded-fetch";
import { admitVmResume } from "./usage-admission";
import { waitUntilGuestReady } from "./wait-until-running";

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
