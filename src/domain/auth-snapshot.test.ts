import { describe, expect, it } from "vitest";
import { isolatedAuthSnapshot } from "./auth-snapshot";
import { AuthSnapshotId, WorkspaceId } from "./ids";

describe("isolatedAuthSnapshot", () => {
	it("records a private Freestyle snapshot of user Codex state", () => {
		expect(
			isolatedAuthSnapshot({
				snapshotId: " sh-private ",
				sourceWorkspaceId: WorkspaceId("vm_1"),
				public: false,
			}),
		).toEqual({
			snapshotId: AuthSnapshotId("sh-private"),
			sourceWorkspaceId: WorkspaceId("vm_1"),
			public: false,
		});
	});

	it("refuses a public snapshot so ChatGPT credentials cannot become a shared image", () => {
		expect(() =>
			isolatedAuthSnapshot({
				snapshotId: "sh-public",
				sourceWorkspaceId: WorkspaceId("vm_1"),
				public: true,
			}),
		).toThrow("shared base images cannot contain user secrets");
	});
});
