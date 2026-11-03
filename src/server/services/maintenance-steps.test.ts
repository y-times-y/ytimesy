import { FreestyleApiError } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import { RecycleDeferred } from "../adapters/freestyle/workspace-retention";
import {
	MaintenanceStepsFailed,
	maintenanceFailureNeedsHuman,
	runMaintenanceSteps,
} from "./maintenance-steps";

afterEach(() => vi.restoreAllMocks());

const gone = new FreestyleApiError(
	404,
	{
		code: "NOT_FOUND",
		message: "not found: vm vm-3e3763fee7444365a269c1e3f6eb6f08",
	},
	"/v5/vms/vm-3e37",
);

it("runs every step after one fails and logs each failure by step name", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const ran: string[] = [];
	const step = (name: string, failure?: unknown) => ({
		name,
		run: async () => {
			ran.push(name);
			if (failure) throw failure;
		},
	});
	const failed = runMaintenanceSteps("maintenance:infrastructure", [
		step("reconcile-vms", gone),
		step("fleet-costs"),
		step(
			"recycle-workspaces",
			new Error("connect failed postgres://user:hunter2@db.example/x"),
		),
		step("fleet-budget"),
	]);
	await expect(failed).rejects.toBeInstanceOf(MaintenanceStepsFailed);
	await expect(failed).rejects.toMatchObject({
		steps: ["recycle-workspaces"],
	});
	expect(ran).toEqual([
		"reconcile-vms",
		"fleet-costs",
		"recycle-workspaces",
		"fleet-budget",
	]);
	expect(warn.mock.calls[0][1]).toMatchObject({
		step: "reconcile-vms",
		needsHuman: false,
	});
	expect(error.mock.calls[0][1]).toMatchObject({
		step: "recycle-workspaces",
		needsHuman: true,
	});
	expect(JSON.stringify(error.mock.calls)).not.toContain("hunter2");
});

it("does not fail the job for deferrals, gone VMs or transient provider answers", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	await expect(
		runMaintenanceSteps("maintenance:infrastructure", [
			{
				name: "recycle-workspaces",
				run: async () => {
					throw new RecycleDeferred(
						"Recovery verification exceeded its time budget; preserve the source VM.",
					);
				},
			},
			{
				name: "fleet-costs",
				run: async () => {
					throw new FreestyleApiError(
						503,
						{ code: "UNAVAILABLE", message: "busy" },
						"/v5/vms",
					);
				},
			},
			{
				name: "reconcile-vms",
				run: async () => {
					throw gone;
				},
			},
		]),
	).resolves.toBeUndefined();
	expect(
		maintenanceFailureNeedsHuman(
			new FreestyleApiError(429, { code: "X", message: "x" }, "/"),
		),
	).toBe(false);
	expect(
		maintenanceFailureNeedsHuman(
			new FreestyleApiError(403, { code: "X", message: "x" }, "/"),
		),
	).toBe(true);
	expect(maintenanceFailureNeedsHuman(new Error("boom"))).toBe(true);
});
