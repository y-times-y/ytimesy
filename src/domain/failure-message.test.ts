import { describe, expect, it } from "vitest";
import {
	failureMessage,
	isWorkspaceAtCapacity,
	workspaceLooksGone,
} from "./failure-message";

describe("failureMessage", () => {
	it("unwraps Effect.tryPromise UnknownException to the inner error", () => {
		expect(
			failureMessage({
				_tag: "UnknownException",
				message: "An unknown error occurred in Effect.tryPromise",
				error: {
					_tag: "WorkspaceCommandError",
					message: "VM not found",
				},
			}),
		).toBe("VM not found");
	});

	it("keeps a normal Error message", () => {
		expect(failureMessage(new Error("Desktop failed to start."))).toBe(
			"Desktop failed to start.",
		);
	});
});

describe("workspaceLooksGone", () => {
	it("recognizes a missing Freestyle VM", () => {
		expect(workspaceLooksGone("VM not found")).toBe(true);
		expect(workspaceLooksGone("No such VM in this team")).toBe(true);
		expect(workspaceLooksGone("Freestyle API 404")).toBe(true);
		expect(workspaceLooksGone("Codex login timed out")).toBe(false);
		expect(workspaceLooksGone("codex binary not found")).toBe(false);
	});
});

describe("isWorkspaceAtCapacity", () => {
	it("recognizes the Freestyle VM cap before and after the public rewrite", () => {
		expect(isWorkspaceAtCapacity("LIMIT_EXCEEDED: limit of 5 VMs")).toBe(true);
		expect(
			isWorkspaceAtCapacity(
				"This Freestyle plan is at its VM limit. Delete an unused agent session or raise the quota before starting another. Pausing a VM does not free a slot.",
			),
		).toBe(true);
		expect(isWorkspaceAtCapacity("Snapshot sh-old not found")).toBe(false);
	});
});
