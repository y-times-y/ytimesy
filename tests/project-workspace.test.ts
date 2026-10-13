import { expect, it } from "vitest";
import {
	blocksDuplicateProvision,
	branchSwitchBlockedReason,
	canStartPrepare,
	needsMachineCreate,
	needsMachineRecover,
	publicFailureMessage,
	redactInfrastructure,
	redactSecrets,
	workspaceEnvironmentIsReady,
	workspacePrepareShowsStatus,
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

it("keeps first-time prepare off the composer until it fails", () => {
	expect(workspacePrepareShowsStatus("queued")).toBe(false);
	expect(workspacePrepareShowsStatus("provisioning")).toBe(false);
	expect(workspacePrepareShowsStatus("cloning")).toBe(false);
	expect(workspacePrepareShowsStatus("installing")).toBe(false);
	expect(workspacePrepareShowsStatus("ready")).toBe(false);
	expect(workspacePrepareShowsStatus(undefined)).toBe(false);
	expect(workspacePrepareShowsStatus("failed")).toBe(true);
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

it("explains the workspace cap without treating pause as a free slot", () => {
	expect(
		publicFailureMessage(
			new Error(
				"This plan has a limit of 5 VMs, and you are at 5. To create another VM, delete existing ones or upgrade your plan.",
			),
		),
	).toMatch(/Pausing does not free a slot/);
	expect(
		publicFailureMessage(
			new Error(
				"This plan has a limit of 5 VMs, and you are at 5. To create another VM, delete existing ones or upgrade your plan.",
			),
		),
	).not.toMatch(/Freestyle|style\.dev|noVNC/i);
});

it("explains a used compute allowance without naming the host", () => {
	expect(
		publicFailureMessage(
			new Error(
				"Cannot start this VM because the allowance for vcpu_time, memory_time has been used. Add a card to unlock the full Free allowance, wait for the allowance to reset, or upgrade to Hobby; then resume the VM manually.",
			),
		),
	).toBe(
		"This workspace plan has used its compute allowance. Wait for the allowance to reset or upgrade the plan, then try again.",
	);
});

it("does not name the workspace host in public errors", () => {
	expect(
		redactInfrastructure(
			"noVNC at https://ytimesy-desk-abc.style.dev/vnc.html on freestyle-vm",
		),
	).not.toMatch(/Freestyle|style\.dev|noVNC|freestyle-vm|vnc\.html/i);
	expect(
		publicFailureMessage(
			new Error(
				"Desktop failed on https://ytimesy-desk-abc.style.dev/vnc.html",
			),
		),
	).not.toMatch(/style\.dev|vnc\.html|noVNC|Freestyle/i);
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
	expect(workspaceEnvironmentIsReady(null)).toBe(false);
	expect(
		workspaceEnvironmentIsReady({
			status: "ready",
			providerRef: null,
			templateSnapshotId: "sh-template",
		}),
	).toBe(true);
});
