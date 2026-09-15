import { describe, expect, it } from "vitest";
import { copiedSessionScratchResetCommand } from "#/domain/agent-session";
import { WorkspaceId } from "#/domain/ids";
import { executeSessionMachinePlan } from "./agent-session-machine.ts";

function machines(overrides: {
	snapshot?: string;
	copied?: string;
	failProvision?: boolean;
	failFirstProvision?: boolean;
	failMessage?: string;
	execExitCode?: number;
}) {
	const provisioned: Array<{ slug: string; snapshotId: string }> = [];
	const snapshots: string[] = [];
	const commands: string[] = [];
	const writes: Array<{ path: string; contents: string }> = [];
	let provisionAttempts = 0;
	return {
		provisioned,
		snapshots,
		commands,
		writes,
		api: {
			snapshotEnvironment: async () => {
				snapshots.push(overrides.snapshot ?? "snap-late");
				return overrides.snapshot ?? "snap-late";
			},
			provisionSession: async (slug: string, snapshotId: string) => {
				provisionAttempts += 1;
				if (overrides.failProvision) {
					throw new Error(overrides.failMessage ?? "provision must not run");
				}
				if (overrides.failFirstProvision && provisionAttempts === 1) {
					throw new Error(overrides.failMessage ?? "Snapshot not found");
				}
				provisioned.push({ slug, snapshotId });
				return WorkspaceId(overrides.copied ?? "agent-vm");
			},
			ensureRunning: async (id: string) => WorkspaceId(id),
			exec: async (_id: string, command: string) => {
				commands.push(command);
				return {
					exitCode: overrides.execExitCode ?? 0,
					stdout: "",
					stderr: "",
				};
			},
			writeTextFile: async (_id: string, path: string, contents: string) => {
				writes.push({ path, contents });
			},
		},
	};
}

describe("executeSessionMachinePlan", () => {
	it("copies the sealed project snapshot onto a new agent VM", async () => {
		const runtime = machines({ copied: "agent-vm" });
		const saved: string[] = [];
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "11111111-2222-3333-4444-555555555555",
			sessionProviderRef: null,
			workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			templateSnapshotId: "snap-1",
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async () => {
				throw new Error("snapshot already sealed");
			},
			saveSessionProviderRef: async (providerRef) => {
				saved.push(providerRef);
			},
		});
		expect(result).toEqual({
			providerRef: "agent-vm",
			planKind: "copy-snapshot",
		});
		expect(runtime.provisioned).toEqual([
			{ slug: "ytimesy-ag-1111111122223333", snapshotId: "snap-1" },
		]);
		expect(saved).toEqual(["agent-vm"]);
	});

	it("clears copied harness scratch so the new agent does not inherit the template transcript", async () => {
		const runtime = machines({ copied: "agent-vm" });
		await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "11111111-2222-3333-4444-555555555555",
			sessionProviderRef: null,
			workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			templateSnapshotId: "snap-1",
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async () => undefined,
			saveSessionProviderRef: async () => undefined,
		});
		expect(runtime.commands[0]).toBe(copiedSessionScratchResetCommand());
		expect(runtime.commands).toHaveLength(1);
		expect(runtime.commands[0]?.startsWith("rm -rf ")).toBe(true);
		expect(runtime.commands[0]).toContain("opencode.db");
		expect(runtime.commands.some((command) => command.includes("bash"))).toBe(
			false,
		);
		expect(runtime.writes).toContainEqual({
			path: "/tmp/ytimesy-opencode-status.json",
			contents: `${JSON.stringify({ stage: "missing" })}\n`,
		});
		expect(runtime.writes).toContainEqual({
			path: "/tmp/ytimesy-claude-auth-status.json",
			contents: `${JSON.stringify({ stage: "missing" })}\n`,
		});
		expect(runtime.writes).toContainEqual({
			path: "/tmp/ytimesy-auth-status.json",
			contents: `${JSON.stringify({ stage: "missing" })}\n`,
		});
		expect(
			runtime.writes.some((write) =>
				write.path.endsWith("ytimesy-opencode-serve.pid"),
			),
		).toBe(false);
	});

	it("still overwrites copied status when guest rm cannot delete sticky /tmp files", async () => {
		const runtime = machines({ copied: "agent-vm", execExitCode: 1 });
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "11111111-2222-3333-4444-555555555555",
			sessionProviderRef: null,
			workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			templateSnapshotId: "snap-1",
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async () => undefined,
			saveSessionProviderRef: async () => undefined,
		});
		expect(result.providerRef).toBe("agent-vm");
		expect(runtime.writes).toContainEqual({
			path: "/tmp/ytimesy-opencode-status.json",
			contents: `${JSON.stringify({ stage: "missing" })}\n`,
		});
	});

	it("resumes the same agent VM for later turns", async () => {
		const runtime = machines({ failProvision: true });
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "sess-1",
			sessionProviderRef: "agent-vm",
			workspaceId: "ws-1",
			templateSnapshotId: "snap-1",
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async () => undefined,
			saveSessionProviderRef: async () => {
				throw new Error("resume must not mint another VM");
			},
		});
		expect(result).toEqual({
			providerRef: "agent-vm",
			planKind: "resume",
		});
	});

	it("seals the template and copies a new agent VM instead of attaching it", async () => {
		const runtime = machines({ snapshot: "snap-first", copied: "agent-1" });
		const saved: string[] = [];
		const snapshots: string[] = [];
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "11111111-2222-3333-4444-555555555555",
			sessionProviderRef: null,
			workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			templateSnapshotId: null,
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async (snapshotId) => {
				snapshots.push(snapshotId);
			},
			saveSessionProviderRef: async (providerRef) => {
				saved.push(providerRef);
			},
		});
		expect(snapshots).toEqual(["snap-first"]);
		expect(saved).toEqual(["agent-1"]);
		expect(result).toEqual({
			providerRef: "agent-1",
			planKind: "copy-snapshot",
		});
		expect(runtime.provisioned).toEqual([
			{
				slug: "ytimesy-ag-1111111122223333",
				snapshotId: "snap-first",
			},
		]);
	});

	it("snapshots the prepared VM before copying a second agent", async () => {
		const runtime = machines({ snapshot: "snap-late", copied: "agent-2" });
		const snapshots: string[] = [];
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "22222222-3333-4444-5555-666666666666",
			sessionProviderRef: null,
			workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			templateSnapshotId: null,
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async (snapshotId) => {
				snapshots.push(snapshotId);
			},
			saveSessionProviderRef: async () => undefined,
		});
		expect(snapshots).toEqual(["snap-late"]);
		expect(result).toEqual({
			providerRef: "agent-2",
			planKind: "copy-snapshot",
		});
		expect(runtime.provisioned[0]?.snapshotId).toBe("snap-late");
	});

	it("reseals the template when the stored snapshot is gone, then copies", async () => {
		const runtime = machines({
			failFirstProvision: true,
			failMessage: "Snapshot sh-old not found",
			snapshot: "snap-resealed",
			copied: "agent-recovered",
		});
		const snapshots: string[] = [];
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "11111111-2222-3333-4444-555555555555",
			sessionProviderRef: null,
			workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			templateSnapshotId: "sh-old",
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async (snapshotId) => {
				snapshots.push(snapshotId);
			},
			saveSessionProviderRef: async () => undefined,
		});
		expect(snapshots).toEqual(["snap-resealed"]);
		expect(runtime.provisioned).toEqual([
			{
				slug: "ytimesy-ag-1111111122223333",
				snapshotId: "snap-resealed",
			},
		]);
		expect(result).toEqual({
			providerRef: "agent-recovered",
			planKind: "copy-snapshot",
		});
	});

	it("does not reseal the template when Freestyle is at the VM cap", async () => {
		const runtime = machines({
			failProvision: true,
			failMessage: "LIMIT_EXCEEDED: limit of 5 VMs",
		});
		const snapshots: string[] = [];
		const waits: number[] = [];
		await expect(
			executeSessionMachinePlan({
				machines: runtime.api,
				sessionId: "11111111-2222-3333-4444-555555555555",
				sessionProviderRef: null,
				workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				templateSnapshotId: "snap-1",
				templateProviderRef: "repo-vm",
				saveTemplateSnapshot: async (snapshotId) => {
					snapshots.push(snapshotId);
				},
				saveSessionProviderRef: async () => undefined,
				wait: async (ms) => {
					waits.push(ms);
				},
			}),
		).rejects.toThrow(/LIMIT_EXCEEDED/);
		expect(snapshots).toEqual([]);
		expect(runtime.provisioned).toEqual([]);
		expect(waits).toEqual([4_000, 8_000, 16_000]);
	});

	it("retries a copy when Freestyle still reports the cap after a delete", async () => {
		const runtime = machines({
			failFirstProvision: true,
			failMessage: "LIMIT_EXCEEDED: limit of 5 VMs",
			copied: "agent-after-lag",
		});
		const waits: number[] = [];
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "11111111-2222-3333-4444-555555555555",
			sessionProviderRef: null,
			workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			templateSnapshotId: "snap-1",
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async () => {
				throw new Error("snapshot already sealed");
			},
			saveSessionProviderRef: async () => undefined,
			wait: async (ms) => {
				waits.push(ms);
			},
		});
		expect(result).toEqual({
			providerRef: "agent-after-lag",
			planKind: "copy-snapshot",
		});
		expect(runtime.provisioned).toEqual([
			{ slug: "ytimesy-ag-1111111122223333", snapshotId: "snap-1" },
		]);
		expect(waits).toEqual([4_000]);
	});

	it("retries a copy when the adapter already rewrote the VM cap error", async () => {
		const runtime = machines({
			failFirstProvision: true,
			failMessage:
				"This Freestyle plan is at its VM limit. Delete an unused agent session or raise the quota before starting another. Pausing a VM does not free a slot.",
			copied: "agent-after-rewrite",
		});
		const waits: number[] = [];
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "11111111-2222-3333-4444-555555555555",
			sessionProviderRef: null,
			workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			templateSnapshotId: "snap-1",
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async () => {
				throw new Error("snapshot already sealed");
			},
			saveSessionProviderRef: async () => undefined,
			wait: async (ms) => {
				waits.push(ms);
			},
		});
		expect(result).toEqual({
			providerRef: "agent-after-rewrite",
			planKind: "copy-snapshot",
		});
		expect(waits).toEqual([4_000]);
	});
});
