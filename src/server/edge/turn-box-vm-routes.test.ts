import { describe, expect, it } from "vitest";
import {
	generateTurnBoxKeyPair,
	issueTurnBoxGrant,
	TurnBoxReplayGuard,
} from "../../domain/turn-box-grant";
import { TURN_BOX_PATHS } from "../../domain/turn-box-protocol";
import { TURN_BOX_VM_PATHS } from "../../domain/turn-box-vm-protocol";
import type { ApiTurn } from "../adapters/api-turns";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { routeTurnBoxEdge, type TurnBoxEdgeOps } from "./turn-box-routes";
import type { TurnBoxVmOps } from "./turn-box-vm-routes";

const TURN = {
	id: "22222222-2222-4222-8222-222222222222",
	session_id: "11111111-1111-4111-8111-111111111111",
	user_id: "user-1",
	lease_id: "33333333-3333-4333-8333-333333333333",
	state: "running",
} as unknown as ApiTurn;
/** The Freestyle account key: held by the edge's machines only. */
const ACCOUNT_KEY = "fsk-ACCOUNT-KEY-never-on-a-box";
const NOW = 1_000_000;

async function vmEdge(
	options: {
		users?: string;
		secrets?: boolean;
		allowSecrets?: boolean;
		admit?: Awaited<ReturnType<TurnBoxVmOps["admit"]>>;
		vm?: string;
		/** The edge can hand a turn back to its chat's object. */
		handOff?: boolean;
		/** The VM cannot redact secrets itself (its probe finds no filter). */
		noRedaction?: boolean;
	} = {},
) {
	const keys = await generateTurnBoxKeyPair();
	const state = {
		running: true,
		cancel: false,
		vm: options.vm ?? "vm-1",
		identity: null as string | null,
		minted: [] as string[],
		revoked: [] as string[],
		ops: [] as string[],
		paused: 0,
		requests: [] as string[],
		responses: [] as string[],
		prepared: 0,
		handedOff: [] as string[],
	};
	const machines = {
		// The account key is in scope here, as in the real machines.
		accountKey: ACCOUNT_KEY,
		ensureRunning: async (vm: string) => vm,
		exec: async (_vm: string, command: string) =>
			command === "id -un"
				? { exitCode: 0, stdout: "ubuntu\n", stderr: "" }
				: // The redaction probe: a marker the filter prints on stderr.
					{
						exitCode: 0,
						stdout: "",
						stderr: options.noRedaction ? "" : "\nytimesy-vm-redaction:0\n",
					},
		keepAwakeForBackground: async () => {
			state.ops.push("keepAwake");
		},
		settleIdleTimeout: async () => {
			state.ops.push("settle");
		},
		applyNetworkPolicy: async () => {
			state.ops.push("policy");
		},
		snapshotEnvironment: async () => {
			state.ops.push("snapshot");
			return "snap-1";
		},
		boxToolIdentities: {
			mint: async (
				_vm: string,
				_user: string,
				record: (id: string) => Promise<boolean>,
			) => {
				const id = `identity-${state.minted.length + 1}`;
				if (!(await record(id))) return null;
				state.minted.push(id);
				return { identityId: id, token: `scoped-token-${id}` };
			},
			revoke: async (id: string) => {
				state.revoked.push(id);
			},
		},
	} as unknown as WorkspaceMachines;
	const vm: TurnBoxVmOps = {
		machines,
		prepare: async () => {
			state.prepared += 1;
			return state.vm;
		},
		currentVm: async () => state.vm,
		admit: async () => options.admit ?? { ok: true },
		hasRuntimeSecrets: async () => options.secrets === true,
		allowRuntimeSecrets: () => options.allowSecrets === true,
		identityStore: () => ({
			current: async () => state.identity,
			record: async (id) => {
				if (state.identity) return false;
				state.identity = id;
				return true;
			},
			clear: async (id) => {
				if (state.identity === id) state.identity = null;
			},
		}),
		pause: async () => {
			state.paused += 1;
			return "paused";
		},
	};
	const holds = (grant: {
		turnId: string;
		leaseId: string;
		userId: string;
		sessionId: string;
	}) =>
		state.running &&
		grant.turnId === TURN.id &&
		grant.leaseId === TURN.lease_id &&
		grant.userId === TURN.user_id &&
		grant.sessionId === TURN.session_id;
	const ops = {
		boxActive: async () => true,
		loadOwned: async (grant: Parameters<typeof holds>[0]) =>
			holds(grant) ? TURN : null,
		cancelRequested: async () => state.cancel,
		finalize: async () => "completed" as const,
		...(options.handOff
			? {
					handToObject: async (turn: { id: string }) => {
						state.handedOff.push(turn.id);
					},
				}
			: {}),
	} as unknown as TurnBoxEdgeOps;
	const replay = new TurnBoxReplayGuard();
	const fetchEdge = async (
		path: string,
		token: string | null,
		body: unknown = {},
	) => {
		const response = await routeTurnBoxEdge(
			new Request(`https://edge.test${path}`, {
				method: "POST",
				headers: {
					...(token ? { authorization: `Bearer ${token}` } : {}),
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
			{
				publicKey: keys.publicKey,
				privateKey: keys.privateKey,
				boxUsers: new Set((options.users ?? "user-1").split(",")),
				ops,
				vm,
				replay,
				forwardSocket: async () => new Response(null, { status: 500 }),
				now: () => NOW,
				log: () => {},
			},
		);
		state.requests.push(path);
		const text = await response.text();
		state.responses.push(text);
		return { status: response.status, body: text ? JSON.parse(text) : null };
	};
	const grant = (
		over: Partial<
			Record<"userId" | "sessionId" | "turnId" | "leaseId", string>
		> = {},
	) =>
		issueTurnBoxGrant(
			keys.privateKey,
			{
				userId: TURN.user_id,
				sessionId: TURN.session_id,
				turnId: TURN.id,
				leaseId: TURN.lease_id as string,
				boxId: "box-a",
				...over,
			},
			NOW,
		);
	return { state, fetchEdge, grant };
}

describe("vm/* endpoints", () => {
	it("needs a grant, and refuses another user, chat, turn or lease", async () => {
		const edge = await vmEdge({ users: "*" });
		expect((await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, null)).status).toBe(
			401,
		);
		expect(
			(await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, "ytbg1.x.y")).status,
		).toBe(401);
		for (const over of [
			{ userId: "user-2" },
			{ sessionId: "99999999-9999-4999-8999-999999999999" },
			{ turnId: "99999999-9999-4999-8999-999999999999" },
			{ leaseId: "99999999-9999-4999-8999-999999999999" },
		]) {
			const response = await edge.fetchEdge(
				TURN_BOX_VM_PATHS.ensure,
				await edge.grant(over),
			);
			expect(response.status).toBe(409);
			expect(response.body).toEqual({ error: "lease-lost" });
		}
		expect(edge.state.minted).toEqual([]);
		expect(edge.state.prepared).toBe(0);
	});

	it("is off (404) for a user outside YTIMESY_BOX_TURN_USERS", async () => {
		const edge = await vmEdge({ users: "someone-else" });
		const response = await edge.fetchEdge(
			TURN_BOX_VM_PATHS.ensure,
			await edge.grant(),
		);
		expect(response.status).toBe(404);
		expect(edge.state.minted).toEqual([]);
	});

	it("mints the scoped identity once, and again only on remint or a replaced VM", async () => {
		const edge = await vmEdge();
		const token = await edge.grant();
		const first = await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token);
		expect(first.status).toBe(200);
		expect(first.body).toEqual({
			vm: "vm-1",
			grant: {
				token: "scoped-token-identity-1",
				linuxUser: "ubuntu",
				redactOnVm: false,
			},
		});
		const again = await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token, {
			knownVm: "vm-1",
		});
		expect(again.body).toEqual({ vm: "vm-1", grant: null });
		expect(edge.state.minted).toEqual(["identity-1"]);
		// The box lost its token: the old identity goes, a new one is minted.
		const reminted = await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token, {
			knownVm: "vm-1",
			remint: true,
		});
		expect(reminted.body.grant.token).toBe("scoped-token-identity-2");
		expect(edge.state.revoked).toEqual(["identity-1"]);
		// The chat's VM was replaced: the identity naming the lost VM goes.
		edge.state.vm = "vm-2";
		const replaced = await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token, {
			knownVm: "vm-1",
		});
		expect(replaced.body.vm).toBe("vm-2");
		expect(replaced.body.grant.token).toBe("scoped-token-identity-3");
		expect(edge.state.revoked).toEqual(["identity-1", "identity-2"]);
	});

	it("revokes the identity at finalize, on Stop, and via release", async () => {
		for (const end of ["finalize", "cancel", "release"] as const) {
			const edge = await vmEdge();
			const token = await edge.grant();
			await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token);
			expect(edge.state.revoked).toEqual([]);
			if (end === "finalize")
				await edge.fetchEdge(TURN_BOX_PATHS.finalize, token, {
					state: "completed",
					items: [],
				});
			else if (end === "cancel") {
				edge.state.cancel = true;
				const stopped = await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token);
				expect(stopped.status).toBe(409);
				expect(stopped.body.error).toBe("cancelled");
			} else await edge.fetchEdge(TURN_BOX_VM_PATHS.release, token);
			expect(edge.state.revoked).toEqual(["identity-1"]);
			expect(edge.state.identity).toBeNull();
		}
	});

	it("refuses with lease loss (no new identity) once the lease moved", async () => {
		const edge = await vmEdge();
		const token = await edge.grant();
		await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token);
		edge.state.running = false;
		const lost = await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token, {
			remint: true,
		});
		expect(lost.status).toBe(409);
		expect(edge.state.minted).toEqual(["identity-1"]);
		// The old lease never revokes a successor's identity; the cron sweep
		// (staleTurnBoxToolIdentities) deletes the stale one.
		expect(edge.state.revoked).toEqual([]);
	});

	it("keeps projects with runtime secrets off unless the flag is on", async () => {
		const off = await vmEdge({ secrets: true });
		const refused = await off.fetchEdge(
			TURN_BOX_VM_PATHS.ensure,
			await off.grant(),
		);
		expect(refused.status).toBe(403);
		expect(refused.body).toEqual({ error: "secrets" });
		expect(off.state.minted).toEqual([]);
		expect(off.state.prepared).toBe(0);

		const on = await vmEdge({ secrets: true, allowSecrets: true });
		const granted = await on.fetchEdge(
			TURN_BOX_VM_PATHS.ensure,
			await on.grant(),
		);
		expect(granted.status).toBe(200);
		expect(granted.body.grant.redactOnVm).toBe(true);
	});

	it("hands a turn its box cannot run safely (secrets the VM cannot redact) to its chat's object", async () => {
		const off = await vmEdge({ secrets: true, handOff: true });
		const handed = await off.fetchEdge(
			TURN_BOX_VM_PATHS.ensure,
			await off.grant(),
		);
		expect(handed.status).toBe(409);
		expect(handed.body).toEqual({ error: "lease-lost" });
		expect(off.state.handedOff).toEqual([TURN.id]);
		expect(off.state.minted).toEqual([]);

		const blind = await vmEdge({
			secrets: true,
			allowSecrets: true,
			noRedaction: true,
			handOff: true,
		});
		const refused = await blind.fetchEdge(
			TURN_BOX_VM_PATHS.ensure,
			await blind.grant(),
		);
		expect(refused.status).toBe(409);
		expect(blind.state.handedOff).toEqual([TURN.id]);
	});

	it("is refused by admission before the VM starts or an identity is minted", async () => {
		const edge = await vmEdge({
			admit: { ok: false, reason: "usage-window", message: "Window used up." },
		});
		const response = await edge.fetchEdge(
			TURN_BOX_VM_PATHS.ensure,
			await edge.grant(),
		);
		expect(response.status).toBe(429);
		expect(response.body).toEqual({
			error: "admission",
			reason: "usage-window",
			message: "Window used up.",
		});
		expect(edge.state.prepared).toBe(0);
		expect(edge.state.minted).toEqual([]);
	});

	it("serves pause and account-key operations for the chat's own VM only", async () => {
		const edge = await vmEdge();
		const token = await edge.grant();
		const pause = await edge.fetchEdge(TURN_BOX_VM_PATHS.pause, token, {
			vm: "vm-1",
			toolsRunning: 0,
			quietSince: 5,
		});
		expect(pause.body).toEqual({ result: "paused" });
		const wrong = await edge.fetchEdge(TURN_BOX_VM_PATHS.op, token, {
			op: "keepAwakeForBackground",
			vm: "someone-elses-vm",
		});
		expect(wrong.status).toBe(409);
		expect(wrong.body).toEqual({ error: "wrong-vm" });
		for (const op of ["keepAwakeForBackground", "settleIdleTimeout"])
			expect(
				(await edge.fetchEdge(TURN_BOX_VM_PATHS.op, token, { op, vm: "vm-1" }))
					.status,
			).toBe(200);
		const snapshot = await edge.fetchEdge(TURN_BOX_VM_PATHS.op, token, {
			op: "snapshotEnvironment",
			vm: "vm-1",
			slug: "env",
		});
		expect(snapshot.body).toEqual({ ok: true, snapshotId: "snap-1" });
		// An operation outside the allowlist is a bad request, never run.
		const destroy = await edge.fetchEdge(TURN_BOX_VM_PATHS.op, token, {
			op: "destroy",
			vm: "vm-1",
		});
		expect(destroy.status).toBe(400);
		expect(edge.state.ops).toEqual(["keepAwake", "settle", "snapshot"]);
	});

	it("never sends the Freestyle account key to the box", async () => {
		const edge = await vmEdge({ secrets: true, allowSecrets: true });
		const token = await edge.grant();
		await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token);
		await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, token, { knownVm: "vm-1" });
		await edge.fetchEdge(TURN_BOX_VM_PATHS.pause, token, {
			vm: "vm-1",
			toolsRunning: 0,
			quietSince: 5,
		});
		await edge.fetchEdge(TURN_BOX_VM_PATHS.op, token, {
			op: "snapshotEnvironment",
			vm: "vm-1",
			slug: "env",
		});
		await edge.fetchEdge(TURN_BOX_VM_PATHS.ensure, null);
		await edge.fetchEdge(TURN_BOX_VM_PATHS.release, token);
		expect(edge.state.responses.length).toBeGreaterThan(5);
		for (const body of edge.state.responses) {
			expect(body).not.toContain(ACCOUNT_KEY);
			expect(body).not.toMatch(/fsk-/i);
		}
	});
});
