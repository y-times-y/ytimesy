import { WorkspaceId } from "../../domain/ids";
import {
	TURN_BOX_VM_PATHS,
	type VmEnsureRequest,
	type VmEnsureResponse,
	type VmOpRequest,
	vmEnsureResponse,
	vmOpResponse,
	vmPauseResponse,
} from "../../domain/turn-box-vm-protocol";
import type { VmNetworkPolicy } from "../../domain/vm-network-policy";
import {
	BoxMachineRefused,
	type GuestExec,
	identityWorkspaceMachines,
} from "../claude-box-tools/identity-machines";
import type { WorkspaceMachines } from "../services/workspace-machines";

/**
 * `machines` for a turn runner box (docs/turn-runner-boxes.md, "Workspace
 * tools from a box"): the same interface createFreestyleWorkspaceMachines
 * satisfies, with no Freestyle account key anywhere.
 *
 * - Guest operations (exec, file reads and writes) go straight to the chat's
 *   VM through the turn's scoped Freestyle identity (identityWorkspaceMachines,
 *   as the Claude runner box's lean tools do): zero Worker requests.
 * - Everything the account key is needed for goes to the edge's `vm/*`
 *   endpoints: ensureRunning (start, resume, replace a lost VM, checkout
 *   setup, admission, minting the identity), pause, keep-awake, idle timeout,
 *   network policy, environment snapshots.
 * - Operations that act on the account or other VMs (destroy, provisioning,
 *   exposing routes, proof workspaces, orphans, snapshots' deletion) are not
 *   available on a box; they throw and the loop must not offer them.
 */
export type BoxVmEdge = {
	ensure(request: VmEnsureRequest): Promise<VmEnsureResponse>;
	pause(request: {
		vm: string;
		toolsRunning: number;
		quietSince: number;
	}): Promise<"paused" | "skipped" | "overtaken">;
	op(request: VmOpRequest): Promise<{ snapshotId?: string }>;
	release(): Promise<void>;
};

/** An HTTP failure of a `vm/*` call; `error` is the edge's code (secrets, admission, lease-lost, ...). */
export class TurnBoxVmRefused extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail?: { reason?: string; message?: string },
	) {
		super(
			detail?.message ?? `The edge refused the workspace request (${code}).`,
		);
		this.name = "TurnBoxVmRefused";
	}
}

/** `vm/*` over HTTP with the turn's grant as the bearer. `grant()` is read per call (it is renewed). */
export function turnBoxVmEdgeClient(input: {
	readonly baseUrl: string;
	readonly grant: () => string;
	readonly fetch?: typeof fetch;
}): BoxVmEdge {
	const call = async (path: string, body: unknown): Promise<unknown> => {
		const response = await (input.fetch ?? fetch)(`${input.baseUrl}${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${input.grant()}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		const payload: unknown = await response.json().catch(() => ({}));
		if (!response.ok) {
			const failed = payload as {
				error?: string;
				reason?: string;
				message?: string;
			};
			throw new TurnBoxVmRefused(
				response.status,
				failed.error ?? "unavailable",
				{ reason: failed.reason, message: failed.message },
			);
		}
		return payload;
	};
	return {
		ensure: async (request) =>
			vmEnsureResponse.parse(await call(TURN_BOX_VM_PATHS.ensure, request)),
		pause: async (request) =>
			vmPauseResponse.parse(await call(TURN_BOX_VM_PATHS.pause, request))
				.result,
		op: async (request) => {
			const { snapshotId } = vmOpResponse.parse(
				await call(TURN_BOX_VM_PATHS.op, request),
			);
			return snapshotId === undefined ? {} : { snapshotId };
		},
		release: async () => {
			await call(TURN_BOX_VM_PATHS.release, {});
		},
	};
}

function unsupported(name: string): Promise<never> {
	return Promise.reject(
		new Error(`${name} is not available on a turn runner box.`),
	);
}

export type BoxWorkspaceMachines = WorkspaceMachines & {
	/** Deletes the turn's identity at the edge (turn end). */
	readonly release: () => Promise<void>;
};

export function boxWorkspaceMachines(input: {
	readonly edge: BoxVmEdge;
	/** A direct VM exec with the scoped identity token (a Freestyle client on a real box). */
	readonly guest: (grant: {
		readonly vm: string;
		readonly token: string;
		readonly linuxUser: string;
	}) => GuestExec;
	/** Tool calls running now: a pause waits for them (the edge cannot see them). */
	readonly toolsRunning?: () => number;
	readonly now?: () => number;
	/** Tests only: the VM's env file for redaction. */
	readonly envPath?: string;
	readonly onRedacted?: () => void;
	readonly beforeWrite?: () => void;
}): BoxWorkspaceMachines {
	const now = input.now ?? Date.now;
	let inner: WorkspaceMachines | undefined;
	let vm: string | undefined;
	let token: { token: string; linuxUser: string; redactOnVm: boolean } | null =
		null;
	// The edge was asked to pause the VM; the scoped identity cannot resume
	// it (it reaches exec only), so the next guest call asks the edge first.
	let pausedByUs = false;
	let ensuring: Promise<void> | undefined;
	let quietSince = now();

	const build = () => {
		if (!vm || !token) return;
		inner = identityWorkspaceMachines({
			vmId: vm,
			exec: input.guest({ vm, token: token.token, linuxUser: token.linuxUser }),
			...(token.redactOnVm
				? {
						redactOnVm: {
							...(input.envPath ? { envPath: input.envPath } : {}),
							...(input.onRedacted ? { onRedacted: input.onRedacted } : {}),
							...(input.beforeWrite ? { beforeWrite: input.beforeWrite } : {}),
						},
					}
				: {}),
		});
	};
	/** One `vm/ensure` at a time; concurrent callers share it. */
	const ensure = (force: { remint?: boolean } = {}) => {
		ensuring ??= (async () => {
			try {
				const answered = await input.edge.ensure({
					...(vm ? { knownVm: vm } : {}),
					...(force.remint ? { remint: true } : {}),
				});
				const replaced = vm !== undefined && vm !== answered.vm;
				vm = answered.vm;
				if (answered.grant) token = answered.grant;
				else if (replaced || !token)
					throw new Error("The edge did not grant this machine's token.");
				if (answered.grant || replaced || !inner) build();
				pausedByUs = false;
			} finally {
				ensuring = undefined;
			}
		})();
		return ensuring;
	};
	/** A guest operation: ready first (first use, or after our pause); a refused-before-running call retries once after `vm/ensure`. */
	const guest = async <T>(
		workspaceId: string,
		run: (machines: WorkspaceMachines, vmId: WorkspaceId) => Promise<T>,
	): Promise<T> => {
		if (!inner || pausedByUs) await ensure();
		else if (ensuring) await ensuring;
		const active = (): [WorkspaceMachines, WorkspaceId] => {
			if (!inner || !vm) throw new Error("The machine is not ready.");
			if (workspaceId !== vm)
				throw new Error("This grant reaches only the chat's own machine.");
			return [inner, WorkspaceId(vm)];
		};
		try {
			return await run(...active());
		} catch (error) {
			// Not run (paused by the idle timeout, say): safe to ask the edge to
			// resume and try once more. A revoked token fails the same way again.
			if (!(error instanceof BoxMachineRefused)) throw error;
			await ensure();
			return run(...active());
		} finally {
			quietSince = now();
		}
	};

	const machines: BoxWorkspaceMachines = {
		exec: (id, command, timeoutMs) =>
			guest(id, (m, v) => m.exec(v, command, timeoutMs)),
		writeTextFile: (id, path, contents) =>
			guest(id, (m, v) => m.writeTextFile(v, path, contents)),
		readTextFile: (id, path) => guest(id, (m, v) => m.readTextFile(v, path)),
		ensureRunning: async () => {
			await ensure();
			return WorkspaceId(vm as string);
		},
		isRunning: async () => vm !== undefined && !pausedByUs,
		pause: async (id) => {
			if (!vm || id !== vm || pausedByUs) return;
			const result = await input.edge.pause({
				vm,
				toolsRunning: input.toolsRunning?.() ?? 0,
				quietSince,
			});
			if (result === "paused") pausedByUs = true;
		},
		keepAwakeForBackground: async (id) => {
			await input.edge.op({ op: "keepAwakeForBackground", vm: id });
		},
		settleIdleTimeout: async (id) => {
			await input.edge.op({ op: "settleIdleTimeout", vm: id });
		},
		applyNetworkPolicy: async (id, policy: VmNetworkPolicy) => {
			await input.edge.op({ op: "applyNetworkPolicy", vm: id, policy });
		},
		snapshotEnvironment: async (id, slug, sizeId) => {
			const { snapshotId } = await input.edge.op({
				op: "snapshotEnvironment",
				vm: id,
				slug,
				...(sizeId ? { sizeId } : {}),
			});
			if (!snapshotId) throw new Error("The edge returned no snapshot.");
			return snapshotId;
		},
		release: () => input.edge.release(),
		createProofWorkspace: () => unsupported("createProofWorkspace"),
		destroySnapshot: () => unsupported("destroySnapshot"),
		destroy: () => unsupported("destroy"),
		exposeHttp: () => unsupported("exposeHttp"),
		destroyOrphans: () => unsupported("destroyOrphans"),
		provisionSession: () => unsupported("provisionSession"),
	};
	return machines;
}
