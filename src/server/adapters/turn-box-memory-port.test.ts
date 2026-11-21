import { describe, expect, it, vi } from "vitest";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";

vi.mock("./database", () => ({
	database: () => {
		throw new Error("no database in this test");
	},
}));

import type { ApiTurn } from "./api-turns";
import { memoryPort } from "./turn-box-memory-port";

const chat: {
	id: string;
	userId: string;
	projectId: string;
	parentSessionId: string | null;
	providerRef: string;
} = {
	id: "s1",
	userId: "u1",
	projectId: "p1",
	parentSessionId: null,
	providerRef: "vm-own",
};
function setup(over: Partial<typeof chat> = {}, turnId = "t1") {
	const turn = { id: turnId, user_id: "u1", session_id: "s1" } as ApiTurn;
	const calls: { op: string; vm?: string }[] = [];
	const execs: string[] = [];
	const memory = (async () => ({
		mode: "full",
		instructions: "use memory",
		prepareVm: async (ws: { vm: string }, before?: (t: string) => void) => {
			calls.push({ op: "prepareVm", vm: ws.vm });
			before?.("tok-1");
		},
		vmTokens: () => ["tok-1"],
		releaseVm: async (ws?: { vm: string }) => {
			calls.push({ op: "releaseVm", vm: ws?.vm });
		},
		memoryParts: async () => ({ at: 0, parts: ["<memory>x"], recall: {} }),
		attach: async () => ({ messages: [], recall: null }),
		recordSaved: async (items: unknown[]) => items,
		afterTurn: async () => {
			calls.push({ op: "afterTurn" });
		},
	})) as never;
	const machines = () =>
		({
			exec: async (_vm: string, command: string) => {
				execs.push(command);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		}) as never;
	const owner = (async () => ({ ...chat, ...over })) as never;
	return {
		calls,
		execs,
		call: (args: Parameters<typeof memoryPort>[1]) =>
			memoryPort(turn, args, { memory, machines, owner }),
	};
}

describe("memory port: the edge runs memory on the turn's own chat and VM", () => {
	it("starts, clones on the chat's own VM and answers the token for redaction", async () => {
		const s = setup();
		expect(await s.call({ op: "init" })).toEqual({
			mode: "full",
			instructions: "use memory",
		});
		expect(await s.call({ op: "prepareVm", vm: "vm-own" })).toEqual({
			tokens: ["tok-1"],
		});
		expect(s.calls).toEqual([{ op: "prepareVm", vm: "vm-own" }]);
	});

	it("refuses another VM, and a helper chat", async () => {
		const s = setup({}, "t2");
		await expect(
			s.call({ op: "prepareVm", vm: "vm-someone-else" }),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		await expect(
			s.call({ op: "releaseVm", vm: "vm-someone-else", scrub: true }),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
		const helper = setup({ parentSessionId: "root" }, "t3");
		await expect(helper.call({ op: "init" })).rejects.toBeInstanceOf(
			TurnBoxPortForbidden,
		);
	});

	it("scrubs the clone on release when the box had a token", async () => {
		const s = setup({}, "t4");
		await s.call({ op: "releaseVm", vm: "vm-own", scrub: true });
		expect(s.calls).toEqual([{ op: "releaseVm", vm: "vm-own" }]);
		expect(s.execs.length).toBe(1);
		expect(s.execs[0]).toContain("extraheader");
	});

	it("queues the save hook for the turn itself", async () => {
		const s = setup({}, "t5");
		await s.call({ op: "afterTurn" });
		expect(s.calls).toEqual([{ op: "afterTurn" }]);
	});
});
