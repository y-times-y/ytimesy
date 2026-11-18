import { describe, expect, it } from "vitest";
import {
	DEFAULT_MACHINE_SIZE,
	effectiveMachineResources,
	MACHINE_SIZES,
	machineSize,
	machineSizeId,
	machineSpecText,
} from "./machine-size";

describe("machine sizes", () => {
	it("defaults task machines to 4 vCPU, 16 GiB RAM and 32 GiB disk", () => {
		expect(DEFAULT_MACHINE_SIZE).toBe("large");
		expect(machineSize()).toMatchObject({
			cpu: 4,
			memory: 16384,
			storage: 32768,
		});
	});
	it("has unique, ordered presets and rejects arbitrary resources", () => {
		expect(MACHINE_SIZES.map((size) => size.id)).toEqual([
			"small",
			"medium",
			"large",
			"extra-large",
		]);
		expect(machineSizeId.safeParse("huge").success).toBe(false);
	});
	it("offers Ultra through the existing saved preference with bounded resources", () => {
		expect(machineSize("extra-large")).toMatchObject({
			name: "Ultra",
			cpu: 8,
			memory: 16384,
			storage: 65536,
		});
		for (const size of MACHINE_SIZES) {
			expect(size.cpu).toBeLessThanOrEqual(8);
			expect(size.memory).toBeLessThanOrEqual(16384);
			expect(size.storage).toBeLessThanOrEqual(65536);
		}
	});
	it("grows prepared copies without shrinking inherited resources", () => {
		expect(
			effectiveMachineResources(machineSize("small"), machineSize("large")),
		).toEqual({ cpu: 4, memory: 16384, storage: 32768 });
		expect(
			effectiveMachineResources(
				{ cpu: 4, memory: 16384, storage: 65536 },
				machineSize(),
			),
		).toEqual({ cpu: 4, memory: 16384, storage: 65536 });
		expect(
			effectiveMachineResources(
				machineSize("extra-large"),
				machineSize("small"),
			),
		).toEqual({ cpu: 8, memory: 16384, storage: 65536 });
	});
});

it("says a machine size in words, the default when none is set", () => {
	expect(machineSpecText("small")).toBe(
		"Small · 2 vCPU · 4 GiB RAM · 16 GiB disk",
	);
	expect(machineSpecText("extra-large")).toBe(
		"Ultra · 8 vCPU · 16 GiB RAM · 64 GiB disk",
	);
	expect(machineSpecText()).toBe("Large · 4 vCPU · 16 GiB RAM · 32 GiB disk");
	expect(machineSpecText(null)).toBe(machineSpecText("large"));
});
