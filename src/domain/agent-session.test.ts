import { describe, expect, it } from "vitest";
import {
	agentSessionMachineSlug,
	chatsFromAgentSessions,
	projectEnvironmentSnapshotSlug,
	sessionMachinePlan,
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
});
