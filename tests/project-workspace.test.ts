import { expect, it } from "vitest";
import {
	blocksDuplicateProvision,
	branchSwitchBlockedReason,
	canStartPrepare,
	firstEnvironmentBuildRunning,
	heldSendReleases,
	publicFailureMessage,
	redactInfrastructure,
	redactSecrets,
	sendWaitsForEnvironment,
	sendWaitsForSetup,
	startsSetupBesideTask,
	workspacePrepareShowsStatus,
	workspacePrepareStalled,
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

it("flags a prepare request that stayed queued past the stall timeout", () => {
	const queuedAt = "2026-10-14T12:00:00.000Z";
	const at = (minutes: number) => Date.parse(queuedAt) + minutes * 60_000;
	const queued = { status: "queued" as const, updatedAt: queuedAt };
	expect(workspacePrepareStalled(queued, at(1))).toBe(false);
	expect(workspacePrepareStalled(queued, at(6))).toBe(true);
	expect(
		workspacePrepareStalled({ ...queued, status: "provisioning" }, at(60)),
	).toBe(false);
	expect(workspacePrepareStalled({ ...queued, updatedAt: "" }, at(60))).toBe(
		false,
	);
});

const notReady = [
	"missing",
	"queued",
	"provisioning",
	"cloning",
	"installing",
	"failed",
] as const;
const setupRequest = { environmentSetup: true };

it("holds only the setup request while the environment is not ready, failed included, and releases it only when ready", () => {
	for (const status of notReady)
		expect(sendWaitsForSetup(status, setupRequest), status).toBe(true);
	expect(sendWaitsForSetup("ready", setupRequest)).toBe(false);
	// Still loading: nothing to wait for yet.
	expect(sendWaitsForSetup(undefined, setupRequest)).toBe(false);
	expect(heldSendReleases("ready")).toBe(true);
	for (const status of ["failed", "installing", undefined] as const)
		expect(heldSendReleases(status), String(status)).toBe(false);
});

it("never holds a task for the environment: it starts at once on its own machine", () => {
	for (const status of [...notReady, "ready", undefined] as const)
		expect(sendWaitsForSetup(status, {}), String(status)).toBe(false);
	// A task the tab held while the project had no environment record goes once it has one.
	for (const status of ["queued", "installing", "failed", "ready"] as const)
		expect(heldSendReleases(status, {}), status).toBe(true);
	expect(heldSendReleases(undefined, {})).toBe(false);
});

it("starts the setup beside a person's task during the first build only", () => {
	expect(startsSetupBesideTask({})).toBe(true);
	expect(startsSetupBesideTask(setupRequest)).toBe(false);
	expect(startsSetupBesideTask({ runtimeText: "notice" })).toBe(false);
	expect(startsSetupBesideTask({ approvesPlan: true })).toBe(false);
	expect(startsSetupBesideTask({ continueOn: "c|m" })).toBe(false);
	expect(sendWaitsForEnvironment({ ...setupRequest, runtimeText: "x" })).toBe(
		false,
	);
	for (const status of [
		"queued",
		"provisioning",
		"cloning",
		"installing",
	] as const)
		expect(
			firstEnvironmentBuildRunning({ status, templateSnapshotId: null }),
			status,
		).toBe(true);
	// A rebuild keeps the template; a failed or ready one is not running.
	expect(
		firstEnvironmentBuildRunning({
			status: "installing",
			templateSnapshotId: "sh-1",
		}),
	).toBe(false);
	for (const status of ["failed", "ready"] as const)
		expect(
			firstEnvironmentBuildRunning({ status, templateSnapshotId: null }),
		).toBe(false);
});

it("never shows an empty or serialized-object failure", () => {
	for (const lost of ["{}", "", "  ", "[object Object]", "null"])
		expect(publicFailureMessage(new Error(lost))).toBe(
			"Something went wrong. Retry in a moment.",
		);
	expect(publicFailureMessage(new Response(null, { status: 409 }))).toBe(
		"Something went wrong. Retry in a moment.",
	);
});
