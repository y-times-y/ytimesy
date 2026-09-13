import { expect, it } from "vitest";
import {
	blocksDuplicateProvision,
	canStartPrepare,
	needsMachineCreate,
	needsMachineRecover,
	publicFailureMessage,
	redactSecrets,
	workspaceSlug,
} from "../src/domain/project-workspace";

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
