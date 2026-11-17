import type { z } from "zod";
import { readBoundedRequestBody } from "../../domain/bounded-request-body";
import { WorkspaceId } from "../../domain/ids";
import type { TurnBoxGrant } from "../../domain/turn-box-grant";
import { TURN_BOX_MAX_BODY_BYTES } from "../../domain/turn-box-protocol";
import {
	TURN_BOX_VM_PATHS,
	TURN_BOX_VM_PREFIX,
	type VmErrorBody,
	vmEnsureRequest,
	vmEnsureResponse,
	vmOpRequest,
	vmOpResponse,
	vmPauseRequest,
	vmPauseResponse,
} from "../../domain/turn-box-vm-protocol";
import type { ApiTurn } from "../adapters/api-turns";
import {
	type BoxToolIdentityStore,
	grantClaudeBoxTools,
	releaseClaudeBoxToolIdentity,
} from "../services/claude-box-tool-grant";
import type { WorkspaceMachines } from "../services/workspace-machines";

/**
 * The edge half of `vm/*` (docs/turn-runner-boxes.md, "Workspace tools from a
 * box"). The edge holds the Freestyle account key (inside `machines`); the box
 * gets, per turn, one Freestyle identity that may only run commands on the
 * chat's VM as its default Linux user (the phase 2a identity,
 * claude-box-tool-grant.ts), and asks the edge here for everything that needs
 * the account key. Nothing in a response carries the account key: every body
 * is parsed through a strict schema before it is sent.
 */
export interface TurnBoxVmOps {
	/**
	 * The chat's workspace is started or resumed (existing admission-free
	 * preparation: bind, resume, replace a lost VM, checkout setup) and its VM
	 * id returned. Throws when the VM cannot start.
	 */
	prepare(turn: ApiTurn): Promise<string>;
	/** The VM the chat is bound to now, without starting it; null: none. */
	currentVm(turn: ApiTurn): Promise<string | null>;
	/**
	 * Usage windows, Freestyle usage and the compute budget, as a user-started
	 * turn is admitted. `ok: false` answers 429 with the user-facing message.
	 */
	admit(turn: ApiTurn): Promise<
		| { ok: true }
		| {
				ok: false;
				reason: "usage-window" | "freestyle-usage" | "budget";
				message: string;
		  }
	>;
	/** The project has runtime secrets (their values must be redacted from output). */
	hasRuntimeSecrets(turn: ApiTurn): Promise<boolean>;
	/** The account-key machines. Never leaves the edge. */
	readonly machines: WorkspaceMachines;
	/** The turn's identity record (api_turn.box_tool_identity). */
	identityStore(turn: ApiTurn): BoxToolIdentityStore;
	/** One pause check, as the thinking pause makes it (attemptThinkingPause). */
	pause(
		turn: ApiTurn,
		vm: string,
		facts: { toolsRunning: number; quietSince: number },
	): Promise<"paused" | "skipped" | "overtaken">;
	/** YTIMESY_CLAUDE_BOX_TOOLS_SECRETS === "1" (read per call). */
	allowRuntimeSecrets(): boolean;
}

/** What the vm routes need of the stage-1 deps (a subset of TurnBoxEdgeDeps). */
export type TurnBoxVmRouteDeps = {
	readonly boxUsers: ReadonlySet<string>;
	readonly ops: {
		boxActive(boxId: string): Promise<boolean>;
		loadOwned(grant: TurnBoxGrant): Promise<ApiTurn | null>;
		cancelRequested(turn: ApiTurn): Promise<boolean>;
	};
	readonly vm: TurnBoxVmOps;
	readonly log?: (message: string, detail: Record<string, unknown>) => void;
};

export function isTurnBoxVmPath(path: string) {
	return path.startsWith(TURN_BOX_VM_PREFIX);
}

const RELEASE_PATH = TURN_BOX_VM_PATHS.release;
const failureText = (error: unknown) =>
	error instanceof Error ? error.message.slice(0, 200) : "unknown";

function reply(body: unknown, status = 200) {
	return Response.json(body, { status });
}
function refuse(
	error: VmErrorBody["error"],
	status: number,
	extra: Omit<VmErrorBody, "error"> = {},
) {
	return reply({ error, ...extra } satisfies VmErrorBody, status);
}

async function readJson(request: Request): Promise<unknown> {
	try {
		const text = await readBoundedRequestBody(request, TURN_BOX_MAX_BODY_BYTES);
		return text ? JSON.parse(text) : {};
	} catch (error) {
		return error instanceof SyntaxError ? null : undefined;
	}
}

/**
 * Deletes the turn's scoped identity (turn end, Stop, lease loss that this
 * lease still owns). Never throws; a failed delete is left for the sweep
 * (sweepClaudeBoxToolIdentities, run by the cron).
 */
export async function releaseTurnBoxVmIdentity(
	vm: Pick<TurnBoxVmOps, "machines" | "identityStore"> | undefined,
	turn: ApiTurn,
): Promise<void> {
	if (!vm) return;
	await releaseClaudeBoxToolIdentity({
		machines: vm.machines,
		store: vm.identityStore(turn),
	});
}

/**
 * Routes one verified-grant request to a `vm/*` endpoint. Order of checks:
 * POST, the user is enabled for boxes, the turn runs under exactly the
 * grant's lease for the grant's user and chat (409 lease-lost), the box is
 * not revoked, Stop was not requested (the identity is deleted then).
 */
export async function routeTurnBoxVm(
	request: Request,
	grant: TurnBoxGrant,
	deps: TurnBoxVmRouteDeps,
): Promise<Response> {
	const path = new URL(request.url).pathname;
	const paths = new Set<string>(Object.values(TURN_BOX_VM_PATHS));
	const drop = () => request.body?.cancel().catch(() => undefined);
	if (!paths.has(path) || request.method !== "POST") {
		await drop();
		return new Response(null, { status: 404 });
	}
	if (!(deps.boxUsers.has("*") || deps.boxUsers.has(grant.userId))) {
		await drop();
		return new Response(null, { status: 404 });
	}
	const body = await readJson(request);
	if (body === undefined) return refuse("bad-request", 413);
	if (body === null) return refuse("bad-request", 400);
	const log = deps.log ?? ((m, d) => console.warn(m, d));
	try {
		const turn = await deps.ops.loadOwned(grant);
		if (!turn) return refuse("lease-lost", 409);
		if (!(await deps.ops.boxActive(grant.boxId)))
			return refuse("forbidden", 403);
		if (await deps.ops.cancelRequested(turn)) {
			await releaseTurnBoxVmIdentity(deps.vm, turn);
			return refuse("cancelled", 409);
		}
		if (path === RELEASE_PATH) {
			await releaseTurnBoxVmIdentity(deps.vm, turn);
			return reply({ ok: true });
		}
		if (path === TURN_BOX_VM_PATHS.ensure) {
			const input = vmEnsureRequest.safeParse(body);
			if (!input.success) return refuse("bad-request", 400);
			return await ensure(deps, turn, input.data);
		}
		// pause and op act on the VM the chat holds now, nothing else.
		const input = (
			path === TURN_BOX_VM_PATHS.pause ? vmPauseRequest : vmOpRequest
		).safeParse(body);
		if (!input.success) return refuse("bad-request", 400);
		const data = input.data as { vm: string };
		const current = await deps.vm.currentVm(turn);
		if (!current || current !== data.vm) return refuse("wrong-vm", 409);
		if (path === TURN_BOX_VM_PATHS.pause) {
			const facts = input.data as z.infer<typeof vmPauseRequest>;
			return reply(
				vmPauseResponse.parse({
					result: await deps.vm.pause(turn, current, facts),
				}),
			);
		}
		return await runOp(
			deps.vm.machines,
			input.data as z.infer<typeof vmOpRequest>,
		);
	} catch (error) {
		log("Turn box vm request failed.", { path, message: failureText(error) });
		return refuse("unavailable", 503);
	}
}

async function ensure(
	deps: TurnBoxVmRouteDeps,
	turn: ApiTurn,
	input: z.infer<typeof vmEnsureRequest>,
): Promise<Response> {
	const { vm } = deps;
	// Runtime secrets: the box's VM token could read them (the identity runs
	// as the Linux user that owns the env file), so tools stay off the box
	// unless the owner allows it, as for the Claude runner.
	const secrets = await vm.hasRuntimeSecrets(turn);
	if (secrets && !vm.allowRuntimeSecrets()) return refuse("secrets", 403);
	const admitted = await vm.admit(turn);
	if (!admitted.ok)
		return refuse("admission", 429, {
			reason: admitted.reason,
			message: admitted.message,
		});
	// Start/resume (or replace a lost VM) first: an identity cannot, and this
	// is also what resumes a VM the thinking pause froze.
	const vmId = await vm.prepare(turn);
	const store = vm.identityStore(turn);
	if (
		!input.remint &&
		input.knownVm === vmId &&
		(await store.current()) !== null
	)
		return reply(vmEnsureResponse.parse({ vm: vmId, grant: null }));
	// grantClaudeBoxTools first deletes the turn's earlier identity (a lost
	// VM's, or a token the box lost), then mints for this VM only.
	const granted = await grantClaudeBoxTools({
		machines: vm.machines,
		vm: WorkspaceId(vmId),
		store,
		redactOnVm: secrets,
	});
	if (!granted) return refuse("unavailable", 503, { reason: "no-grant" });
	return reply(
		vmEnsureResponse.parse({
			vm: granted.vmId,
			grant: {
				token: granted.token,
				linuxUser: granted.linuxUser,
				redactOnVm: granted.redactOnVm === true,
			},
		}),
	);
}

async function runOp(
	machines: WorkspaceMachines,
	op: z.infer<typeof vmOpRequest>,
) {
	const id = WorkspaceId(op.vm);
	switch (op.op) {
		case "keepAwakeForBackground":
			await machines.keepAwakeForBackground?.(id);
			break;
		case "settleIdleTimeout":
			await machines.settleIdleTimeout?.(id);
			break;
		case "applyNetworkPolicy":
			await machines.applyNetworkPolicy?.(id, op.policy);
			break;
		case "snapshotEnvironment":
			return reply(
				vmOpResponse.parse({
					ok: true,
					snapshotId: await machines.snapshotEnvironment(
						id,
						op.slug,
						op.sizeId,
					),
				}),
			);
	}
	return reply(vmOpResponse.parse({ ok: true }));
}
