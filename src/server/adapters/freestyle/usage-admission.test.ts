import type { VmData } from "freestyle";
import { afterEach, expect, it, vi } from "vitest";
import { admitVmResume, resumeCapDecision } from "./usage-admission";

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
