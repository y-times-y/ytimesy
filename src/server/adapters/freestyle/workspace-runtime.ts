import { Freestyle, FreestyleApiError } from "freestyle";
import { posixShellCommand } from "#/domain/posix-command";
import { resumableCommand } from "../resumable-commands";
import {
	UnconfiguredWorkspaceRuntime,
	type WorkspaceProvisionOptions,
	type WorkspaceRuntime,
} from "../workspace-runtime";
import { boundedFreestyleFetch } from "./bounded-fetch";
import { runDetachedCommand } from "./detached-command";
import { withdrawVmEdgeRoutes } from "./edge-routes";
import { runLongCommand } from "./long-command";
import {
	FREESTYLE_EXEC_TIMEOUT_MS_MAX,
	freestyleExecTimeoutMs,
	PRODUCT_IDLE_TIMEOUT_SECONDS,
	productCreateVmFields,
	productIdleTimeoutNeedsUpdate,
} from "./product-vm";
import { retryTransientProviderFailure } from "./provider-retry";
import { forgetRunningGuest } from "./recent-guest-state";
import { scrubAgentSecrets } from "./scrub-agent-secrets";
import {
	prepareTemplateSnapshot,
	type TemplateSnapshotPreparation,
} from "./template-snapshot";
import {
	admitVmCreate,
	admitVmResume,
	infrastructureAdmissionEnabled,
} from "./usage-admission";
import { waitUntilGuestReady, waitUntilVmRunning } from "./wait-until-running";

/**
 * A command needing at most this long may reuse a recent admission: one
 * admission holds the machine's runtime for at least 300 s past its usage
 * then, which covers a 60 s reuse window plus this plus the 15 s margin.
 */
const REUSABLE_ADMISSION_SECONDS = 120;
const MAX_ADMISSION_REUSE_MS = 60_000;

export class FreestyleWorkspaceRuntime implements WorkspaceRuntime {
	/** When each machine was last admitted, for `admissionReuseMs`. */
	private readonly admittedAt = new Map<string, number>();

	constructor(
		private readonly apiKey: string,
		private readonly options: {
			fetch?: typeof fetch;
			streamSetupCommands?: boolean;
			/**
			 * An environment build runs dozens of short commands back to back on
			 * its own machine: each re-checked the machine and its admission
			 * (several provider and database reads, about 0.25 s). Within this
			 * window (at most 60 s) a short command reuses the last admission.
			 */
			admissionReuseMs?: number;
		} = {},
	) {}

	/** Admits the machine for a command (resuming it if needed), unless a recent admission covers it. */
	private async admitCommand(providerRef: string, requiredSeconds: number) {
		const reuseMs = Math.min(
			this.options.admissionReuseMs ?? 0,
			MAX_ADMISSION_REUSE_MS,
		);
		const last = this.admittedAt.get(providerRef);
		if (
			reuseMs > 0 &&
			last !== undefined &&
			Date.now() - last < reuseMs &&
			requiredSeconds <= REUSABLE_ADMISSION_SECONDS
		)
			return;
		await this.recover(providerRef, requiredSeconds);
		if (reuseMs > 0) this.admittedAt.set(providerRef, Date.now());
	}

	async findBySlug(slug: string) {
		const { vms } = await this.client().vms.list({ slug, limit: 1 });
		return vms[0]?.id ?? null;
	}

	async provision(slug: string, options?: WorkspaceProvisionOptions) {
		const existing = await this.findBySlug(slug);
		if (existing) return this.recover(existing);
		try {
			return await admitVmCreate(
				this.client(),
				slug,
				options?.snapshotId ?? "freestyle/ubuntu-sm",
				async (cap) => {
					const created = await this.client().vms.create({
						...productCreateVmFields({
							slug,
							snapshotId: options?.snapshotId,
						}),
						...(options?.maxRunSeconds
							? {
									maxRunSeconds: options.maxRunSeconds,
									maxRunTotalSeconds: options.maxRunSeconds,
									automaticRestart: false,
								}
							: {}),
						...(cap === undefined
							? {}
							: {
									maxRunTotalSeconds: Math.min(
										cap,
										options?.maxRunSeconds ?? cap,
									),
									automaticRestart: false,
								}),
					});
					await waitUntilGuestReady(created.vm, "Workspace VM");
					return created.vmId;
				},
				options?.maxRunSeconds,
			);
		} catch (cause) {
			if (cause instanceof FreestyleApiError && cause.status === 409) {
				const recovered = await this.findBySlug(slug);
				if (recovered) return this.recover(recovered);
			}
			throw cause;
		}
	}

	async recover(providerRef: string, requiredSeconds = 60) {
		return retryTransientProviderFailure(() =>
			this.resume(providerRef, requiredSeconds),
		);
	}

	private async resume(providerRef: string, requiredSeconds: number) {
		const vm = this.client().vms.ref(providerRef);
		const data = await vm.data();
		await admitVmResume(vm, data, requiredSeconds);
		if (productIdleTimeoutNeedsUpdate(data.idleTimeoutSeconds)) {
			await vm
				.update({ idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS })
				.catch(() => undefined);
		}
		if (data.state === "paused" || data.state === "stopped") {
			await vm.start();
		}
		// A machine that was not running yet has a guest that may not answer yet.
		if (data.state === "running") await waitUntilVmRunning(vm, "Workspace VM");
		else await waitUntilGuestReady(vm, "Workspace VM");
		return providerRef;
	}

	async exec(
		providerRef: string,
		argv: string[],
		env: Record<string, string>,
		timeoutMs: number,
	) {
		if (infrastructureAdmissionEnabled())
			await this.admitCommand(providerRef, Math.ceil(timeoutMs / 1000));
		const vm = this.client().vms.ref(providerRef);
		if (
			timeoutMs > FREESTYLE_EXEC_TIMEOUT_MS_MAX ||
			(this.options.streamSetupCommands && timeoutMs > 30_000)
		) {
			const resumable = resumableCommand();
			if (resumable)
				return runDetachedCommand(
					async (command) => {
						const result = await vm.exec({ command, timeoutMs: 30_000 });
						return {
							exitCode: result.statusCode ?? 124,
							stdout: result.stdout ?? "",
							stderr: result.stderr ?? "",
						};
					},
					resumable.commandId,
					argv,
					env,
					timeoutMs,
					resumable.deadline,
				);
			return runLongCommand(vm.pty, argv, env, timeoutMs);
		}
		const result = await vm.exec({
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
		if (infrastructureAdmissionEnabled())
			await this.admitCommand(providerRef, 60);
		// Writing the same contents again is harmless.
		await retryTransientProviderFailure(() =>
			this.client().vms.ref(providerRef).fs.writeTextFile(path, contents),
		);
	}

	async readTextFile(providerRef: string, path: string) {
		return retryTransientProviderFailure(() =>
			this.client().vms.ref(providerRef).fs.readTextFile(path),
		);
	}

	async snapshot(
		providerRef: string,
		slug: string,
		preparation?: TemplateSnapshotPreparation,
	) {
		if (preparation)
			await prepareTemplateSnapshot(
				this.client().vms.ref(providerRef),
				preparation,
			);
		await scrubAgentSecrets(this.client().vms.ref(providerRef));
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

	/** Also takes down the VM's desktop and tool-service routes; a later start republishes them. */
	async pause(providerRef: string) {
		const vm = this.client().vms.ref(providerRef);
		this.admittedAt.delete(providerRef);
		forgetRunningGuest(providerRef);
		await withdrawVmEdgeRoutes(this.client(), providerRef, [
			"desk",
			"tools",
		]).catch(() => 0);
		const data = await vm.data();
		if (data.state === "running") await vm.pause();
	}

	async delete(providerRef: string) {
		try {
			await this.client().vms.ref(providerRef).delete();
		} catch (error) {
			if (error instanceof FreestyleApiError && error.status === 404) return;
			throw error;
		}
	}

	async snapshotExists(snapshotId: string) {
		try {
			const snapshot = await this.client().vms.snapshots.get(snapshotId);
			return !snapshot.public;
		} catch (error) {
			if (error instanceof FreestyleApiError && error.status === 404)
				return false;
			throw error;
		}
	}

	private client() {
		return new Freestyle({
			apiKey: this.apiKey,
			fetch: this.options.fetch ?? boundedFreestyleFetch(),
		});
	}
}

export function workspaceRuntimeFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	options?: ConstructorParameters<typeof FreestyleWorkspaceRuntime>[1],
): WorkspaceRuntime {
	const apiKey = env.FREESTYLE_API_KEY?.trim();
	if (!apiKey) return new UnconfiguredWorkspaceRuntime();
	return new FreestyleWorkspaceRuntime(apiKey, options);
}
