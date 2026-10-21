import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FORK_SNAPSHOT_AUTO_DELETE_SECONDS, forkRunningVm } from "./fork-vm";

function source(isPublic = false) {
	return {
		snapshot: vi.fn(async () => ({
			snapshotId: "snap-1",
			snapshot: { id: "snap-1", public: isPublic },
		})),
		exec: vi.fn(),
	};
}

describe("forking a live VM for a writer", () => {
	it("snapshots without scrubbing secrets, boots the fork, then deletes the snapshot", async () => {
		const vm = source();
		const order: string[] = [];
		const boot = vi.fn(async (snapshotId: string) => {
			order.push(`boot:${snapshotId}`);
			return "vm-fork";
		});
		const deleteSnapshot = vi.fn(async (snapshotId: string) => {
			order.push(`delete:${snapshotId}`);
		});
		let clock = 1000;
		const fork = await forkRunningVm({
			source: vm as never,
			sourceVmId: "vm-parent",
			boot,
			deleteSnapshot,
			scrubFork: async (vmId) => {
				order.push(`scrub:${vmId}`);
			},
			deleteVm: async () => {},
			now: () => (clock += 2500),
		});
		expect(fork).toEqual({
			vmId: "vm-fork",
			snapshotId: "snap-1",
			forkMs: 2500,
		});
		// No command ran on the parent: its secrets directory is untouched.
		expect(vm.exec).not.toHaveBeenCalled();
		expect(vm.snapshot).toHaveBeenCalledWith({
			displayName: "ytimesy subagent fork",
			autoDeleteSeconds: FORK_SNAPSHOT_AUTO_DELETE_SECONDS,
		});
		expect(order).toEqual(["boot:snap-1", "scrub:vm-fork", "delete:snap-1"]);
	});

	it("deletes a public snapshot and refuses the fork", async () => {
		const deleteSnapshot = vi.fn(async () => {});
		const boot = vi.fn();
		await expect(
			forkRunningVm({
				source: source(true) as never,
				sourceVmId: "vm-parent",
				boot,
				deleteSnapshot,
				scrubFork: async () => {},
				deleteVm: async () => {},
			}),
		).rejects.toThrow("public snapshot");
		expect(deleteSnapshot).toHaveBeenCalledWith("snap-1");
		expect(boot).not.toHaveBeenCalled();
	});

	it("still deletes the snapshot when the fork fails to boot", async () => {
		const deleteSnapshot = vi.fn(async () => {});
		await expect(
			forkRunningVm({
				source: source() as never,
				sourceVmId: "vm-parent",
				boot: async () => {
					throw new Error("no capacity");
				},
				deleteSnapshot,
				scrubFork: async () => {},
				deleteVm: async () => {},
			}),
		).rejects.toThrow("no capacity");
		expect(deleteSnapshot).toHaveBeenCalledWith("snap-1");
	});

	it("gives the fork no memory token: a fork it cannot scrub is deleted and refused", async () => {
		const deleteSnapshot = vi.fn(async () => {});
		const deleteVm = vi.fn(async () => {});
		await expect(
			forkRunningVm({
				source: source() as never,
				sourceVmId: "vm-parent",
				boot: async () => "vm-fork",
				deleteSnapshot,
				scrubFork: async () => {
					throw new Error("the memory clone still holds a token");
				},
				deleteVm,
			}),
		).rejects.toThrow("memory token could not be removed");
		expect(deleteVm).toHaveBeenCalledWith("vm-fork");
		expect(deleteSnapshot).toHaveBeenCalledWith("snap-1");
		// The adapter scrubs the fork with the same proof as a snapshot does.
		const adapter = readFileSync(
			"src/server/adapters/freestyle/workspace-machines.ts",
			"utf8",
		);
		const fork = adapter.slice(
			adapter.indexOf("async forkWorkspace("),
			adapter.indexOf("async provisionSession("),
		);
		expect(fork).toMatch(/scrubFork: async[\s\S]*SCRUB_MEMORY_CREDENTIAL/);
	});

	it("is the only snapshot path in the adapter without scrubAgentSecrets", () => {
		const adapter = readFileSync(
			"src/server/adapters/freestyle/workspace-machines.ts",
			"utf8",
		);
		const fork = adapter.slice(
			adapter.indexOf("async forkWorkspace("),
			adapter.indexOf("async provisionSession("),
		);
		expect(fork).toContain("forkRunningVm(");
		expect(fork).not.toContain("scrubAgentSecrets");
		expect(
			readFileSync("src/server/adapters/freestyle/fork-vm.ts", "utf8"),
		).not.toMatch(/import .*scrubAgentSecrets/);
	});
});
