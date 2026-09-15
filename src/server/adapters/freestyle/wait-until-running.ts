import type { Vm } from "freestyle";
import { WorkspaceProvisionError } from "#/server/services/errors";

export async function waitUntilVmRunning(vm: Vm, label: string) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const data = await vm.data();
		if (data.state === "running") return data;
		if (data.state === "stopped") {
			throw new WorkspaceProvisionError({
				operation: "create",
				message: `${label} stopped before it became running`,
				providerWorkspaceId: vm.id,
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new WorkspaceProvisionError({
		operation: "create",
		message: `${label} did not become running`,
		providerWorkspaceId: vm.id,
	});
}
