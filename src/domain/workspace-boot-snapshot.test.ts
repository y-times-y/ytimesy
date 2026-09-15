import { describe, expect, it } from "vitest";
import {
	toolsSnapshotIdFromEnv,
	workspaceBootSnapshotId,
} from "./workspace-boot-snapshot";

describe("workspaceBootSnapshotId", () => {
	it("prefers the user's private auth snapshot over the shared tools image", () => {
		expect(
			workspaceBootSnapshotId({
				userAuthSnapshotId: "sh-codex-auth",
				toolsSnapshotId: "sh-tools",
			}),
		).toBe("sh-codex-auth");
	});

	it("boots the tools image when the user has no auth snapshot", () => {
		expect(
			workspaceBootSnapshotId({
				userAuthSnapshotId: null,
				toolsSnapshotId: "sh-tools",
			}),
		).toBe("sh-tools");
	});

	it("leaves the default image when neither snapshot exists", () => {
		expect(
			workspaceBootSnapshotId({
				userAuthSnapshotId: "  ",
				toolsSnapshotId: undefined,
			}),
		).toBeUndefined();
	});
});

describe("toolsSnapshotIdFromEnv", () => {
	it("reads the optional tools snapshot without treating it as a user secret", () => {
		expect(
			toolsSnapshotIdFromEnv({ YTIMESY_TOOLS_SNAPSHOT_ID: "sh-tools" }),
		).toBe("sh-tools");
		expect(toolsSnapshotIdFromEnv({})).toBeUndefined();
	});
});
