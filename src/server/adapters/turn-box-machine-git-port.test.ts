import { describe, expect, it, vi } from "vitest";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";

vi.mock("./database", () => ({
	database: () => {
		throw new Error("no database in this test");
	},
}));

import type { ApiTurn } from "./api-turns";
import { machineGitPort } from "./turn-box-machine-git-port";

const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function setup(over: { parentSessionId?: string | null } = {}) {
	const turn = { id: "t1", user_id: "u1", session_id: SESSION } as ApiTurn;
	const execs: { vm: string; command: string }[] = [];
	const revoked: string[] = [];
	const prepared: string[] = [];
	const machines = () =>
		({
			exec: async (vm: string, command: string) => {
				execs.push({ vm, command });
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		}) as never;
	const owner = (async () => ({
		id: SESSION,
		userId: "u1",
		parentSessionId: null,
		providerRef: "vm-own",
		...over,
	})) as never;
	const tokens = {
		mint: async () => "git-tok",
		revokeForSession: async (_user: string, session: string) => {
			revoked.push(session);
		},
	};
	const step = ((_owner: unknown) => ({
		prepareVm: async (ws: { vm: string }, before?: (t: string) => void) => {
			prepared.push(ws.vm);
			before?.("git-tok");
		},
		releaseVm: async () => {},
	})) as never;
	return {
		execs,
		revoked,
		prepared,
		call: (args: Parameters<typeof machineGitPort>[1]) =>
			machineGitPort(turn, args, { machines, owner, tokens, step }),
	};
}

describe("machine git port: the edge sets git up on the turn's own VM", () => {
	it("prepares the chat's own VM and answers the token for redaction", async () => {
		const s = setup();
		expect(await s.call({ op: "prepareVm", vm: "vm-own" })).toEqual({
			tokens: ["git-tok"],
		});
		expect(s.prepared).toEqual(["vm-own"]);
	});

	it("refuses another VM; a helper chat gets git on its own VM", async () => {
		await expect(
			setup().call({ op: "prepareVm", vm: "vm-other" }),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		const helper = setup({ parentSessionId: "root" });
		expect(await helper.call({ op: "prepareVm", vm: "vm-own" })).toEqual({
			tokens: ["git-tok"],
		});
	});

	it("release removes the token from the VM and revokes the chat's tokens, whichever request minted them", async () => {
		const s = setup();
		expect(await s.call({ op: "releaseVm", vm: "vm-own" })).toBeNull();
		expect(s.execs).toHaveLength(1);
		expect(s.execs[0]?.vm).toBe("vm-own");
		expect(s.revoked).toEqual([SESSION]);
		const noVm = setup();
		await noVm.call({ op: "releaseVm", vm: null });
		expect(noVm.execs).toHaveLength(0);
		expect(noVm.revoked).toEqual([SESSION]);
	});
});
