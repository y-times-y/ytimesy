import { describe, expect, it } from "vitest";
import {
	agentSessionMachineSlug,
	chatsFromAgentSessions,
	copiedAgentMachineRef,
	copiedSessionScratchFileResetCommand,
	copiedSessionScratchResetCommand,
	copiedSessionScratchResetCommands,
	projectEnvironmentSnapshotSlug,
	sessionMachinePlan,
	sessionMachineRefsToDestroy,
	sessionTurnStatusForPersist,
	shouldResealProjectSnapshotAfterCopyFailure,
	workspaceCopyCapacityRetryDelaysMs,
} from "./agent-session";

describe("sessionMachinePlan", () => {
	it("resumes a session that already has its own VM", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: "vm-session",
				templateSnapshotId: "sh-template",
				templateProviderRef: "vm-template",
			}),
		).toEqual({ kind: "resume", providerRef: "vm-session" });
	});

	it("copies from the project snapshot for a new session", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: null,
				templateSnapshotId: "sh-template",
				templateProviderRef: "vm-template",
			}),
		).toEqual({ kind: "copy-snapshot", snapshotId: "sh-template" });
	});

	it("copies from the snapshot when the unused template VM is gone", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: null,
				templateSnapshotId: "sh-template",
				templateProviderRef: null,
			}),
		).toEqual({ kind: "copy-snapshot", snapshotId: "sh-template" });
	});

	it("seals the template before the first agent instead of attaching it", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: null,
				templateSnapshotId: null,
				templateProviderRef: "vm-template",
			}),
		).toEqual({ kind: "needs-snapshot", providerRef: "vm-template" });
	});

	it("blocks when the project environment is missing", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: null,
				templateSnapshotId: null,
				templateProviderRef: null,
			}),
		).toEqual({
			kind: "blocked",
			reason: "Prepare a project environment before starting an agent.",
		});
	});
});

describe("shouldResealProjectSnapshotAfterCopyFailure", () => {
	it("reseals when Freestyle dropped the snapshot, not when the VM cap is full", () => {
		expect(
			shouldResealProjectSnapshotAfterCopyFailure("Snapshot sh-old not found"),
		).toBe(true);
		expect(
			shouldResealProjectSnapshotAfterCopyFailure(
				"snapshot expired after auto-delete",
			),
		).toBe(true);
		expect(
			shouldResealProjectSnapshotAfterCopyFailure(
				"LIMIT_EXCEEDED: limit of 5 VMs",
			),
		).toBe(false);
		expect(
			shouldResealProjectSnapshotAfterCopyFailure(
				"This Freestyle plan is at its VM limit. Delete an unused agent session or raise the quota before starting another. Pausing a VM does not free a slot.",
			),
		).toBe(false);
	});
});

describe("workspaceCopyCapacityRetryDelaysMs", () => {
	it("retries a stale VM cap and does not retry other copy failures", () => {
		expect(
			workspaceCopyCapacityRetryDelaysMs("LIMIT_EXCEEDED: limit of 5 VMs"),
		).toEqual([4_000, 8_000, 16_000]);
		expect(
			workspaceCopyCapacityRetryDelaysMs(
				"This Freestyle plan is at its VM limit. Delete an unused agent session or raise the quota before starting another. Pausing a VM does not free a slot.",
			),
		).toEqual([4_000, 8_000, 16_000]);
		expect(
			workspaceCopyCapacityRetryDelaysMs("Snapshot sh-old not found"),
		).toEqual([]);
	});
});

describe("agent session names", () => {
	it("keeps Freestyle slugs short and stable", () => {
		expect(
			projectEnvironmentSnapshotSlug("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
		).toBe("ytimesy-pe-aaaaaaaabbbbcccc");
		expect(
			agentSessionMachineSlug("11111111-2222-3333-4444-555555555555"),
		).toBe("ytimesy-ag-1111111122223333");
	});

	it("lists saved sessions as sidebar chats", () => {
		expect(
			chatsFromAgentSessions([
				{ id: "s1", title: "fix login" },
				{ id: "s2", title: "add snapshot copy" },
			]),
		).toEqual([
			{
				id: "s1",
				title: "fix login",
				turnStatus: "idle",
				listedModelId: null,
				harnessId: null,
				updatedAt: null,
				workspaceId: null,
			},
			{
				id: "s2",
				title: "add snapshot copy",
				turnStatus: "idle",
				listedModelId: null,
				harnessId: null,
				updatedAt: null,
				workspaceId: null,
			},
		]);
	});

	it("keeps a running turn on the sidebar row", () => {
		expect(
			chatsFromAgentSessions([
				{ id: "s1", title: "fix login", turnStatus: "running" },
			]),
		).toEqual([
			{
				id: "s1",
				title: "fix login",
				turnStatus: "running",
				listedModelId: null,
				harnessId: null,
				updatedAt: null,
				workspaceId: null,
			},
		]);
	});

	it("keeps the last listed model on the sidebar row", () => {
		expect(
			chatsFromAgentSessions([
				{
					id: "s1",
					title: "fix login",
					listedModelId: "opencode/big-pickle",
					harness: "api",
				},
			]),
		).toEqual([
			{
				id: "s1",
				title: "fix login",
				turnStatus: "idle",
				listedModelId: "opencode/big-pickle",
				harnessId: "api",
				updatedAt: null,
				workspaceId: null,
			},
		]);
	});

	it("hides child sessions from the sidebar", () => {
		expect(
			chatsFromAgentSessions([
				{ id: "s1", title: "fix login", parentSessionId: null },
				{ id: "child", title: "Child task", parentSessionId: "s1" },
			]),
		).toEqual([
			{
				id: "s1",
				title: "fix login",
				turnStatus: "idle",
				listedModelId: null,
				harnessId: null,
				updatedAt: null,
				workspaceId: null,
			},
		]);
	});
});

describe("sessionTurnStatusForPersist", () => {
	it("does not overwrite a stored running turn on a paused disconnect", () => {
		expect(
			sessionTurnStatusForPersist({
				liveStatus: "idle",
				liveConnection: "disconnected",
			}),
		).toBeUndefined();
	});

	it("takes the live harness status once that VM is connected", () => {
		expect(
			sessionTurnStatusForPersist({
				liveStatus: "completed",
				liveConnection: "authenticated",
			}),
		).toBe("completed");
		expect(
			sessionTurnStatusForPersist({
				liveStatus: "failed",
				liveConnection: "failed",
			}),
		).toBe("failed");
		expect(
			sessionTurnStatusForPersist({
				liveStatus: "idle",
				liveConnection: "authenticated",
				storedStatus: "running",
			}),
		).toBeUndefined();
		expect(
			sessionTurnStatusForPersist({
				liveStatus: "completed",
				liveConnection: "authenticated",
				storedStatus: "running",
				storedLastUser: "list the files",
				liveLastUser: "tell me a joke",
			}),
		).toBeUndefined();
	});
});

describe("copiedSessionScratchFileResetCommand", () => {
	it("is a direct rm so Freestyle exec does not need a shell", () => {
		expect(copiedSessionScratchFileResetCommand()).toBe(
			"rm -f /tmp/ytimesy-opencode-status.json /tmp/ytimesy-claude-auth-status.json /tmp/ytimesy-auth-status.json /tmp/ytimesy-opencode-serve.pid /tmp/ytimesy-opencode-serve.log /tmp/ytimesy-opencode-http-body /tmp/ytimesy-opencode-auth.json /tmp/ytimesy-opencode-auth-result.txt /tmp/ytimesy-task-request.json /tmp/ytimesy-task-result.json /tmp/ytimesy-side-request.json /tmp/ytimesy-side-result.json /tmp/ytimesy-project-context.md",
		);
	});
});

describe("copiedSessionScratchResetCommands", () => {
	it("clears harness leftovers with one direct rm so Freestyle exec does not need a shell", () => {
		const [reset] = copiedSessionScratchResetCommands();
		expect(reset).toBe(copiedSessionScratchResetCommand());
		expect(reset.startsWith("rm -rf ")).toBe(true);
		expect(reset).toContain("/tmp/ytimesy-opencode-status.json");
		expect(reset).toContain("/tmp/ytimesy-claude-auth-status.json");
		expect(reset).toContain("/tmp/ytimesy-auth-status.json");
		expect(reset).toContain("/home/ubuntu/.local/share/opencode/opencode.db");
		expect(reset).toContain("/home/ubuntu/.codex/sessions");
		expect(reset.includes("bash")).toBe(false);
	});
});

describe("sessionMachineRefsToDestroy", () => {
	it("never deletes the project environment VM", () => {
		expect(
			sessionMachineRefsToDestroy({
				sessionProviderRef: "vm-template",
				childProviderRefs: ["vm-side", "vm-template"],
				templateProviderRef: "vm-template",
			}),
		).toEqual(["vm-side"]);
	});

	it("deletes the agent copy and its child copies", () => {
		expect(
			sessionMachineRefsToDestroy({
				sessionProviderRef: "vm-a",
				childProviderRefs: ["vm-b"],
				templateProviderRef: "vm-template",
			}),
		).toEqual(["vm-a", "vm-b"]);
	});

	it("destroys nothing when the chat still shares the template VM", () => {
		expect(
			sessionMachineRefsToDestroy({
				sessionProviderRef: "vm-template",
				templateProviderRef: "vm-template",
			}),
		).toEqual([]);
	});
});

describe("copiedAgentMachineRef", () => {
	it("returns the session copy and never the unused template", () => {
		expect(
			copiedAgentMachineRef({
				sessionProviderRef: "vm-a",
				templateProviderRef: "vm-template",
			}),
		).toBe("vm-a");
		expect(
			copiedAgentMachineRef({
				sessionProviderRef: "vm-template",
				templateProviderRef: "vm-template",
			}),
		).toBeNull();
		expect(
			copiedAgentMachineRef({
				sessionProviderRef: null,
				templateProviderRef: "vm-template",
			}),
		).toBeNull();
	});
});
