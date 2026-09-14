import type { PtySession, PtySessionEvents } from "freestyle";
import { Freestyle } from "freestyle";
import {
	WORKSPACE_PTY_SLUG,
	workspacePtyCommand,
} from "#/domain/workspace-terminal";
import { waitUntilVmRunning } from "./wait-until-running";

export async function openWorkspacePty(input: {
	readonly apiKey: string;
	readonly providerRef: string;
	readonly directory: string;
	readonly cols: number;
	readonly rows: number;
	readonly events: PtySessionEvents;
}): Promise<PtySession> {
	const client = new Freestyle({ apiKey: input.apiKey });
	const vm = client.vms.ref(input.providerRef);
	const data = await vm.data();
	if (data.state === "paused" || data.state === "stopped") {
		await vm.start();
	}
	await waitUntilVmRunning(vm, "Workspace VM");
	return vm.pty.open({
		slug: WORKSPACE_PTY_SLUG,
		cols: input.cols,
		rows: input.rows,
		replaceOnExit: true,
		exec: workspacePtyCommand(input.directory),
		...input.events,
	});
}
