import { describe, expect, it } from "vitest";
import {
	toolsSnapshotIdFromEnv,
	toolsSnapshotIdFromRecord,
} from "./workspace-boot-snapshot";

describe("toolsSnapshotIdFromEnv", () => {
	it("reads the optional tools snapshot without treating it as a user secret", () => {
		expect(
			toolsSnapshotIdFromEnv({ YTIMESY_TOOLS_SNAPSHOT_ID: "sh-tools" }),
		).toBe("sh-tools");
		expect(toolsSnapshotIdFromEnv({})).toBeUndefined();
	});
});

describe("toolsSnapshotIdFromRecord", () => {
	it("reads a private tools snapshot id without treating it as a secret", () => {
		expect(
			toolsSnapshotIdFromRecord({
				snapshotId: "sh-tools",
				public: false,
			}),
		).toBe("sh-tools");
		expect(toolsSnapshotIdFromRecord({ snapshotId: "vm-not-a-snapshot" })).toBe(
			undefined,
		);
		expect(toolsSnapshotIdFromRecord(null)).toBeUndefined();
	});
});
