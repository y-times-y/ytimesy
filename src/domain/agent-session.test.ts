import { describe, expect, it } from "vitest";
import {
	agentSessionMachineSlug,
	chatsFromAgentSessions,
	copiedSessionScratchFileResetCommand,
	copiedSessionScratchResetCommands,
	projectEnvironmentSnapshotSlug,
	sessionMachinePlan,
	sessionMachineRefsToDestroy,
} from "./agent-session";

describe("sessionMachinePlan", () => {
	it("resumes a session that already has its own VM", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: "vm-session",
				templateSnapshotId: "sh-template",
				templateProviderRef: "vm-template",
				templateAlreadyBound: true,
			}),
		).toEqual({ kind: "resume", providerRef: "vm-session" });
	});

	it("copies from the project snapshot for a new session", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: null,
				templateSnapshotId: "sh-template",
				templateProviderRef: "vm-template",
				templateAlreadyBound: true,
			}),
		).toEqual({ kind: "copy-snapshot", snapshotId: "sh-template" });
	});

	it("attaches the prepared VM once when no snapshot exists yet", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: null,
				templateSnapshotId: null,
				templateProviderRef: "vm-template",
				templateAlreadyBound: false,
			}),
		).toEqual({ kind: "attach-legacy", providerRef: "vm-template" });
	});

	it("snapshots the prepared VM before a second agent can start", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: null,
				templateSnapshotId: null,
				templateProviderRef: "vm-template",
				templateAlreadyBound: true,
			}),
		).toEqual({ kind: "needs-snapshot", providerRef: "vm-template" });
	});

	it("blocks when the project environment is missing", () => {
		expect(
			sessionMachinePlan({
				sessionProviderRef: null,
				templateSnapshotId: null,
				templateProviderRef: null,
				templateAlreadyBound: false,
			}),
		).toEqual({
			kind: "blocked",
			reason: "Prepare a project environment before starting an agent.",
		});
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
			{ id: "s1", title: "fix login" },
			{ id: "s2", title: "add snapshot copy" },
		]);
	});

	it("hides side-chat children from the sidebar", () => {
		expect(
			chatsFromAgentSessions([
				{ id: "s1", title: "fix login", parentSessionId: null },
				{ id: "side", title: "Side chat", parentSessionId: "s1" },
			]),
		).toEqual([{ id: "s1", title: "fix login" }]);
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
	it("clears harness leftovers with direct rm so Freestyle exec does not need a shell", () => {
		const [files, databases, trees] = copiedSessionScratchResetCommands();
		expect(files.startsWith("rm -f ")).toBe(true);
		expect(databases.startsWith("rm -f ")).toBe(true);
		expect(trees.startsWith("rm -rf ")).toBe(true);
		expect(files).toContain("/tmp/ytimesy-opencode-status.json");
		expect(files).toContain("/tmp/ytimesy-claude-auth-status.json");
		expect(files).toContain("/tmp/ytimesy-auth-status.json");
		expect(databases).toContain(
			"/home/ubuntu/.local/share/opencode/opencode.db",
		);
		expect(trees).toContain("/home/ubuntu/.codex/sessions");
		expect(files.includes("bash")).toBe(false);
		expect(databases.includes("bash")).toBe(false);
		expect(trees.includes("bash")).toBe(false);
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

	it("deletes the agent copy and its side-chat copy", () => {
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
