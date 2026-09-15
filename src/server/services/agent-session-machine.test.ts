import { describe, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { executeSessionMachinePlan } from "./agent-session-machine.ts";

function machines(overrides: {
	snapshot?: string;
	copied?: string;
	failProvision?: boolean;
}) {
	const provisioned: Array<{ slug: string; snapshotId: string }> = [];
	const snapshots: string[] = [];
	return {
		provisioned,
		snapshots,
		api: {
			snapshotEnvironment: async () => {
				snapshots.push(overrides.snapshot ?? "snap-late");
				return overrides.snapshot ?? "snap-late";
			},
			provisionSession: async (slug: string, snapshotId: string) => {
				if (overrides.failProvision)
					throw new Error("provision must not run");
				provisioned.push({ slug, snapshotId });
				return WorkspaceId(overrides.copied ?? "agent-vm");
			},
			ensureRunning: async (id: string) => WorkspaceId(id),
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
			templateAlreadyBound: true,
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

	it("resumes the same agent VM for later turns", async () => {
		const runtime = machines({ failProvision: true });
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "sess-1",
			sessionProviderRef: "agent-vm",
			workspaceId: "ws-1",
			templateSnapshotId: "snap-1",
			templateProviderRef: "repo-vm",
			templateAlreadyBound: true,
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

	it("attaches the prepared VM once before a snapshot exists", async () => {
		const runtime = machines({ failProvision: true });
		const saved: string[] = [];
		const result = await executeSessionMachinePlan({
			machines: runtime.api,
			sessionId: "sess-1",
			sessionProviderRef: null,
			workspaceId: "ws-1",
			templateSnapshotId: null,
			templateProviderRef: "repo-vm",
			templateAlreadyBound: false,
			saveTemplateSnapshot: async () => undefined,
			saveSessionProviderRef: async (providerRef) => {
				saved.push(providerRef);
			},
		});
		expect(result.planKind).toBe("attach-legacy");
		expect(saved).toEqual(["repo-vm"]);
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
			templateAlreadyBound: true,
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
});
