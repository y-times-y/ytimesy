import { describe, expect, it } from "vitest";
import { parseAuthSnapshotState, parseProofVmState } from "./codex-login-state";

describe("parseProofVmState", () => {
	it("keeps the snapshot a VM booted from out of Git and off the VM id", () => {
		expect(
			parseProofVmState(
				JSON.stringify({
					workspaceId: "vm_1",
					slug: "ytimesy-proof-abcd",
					startedAt: "2026-09-13T00:00:00.000Z",
					bootedFromSnapshotId: "sh-user",
				}),
			),
		).toEqual({
			workspaceId: "vm_1",
			slug: "ytimesy-proof-abcd",
			startedAt: "2026-09-13T00:00:00.000Z",
			bootedFromSnapshotId: "sh-user",
		});
	});
});

describe("parseAuthSnapshotState", () => {
	it("loads a private Codex auth snapshot id", () => {
		expect(
			parseAuthSnapshotState(
				JSON.stringify({
					snapshotId: "sh-user",
					sourceWorkspaceId: "vm_1",
					createdAt: "2026-09-13T00:00:00.000Z",
					public: false,
				}),
			),
		).toEqual({
			snapshotId: "sh-user",
			sourceWorkspaceId: "vm_1",
			createdAt: "2026-09-13T00:00:00.000Z",
			public: false,
		});
	});

	it("refuses a public snapshot record", () => {
		expect(() =>
			parseAuthSnapshotState(
				JSON.stringify({
					snapshotId: "sh-public",
					sourceWorkspaceId: "vm_1",
					createdAt: "2026-09-13T00:00:00.000Z",
					public: true,
				}),
			),
		).toThrow("credentials cannot live in a shared image");
	});
});
