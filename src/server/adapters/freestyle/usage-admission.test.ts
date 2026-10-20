import type { VmData } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import {
	admitVmResume,
	infrastructureAdmissionEnabled,
	resumeCapDecision,
} from "./usage-admission";

afterEach(() => vi.unstubAllEnvs());

it("extends a spent cap before a metered start instead of starting into a 409", () => {
	// vm-b216…: 903s used of a 900s cap, paused by the provider.
	expect(
		resumeCapDecision({
			metered: true,
			settled: true,
			totalRunSeconds: 903,
			capSeconds: 900,
			requiredSeconds: 60,
		}),
	).toBe("extend");
});

it("extends a settled VM whose cap cannot cover the operation, not only a spent one", () => {
	const input = {
		metered: true,
		settled: true,
		totalRunSeconds: 880,
		capSeconds: 900,
		requiredSeconds: 60,
	};
	expect(resumeCapDecision(input)).toBe("extend");
	expect(resumeCapDecision({ ...input, capSeconds: 1000 })).toBe("keep");
});

it("leaves a running VM's cap to its own top-up while it has runtime left", () => {
	expect(
		resumeCapDecision({
			metered: true,
			settled: false,
			totalRunSeconds: 880,
			capSeconds: 900,
			requiredSeconds: 60,
		}),
	).toBe("keep");
});

it("refuses, without raising, a spent cap where usage is not metered", () => {
	const input = {
		metered: false,
		settled: true,
		totalRunSeconds: 308,
		capSeconds: 300,
		requiredSeconds: 60,
	};
	expect(resumeCapDecision(input)).toBe("spent");
	expect(resumeCapDecision({ ...input, totalRunSeconds: 250 })).toBe("keep");
	expect(resumeCapDecision({ ...input, capSeconds: null })).toBe("keep");
	expect(resumeCapDecision({ ...input, capSeconds: -1 })).toBe("keep");
});

it("fails an unmetered resume of a spent VM with a machine reason before calling start", async () => {
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	const vm = { start: vi.fn(), update: vi.fn() };
	const data = {
		id: "vm-6c6e",
		state: "paused",
		totalRunSeconds: 308,
		maxRunTotalSeconds: 300,
	} as unknown as VmData;
	await expect(admitVmResume(vm as never, data, 60)).rejects.toThrow(
		/runtime budget is used up/,
	);
	expect(vm.update).not.toHaveBeenCalled();
	await expect(
		admitVmResume(vm as never, { ...data, totalRunSeconds: 100 }, 60),
	).resolves.toBeUndefined();
});

const caps = {
	YTIMESY_USER_5H_MICRO_USD: "5000000",
	YTIMESY_USER_WEEKLY_MICRO_USD: "5000000",
	YTIMESY_FLEET_MONTHLY_MICRO_USD: "100000000",
	YTIMESY_FLEET_LIFETIME_MICRO_USD: "500000000",
};

it("always meters production, even when the opt-in flag is off or unset", () => {
	for (const flag of [undefined, "false", ""])
		expect(
			infrastructureAdmissionEnabled({
				YTIMESY_ENVIRONMENT: "production",
				YTIMESY_INFRASTRUCTURE_ADMISSION: flag,
				...caps,
			}),
		).toBe(true);
});

it("refuses production VM work when any usage cap is unset", () => {
	for (const name of Object.keys(caps))
		expect(() =>
			infrastructureAdmissionEnabled({
				YTIMESY_ENVIRONMENT: "production",
				...caps,
				[name]: " ",
			}),
		).toThrow(new RegExp(`without usage caps: set ${name}`));
});

it("keeps admission opt-in outside production", () => {
	expect(infrastructureAdmissionEnabled({})).toBe(false);
	expect(
		infrastructureAdmissionEnabled({
			YTIMESY_ENVIRONMENT: "development",
			YTIMESY_INFRASTRUCTURE_ADMISSION: "true",
		}),
	).toBe(true);
});

it("meters a production resume even though the opt-in flag says false", async () => {
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	for (const [name, value] of Object.entries(caps)) vi.stubEnv(name, value);
	const vm = { start: vi.fn(), update: vi.fn() };
	// Metered admission needs the VM's usage identity; unmetered would return.
	await expect(
		admitVmResume(vm as never, { id: "vm-1", state: "paused" } as VmData, 60),
	).rejects.toThrow(/usage identity is missing/);
});
