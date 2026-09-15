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
	expect(
		publicFailureMessage(
			new Error(
				"fatal: https://x-access-token:ghs_secret@github.com/acme/app.git",
			),
		),
	).toBe("fatal: https://x-access-token:***@github.com/acme/app.git");
	expect(workspaceSlug("abc")).toBe("ytimesy-ws-abc");
});

it("explains the Freestyle VM cap without treating pause as a free slot", () => {
	expect(
		publicFailureMessage(
			new Error(
				"This plan has a limit of 5 VMs, and you are at 5. To create another VM, delete existing ones or upgrade your plan.",
			),
		),
	).toMatch(/Pausing a VM does not free a slot/);
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
	expect(harnessConnectBlockedReason(null, "OpenCode", "connect")).toBe(
		"Prepare a workspace before connecting OpenCode.",
	);
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
