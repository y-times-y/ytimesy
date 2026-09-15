import { describe, expect, it } from "vitest";
import {
	loginStatusLooksLikeGoneWorkspace,
	shouldStartDeviceCodeAfterSnapshotResume,
} from "./proof-workspace-recovery";

describe("proof workspace recovery", () => {
	it("treats a missing Freestyle VM as gone, not as a Codex login failure", () => {
		expect(
			loginStatusLooksLikeGoneWorkspace({
				stage: "failed",
				message: "VM not found",
			}),
		).toBe(true);
		expect(
			shouldStartDeviceCodeAfterSnapshotResume({
				stage: "failed",
				message: "VM not found",
			}),
		).toBe(false);
	});

	it("starts device-code on a live VM when snapshot resume fails for auth", () => {
		expect(
			shouldStartDeviceCodeAfterSnapshotResume({
				stage: "failed",
				message: "ChatGPT login is expired",
			}),
		).toBe(true);
		expect(
			loginStatusLooksLikeGoneWorkspace({
				stage: "failed",
				message: "ChatGPT login is expired",
			}),
		).toBe(false);
	});
});
