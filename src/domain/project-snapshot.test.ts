import { describe, expect, it } from "vitest";
import {
	projectSnapshotNeedsRefresh,
	projectSnapshotSourceRef,
} from "./project-snapshot";

describe("projectSnapshotNeedsRefresh", () => {
	it("skips when GitHub has not given a source commit", () => {
		expect(
			projectSnapshotNeedsRefresh({
				sealedSha: "abc",
				remoteSha: null,
			}),
		).toBe(false);
	});

	it("refreshes a ready snapshot that never recorded its source commit", () => {
		expect(
			projectSnapshotNeedsRefresh({
				sealedSha: null,
				remoteSha: "abc123",
			}),
		).toBe(true);
	});

	it("skips when the sealed source commit is still HEAD", () => {
		expect(
			projectSnapshotNeedsRefresh({
				sealedSha: "ABC123",
				remoteSha: "abc123",
			}),
		).toBe(false);
	});

	it("refreshes when the clone-source branch moved", () => {
		expect(
			projectSnapshotNeedsRefresh({
				sealedSha: "old",
				remoteSha: "new",
			}),
		).toBe(true);
	});
});

describe("projectSnapshotSourceRef", () => {
	it("prefers the clone branch and falls back to default", () => {
		expect(
			projectSnapshotSourceRef({
				cloneBranch: "master",
				defaultBranch: "main",
			}),
		).toBe("master");
		expect(
			projectSnapshotSourceRef({
				cloneBranch: "",
				defaultBranch: "main",
			}),
		).toBe("main");
	});
});
