import { randomBytes } from "node:crypto";
import { Freestyle, FreestyleApiError, type Vm } from "freestyle";
import { WorkspaceId } from "#/domain/ids";
import {
	WorkspaceCommandError,
	WorkspaceProvisionError,
} from "#/server/services/errors";
import type {
	CommandOutput,
	ProofWorkspace,
	WorkspaceMachines,
} from "#/server/services/workspace-machines";
import {
	GUEST_INTERNET_FIREWALL,
	PROOF_METADATA_PURPOSE,
	proofWorkspaceSlug,
} from "./proof-vm";

function providerMessage(cause: unknown): string {
	if (cause instanceof FreestyleApiError) return cause.message;
	if (cause instanceof Error) return cause.message;
	return String(cause);
}

export function createFreestyleWorkspaceMachines(
	apiKey: string,
): WorkspaceMachines {
	const freestyle = new Freestyle({ apiKey });

	return {
		async createProofWorkspace(): Promise<ProofWorkspace> {
			const slug = proofWorkspaceSlug(randomBytes(4).toString("hex"));
			try {
				const created = await freestyle.vms.create({
					slug,
					displayName: "ytimesy workspace proof",
					firewall: GUEST_INTERNET_FIREWALL,
					metadata: { purpose: PROOF_METADATA_PURPOSE },
					ttlSeconds: 20 * 60,
					idleTimeoutSeconds: 10 * 60,
				});
				const running = await waitUntilRunning(created.vm);
				return {
					workspaceId: WorkspaceId(created.vmId),
					state: running.state,
					slug: running.slug ?? slug,
				};
			} catch (cause) {
				throw new WorkspaceProvisionError({
					operation: "create",
					message: providerMessage(cause),
				});
			}
		},

		async exec(
			workspaceId: WorkspaceId,
			command: string,
			timeoutMs = 120_000,
		): Promise<CommandOutput> {
			try {
				const result = await freestyle.vms.ref(workspaceId).exec({
					command,
					timeoutMs,
				});
				return {
					exitCode: result.statusCode ?? 124,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
				};
			} catch (cause) {
				throw new WorkspaceCommandError({
					operation: "exec",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async writeTextFile(
			workspaceId: WorkspaceId,
			path: string,
			contents: string,
		): Promise<void> {
			try {
				await freestyle.vms.ref(workspaceId).fs.writeTextFile(path, contents);
			} catch (cause) {
				throw new WorkspaceCommandError({
					operation: "writeFile",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async destroy(workspaceId: WorkspaceId): Promise<void> {
			try {
				await freestyle.vms.ref(workspaceId).delete();
			} catch (cause) {
				if (cause instanceof FreestyleApiError && cause.status === 404) {
					return;
				}
				throw new WorkspaceProvisionError({
					operation: "destroy",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async destroyOrphans(slugPrefix: string): Promise<readonly string[]> {
			try {
				const { vms } = await freestyle.vms.list({
					metadata: `purpose:${PROOF_METADATA_PURPOSE}`,
					limit: 50,
				});
				const deleted: string[] = [];
				for (const vm of vms) {
					if (!(vm.slug ?? "").startsWith(slugPrefix)) continue;
					await freestyle.vms.ref(vm.id).delete();
					deleted.push(vm.id);
				}
				return deleted;
			} catch (cause) {
				throw new WorkspaceProvisionError({
					operation: "reconcile",
					message: providerMessage(cause),
				});
			}
		},
	};
}

async function waitUntilRunning(vm: Vm) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const data = await vm.data();
		if (data.state === "running") return data;
		if (data.state === "stopped") {
			throw new WorkspaceProvisionError({
				operation: "create",
				message: "Proof VM stopped before it became running",
				providerWorkspaceId: vm.id,
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new WorkspaceProvisionError({
		operation: "create",
		message: "Proof VM did not become running",
		providerWorkspaceId: vm.id,
	});
}
