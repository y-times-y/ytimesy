import { expect, it } from "vitest";
import {
	blocksDuplicateProvision,
	branchSwitchBlockedReason,
	canStartPrepare,
	codexConnectBlockedReason,
	harnessConnectBlockedReason,
	needsMachineCreate,
	needsMachineRecover,
	publicFailureMessage,
	redactSecrets,
	workspaceSessionMachineRef,
	workspaceSlug,
} from "../src/domain/project-workspace";

it("allows branch switch once prepare is idle or failed", () => {
	expect(branchSwitchBlockedReason("provisioning")).toMatch(/finish/);
	expect(branchSwitchBlockedReason("cloning")).toMatch(/finish/);
	expect(branchSwitchBlockedReason("installing")).toMatch(/finish/);
	expect(branchSwitchBlockedReason("ready")).toBeNull();
	expect(branchSwitchBlockedReason("failed")).toBeNull();
	expect(branchSwitchBlockedReason(undefined)).toBeNull();
});

it("starts prepare only from absent, queued, or failed workspaces", () => {
	expect(canStartPrepare(undefined)).toBe(true);
	expect(canStartPrepare("queued")).toBe(true);
	expect(canStartPrepare("failed")).toBe(true);
	expect(canStartPrepare("ready")).toBe(false);
	expect(canStartPrepare("provisioning")).toBe(false);
});

it("blocks a second machine while work is in flight or ready", () => {
	expect(blocksDuplicateProvision("ready")).toBe(true);
	expect(blocksDuplicateProvision("provisioning")).toBe(true);
	expect(blocksDuplicateProvision("queued")).toBe(false);
	expect(blocksDuplicateProvision("failed")).toBe(false);
});

it("creates a machine only when provisioning has no provider ref", () => {
	expect(needsMachineCreate("provisioning", null)).toBe(true);
	expect(needsMachineCreate("provisioning", "vm-1")).toBe(false);
	expect(needsMachineRecover("provisioning", "vm-1")).toBe(true);
	expect(needsMachineRecover("queued", null)).toBe(false);
});

it("redacts tokens from failure messages and logs", () => {
	expect(redactSecrets("Bearer ghp_secretvalue123")).toBe("Bearer [redacted]");
	expect(publicFailureMessage(new Error("AUTHORIZATION: bearer ghp_abc"))).toBe(
		"AUTHORIZATION: bearer [redacted]",
	);
	expect(workspaceSlug("abc")).toBe("ytimesy-ws-abc");
});

it("only exposes a Codex session machine after the workspace is ready", () => {
	expect(workspaceSessionMachineRef(null)).toBeNull();
	expect(
		workspaceSessionMachineRef({
			status: "installing",
			providerRef: "vm-1",
		}),
	).toBeNull();
	expect(
		workspaceSessionMachineRef({
			status: "ready",
			providerRef: "vm-1",
		}),
	).toBe("vm-1");
	expect(codexConnectBlockedReason(null)).toMatch(/Prepare a workspace/);
	expect(harnessConnectBlockedReason(null, "Claude Code")).toBe(
		"Prepare a workspace before signing in to Claude Code.",
	);
	expect(harnessConnectBlockedReason(null, "OpenCode")).toMatch(/OpenCode/);
	expect(
		codexConnectBlockedReason({
			status: "cloning",
			providerRef: "vm-1",
			errorMessage: null,
		}),
	).toMatch(/Wait for workspace preparation/);
	expect(
		codexConnectBlockedReason({
			status: "failed",
			providerRef: null,
			errorMessage: "GitHub access expired or was denied. Reconnect GitHub.",
		}),
	).toBe("GitHub access expired or was denied. Reconnect GitHub.");
});
