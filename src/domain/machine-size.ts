import { z } from "zod";

export const machineSizeId = z.enum([
	"small",
	"medium",
	"large",
	"extra-large",
]);
export type MachineSizeId = z.infer<typeof machineSizeId>;
export const DEFAULT_MACHINE_SIZE: MachineSizeId = "large";

export const MACHINE_SIZES = [
	{
		id: "small",
		name: "Small",
		cpu: 2,
		memory: 4096,
		storage: 16384,
		description: "Lightweight projects and focused edits",
	},
	{
		id: "medium",
		name: "Medium",
		cpu: 4,
		memory: 8192,
		storage: 32768,
		description: "Everyday development and testing",
	},
	{
		id: "large",
		name: "Large",
		cpu: 4,
		memory: 16384,
		storage: 32768,
		description: "Apps, browsers and parallel tests",
	},
	{
		id: "extra-large",
		name: "Ultra",
		cpu: 8,
		memory: 16384,
		storage: 65536,
		description: "Large builds and demanding toolchains",
	},
] as const;

export function machineSize(id: MachineSizeId = DEFAULT_MACHINE_SIZE) {
	const size = MACHINE_SIZES.find((size) => size.id === id);
	if (!size) throw new Error("Machine size is not available.");
	return size;
}

/** Snapshot copies cannot shrink; charge and provision the effective shape, not the label. */
export function effectiveMachineResources(
	current: { cpu: number; memory: number; storage: number },
	requested: { cpu: number; memory: number; storage: number },
) {
	return {
		cpu: Math.max(current.cpu, requested.cpu),
		memory: Math.max(current.memory, requested.memory),
		storage: Math.max(current.storage, requested.storage),
	};
}
