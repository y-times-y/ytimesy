import { Freestyle, FreestyleApiError } from "freestyle";
import { posixShellCommand } from "#/domain/posix-command";
import {
	UnconfiguredWorkspaceRuntime,
	type WorkspaceProvisionOptions,
	type WorkspaceRuntime,
} from "../workspace-runtime";
import { freestyleExecTimeoutMs, productCreateVmFields } from "./product-vm";
import { waitUntilVmRunning } from "./wait-until-running";

export class FreestyleWorkspaceRuntime implements WorkspaceRuntime {
	constructor(private readonly apiKey: string) {}

	async findBySlug(slug: string) {
		const { vms } = await this.client().vms.list({ slug, limit: 1 });
		return vms[0]?.id ?? null;
	}

	async provision(slug: string, options?: WorkspaceProvisionOptions) {
		const existing = await this.findBySlug(slug);
		if (existing) return this.recover(existing);
		try {
			const created = await this.client().vms.create(
				productCreateVmFields({
					slug,
					snapshotId: options?.snapshotId,
				}),
			);
			await waitUntilVmRunning(created.vm, "Workspace VM");
			return created.vmId;
		} catch (cause) {
			if (cause instanceof FreestyleApiError && cause.status === 409) {
				const recovered = await this.findBySlug(slug);
				if (recovered) return this.recover(recovered);
			}
			throw cause;
		}
	}

	async recover(providerRef: string) {
		const vm = this.client().vms.ref(providerRef);
		const data = await vm.data();
		if (data.state === "paused" || data.state === "stopped") {
			await vm.start();
		}
		await waitUntilVmRunning(vm, "Workspace VM");
		return providerRef;
	}

	async exec(
		providerRef: string,
		argv: string[],
		env: Record<string, string>,
		timeoutMs: number,
	) {
		const result = await this.client()
			.vms.ref(providerRef)
			.exec({
				command: posixShellCommand(argv),
				env,
				timeoutMs: freestyleExecTimeoutMs(timeoutMs),
			});
		return {
			exitCode: result.statusCode ?? 124,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	}

	async writeTextFile(providerRef: string, path: string, contents: string) {
		await this.client()
			.vms.ref(providerRef)
			.fs.writeTextFile(path, contents);
	}

	async snapshot(providerRef: string, slug: string) {
		const created = await this.client().vms.ref(providerRef).snapshot({
			slug,
			displayName: "ytimesy project environment",
			autoDeleteSeconds: -1,
		});
		if (created.snapshot.public) {
			await this.client()
				.vms.snapshots.delete(created.snapshotId)
				.catch(() => undefined);
			throw new Error(
				"Freestyle returned a public snapshot; deleted it because project checkouts cannot live in a shared image",
			);
		}
		return created.snapshotId;
	}

	async pause(providerRef: string) {
		const vm = this.client().vms.ref(providerRef);
		const data = await vm.data();
		if (data.state === "running") await vm.pause();
	}

	private client() {
		return new Freestyle({ apiKey: this.apiKey });
	}
}

export function workspaceRuntimeFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): WorkspaceRuntime {
	const apiKey = env.FREESTYLE_API_KEY?.trim();
	if (!apiKey) return new UnconfiguredWorkspaceRuntime();
	return new FreestyleWorkspaceRuntime(apiKey);
}
