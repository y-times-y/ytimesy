import { describe, expect, it } from "vitest";
import { WorkspaceId } from "../../domain/ids";
import type { VmEnsureResponse } from "../../domain/turn-box-vm-protocol";
import type { GuestExec } from "../claude-box-tools/identity-machines";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { type BoxVmEdge, boxWorkspaceMachines } from "./turn-box-vm-machines";

function fakeWorld() {
	const world = {
		vm: "vm-1",
		paused: false,
		minted: 0,
		edgeCalls: [] as string[],
		guestCalls: [] as { token: string; command: string }[],
		now: 1_000,
	};
	const edge: BoxVmEdge = {
		ensure: async (request): Promise<VmEnsureResponse> => {
			world.edgeCalls.push("ensure");
			world.paused = false; // the account key resumes it
			if (request.knownVm === world.vm && !request.remint)
				return { vm: world.vm, grant: null };
			world.minted += 1;
			return {
				vm: world.vm,
				grant: {
					token: `scoped-${world.vm}-${world.minted}`,
					linuxUser: "ubuntu",
					redactOnVm: false,
				},
			};
		},
		pause: async () => {
			world.edgeCalls.push("pause");
			world.paused = true;
			return "paused";
		},
		op: async (request) => {
			world.edgeCalls.push(request.op);
			return request.op === "snapshotEnvironment" ? { snapshotId: "snap" } : {};
		},
		release: async () => {
			world.edgeCalls.push("release");
		},
	};
	const guest =
		(grant: { token: string }): GuestExec =>
		async (options) => {
			world.guestCalls.push({ token: grant.token, command: options.command });
			// A paused VM refuses before running anything (a 4xx), as the provider does.
			if (world.paused)
				throw Object.assign(new Error("paused"), { status: 409 });
			return { stdout: "hello", stderr: "", statusCode: 0 };
		};
	const machines = boxWorkspaceMachines({
		edge,
		guest,
		now: () => world.now,
	});
	return { world, machines };
}

describe("boxWorkspaceMachines", () => {
	it("satisfies the WorkspaceMachines interface", () => {
		const { machines } = fakeWorld();
		const asInterface: WorkspaceMachines = machines;
		expect(typeof asInterface.exec).toBe("function");
		// No account-key surface: identities are minted by the edge only.
		expect("boxToolIdentities" in machines).toBe(false);
	});

	it("costs one Worker request per turn, then none per tool call", async () => {
		const { world, machines } = fakeWorld();
		const vm = WorkspaceId("vm-1");
		expect((await machines.exec(vm, "ls")).stdout).toBe("hello");
		for (let call = 0; call < 20; call += 1) {
			await machines.exec(vm, `echo ${call}`);
			expect(await machines.readTextFile(vm, "/a")).toBe("hello");
			await machines.writeTextFile(vm, "/b", "text");
		}
		expect(world.edgeCalls).toEqual(["ensure"]);
		expect(world.guestCalls.length).toBeGreaterThan(60);
		// Every guest call used the one scoped token.
		expect(new Set(world.guestCalls.map((c) => c.token))).toEqual(
			new Set(["scoped-vm-1-1"]),
		);
	});

	it("shares one ensure between concurrent first calls", async () => {
		const { world, machines } = fakeWorld();
		const vm = WorkspaceId("vm-1");
		await Promise.all([
			machines.exec(vm, "a"),
			machines.exec(vm, "b"),
			machines.readTextFile(vm, "/c"),
		]);
		expect(world.edgeCalls).toEqual(["ensure"]);
	});

	it("resumes through the edge before the tool call after its own pause", async () => {
		const { world, machines } = fakeWorld();
		const vm = WorkspaceId("vm-1");
		await machines.exec(vm, "first");
		await machines.pause?.(vm);
		expect(world.paused).toBe(true);
		expect(await machines.isRunning(vm)).toBe(false);
		// Not a single guest command reaches the paused VM.
		const before = world.guestCalls.length;
		expect((await machines.exec(vm, "second")).exitCode).toBe(0);
		expect(world.guestCalls.length).toBe(before + 1);
		// One pause plus one resume: two edge requests for the whole cycle.
		expect(world.edgeCalls).toEqual(["ensure", "pause", "ensure"]);
		expect(world.minted).toBe(1);
	});

	it("asks the edge to resume once when the idle timeout paused it, then retries", async () => {
		const { world, machines } = fakeWorld();
		const vm = WorkspaceId("vm-1");
		await machines.exec(vm, "first");
		world.paused = true; // the provider's own idle timeout
		expect((await machines.exec(vm, "after")).stdout).toBe("hello");
		expect(world.edgeCalls).toEqual(["ensure", "ensure"]);
		expect(world.minted).toBe(1);
	});

	it("does not retry forever: a revoked token fails the call", async () => {
		const machines = boxWorkspaceMachines({
			edge: {
				ensure: async () => ({
					vm: "vm-1",
					grant: { token: "t", linuxUser: "u", redactOnVm: false },
				}),
				pause: async () => "skipped",
				op: async () => ({}),
				release: async () => {},
			},
			guest: () => async () => {
				throw Object.assign(new Error("revoked"), { status: 401 });
			},
		});
		await expect(machines.exec(WorkspaceId("vm-1"), "x")).rejects.toThrow(
			/refused/,
		);
	});

	it("routes account-key operations through the edge and refuses account-wide ones", async () => {
		const { world, machines } = fakeWorld();
		const vm = WorkspaceId("vm-1");
		await machines.exec(vm, "first");
		await machines.keepAwakeForBackground?.(vm);
		await machines.settleIdleTimeout?.(vm);
		expect(await machines.snapshotEnvironment(vm, "env")).toBe("snap");
		expect(world.edgeCalls).toEqual([
			"ensure",
			"keepAwakeForBackground",
			"settleIdleTimeout",
			"snapshotEnvironment",
		]);
		await expect(machines.destroy(vm)).rejects.toThrow(/not available/);
		await expect(machines.provisionSession("s", "snap")).rejects.toThrow(
			/not available/,
		);
		await expect(machines.exposeHttp(vm, 80, "x")).rejects.toThrow(
			/not available/,
		);
	});

	it("follows a replaced VM, with a new token, and refuses the lost VM's id", async () => {
		const { world, machines } = fakeWorld();
		await machines.exec(WorkspaceId("vm-1"), "first");
		world.vm = "vm-2";
		const replaced = await machines.ensureRunning(WorkspaceId("vm-1"));
		expect(replaced).toBe("vm-2");
		await machines.exec(WorkspaceId("vm-2"), "on the new one");
		expect(world.guestCalls.at(-1)?.token).toBe("scoped-vm-2-2");
		await expect(machines.exec(WorkspaceId("vm-1"), "old")).rejects.toThrow(
			/only the chat's own machine/,
		);
	});

	it("releases the identity through the edge", async () => {
		const { world, machines } = fakeWorld();
		await machines.release();
		expect(world.edgeCalls).toEqual(["release"]);
	});
});
