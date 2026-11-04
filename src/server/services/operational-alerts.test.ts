import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MaintenanceStepsFailed } from "./maintenance-steps";
import { alertCronFailure } from "./operational-alerts";

const sent = vi.hoisted(() => ({ alerts: [] as { subject: string }[] }));
vi.mock("../adapters/owner-alerts", () => ({
	alertOwner: async (alert: { subject: string }) => {
		sent.alerts.push(alert);
		return "sent";
	},
	recordCronBlip: async () => {
		throw new Error("tests pass recordBlip");
	},
}));
vi.mock("../adapters/analytics", () => ({
	captureServerException: async () => undefined,
	redactErrorText: (text: string) => text,
}));

beforeEach(() => {
	sent.alerts = [];
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const now = new Date("2026-11-03T18:00:00Z");
const minutesAgo = (minutes: number) =>
	new Date(now.getTime() - minutes * 60_000);
const job = { kind: "maintenance", action: "memory-dreams", everyMinutes: 5 };
// The Workers runtime's answer while a deploy swaps versions.
const blip = new Error("internal error; reference = 9a1fq3l2k0mrp8s4bd7c");

it("only logs a scheduled job's first runtime blip", async () => {
	const recordBlip = vi.fn(async () => null);
	await alertCronFailure(job, blip, now, { recordBlip });
	expect(recordBlip).toHaveBeenCalledWith("maintenance:memory-dreams", 11);
	expect(sent.alerts).toEqual([]);
	expect(console.warn).toHaveBeenCalledWith(
		"Scheduled job hit a runtime blip; the next tick retries it.",
		expect.objectContaining({ job: "maintenance:memory-dreams" }),
	);
});

it("treats blips within the deploy's grace as the same blip", async () => {
	await alertCronFailure(
		{ kind: "model-admission" },
		new Error("Network connection lost."),
		now,
		{ recordBlip: async () => minutesAgo(1) },
	);
	expect(sent.alerts).toEqual([]);
});

it("emails when the job's next run blips again", async () => {
	await alertCronFailure(job, blip, now, {
		recordBlip: async () => minutesAgo(5),
	});
	expect(sent.alerts).toEqual([
		expect.objectContaining({
			subject: "ytimesy: scheduled job maintenance:memory-dreams failed",
		}),
	]);
});

it("emails any other failure at once without recording a blip", async () => {
	const recordBlip = vi.fn(async () => null);
	await alertCronFailure(job, new Error("relation does not exist"), now, {
		recordBlip,
	});
	expect(recordBlip).not.toHaveBeenCalled();
	expect(sent.alerts).toHaveLength(1);
});

it("emails a blip it could not record", async () => {
	await alertCronFailure(job, blip, now, {
		recordBlip: async () => {
			throw new Error("connect ETIMEDOUT");
		},
	});
	expect(sent.alerts).toHaveLength(1);
});

it("counts a maintenance job as a blip only when every failed step blipped", async () => {
	const restarted = new Error(
		"The Durable Object's code has been updated, this version can no longer access storage.",
	);
	await alertCronFailure(
		job,
		new MaintenanceStepsFailed(
			"maintenance:memory-dreams",
			["dream", "index"],
			[blip, restarted],
		),
		now,
		{ recordBlip: async () => null },
	);
	expect(sent.alerts).toEqual([]);
	await alertCronFailure(
		job,
		new MaintenanceStepsFailed(
			"maintenance:memory-dreams",
			["dream", "index"],
			[blip, new Error("syntax error at or near")],
		),
		now,
		{ recordBlip: async () => null },
	);
	expect(sent.alerts).toHaveLength(1);
});
