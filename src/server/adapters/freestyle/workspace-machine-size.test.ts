import { FreestyleApiError } from "freestyle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFreestyleWorkspaceMachines } from "./workspace-machines";

const provider = vi.hoisted(() => ({
	resources: { cpu: 2, memory: 4096, storage: 16384 },
	existing: false,
	metadata: {} as Record<string, string>,
	resize: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	create: vi.fn(),
	exec: vi.fn(),
}));
vi.mock("freestyle", async (importOriginal) => {
	const actual = await importOriginal<typeof import("freestyle")>();
	const vm = {
		id: "vm-copy",
		data: async () => ({
			state: "running",
			resources: provider.resources,
			metadata: provider.metadata,
			idleTimeoutSeconds: 60,
			autoDeleteSeconds: 7_776_000,
		}),
		resize: provider.resize,
		update: provider.update,
		delete: provider.remove,
		exec: provider.exec,
	};
	return {
		...actual,
		Freestyle: class {
			vms = {
				list: async () => ({
					vms: provider.existing ? [{ id: "vm-copy" }] : [],
				}),
				ref: () => vm,
				create: async (fields: unknown) => {
					provider.create(fields);
					return { vm, vmId: "vm-copy" };
				},
			};
		},
	};
});
beforeEach(() => {
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	provider.resources = { cpu: 2, memory: 4096, storage: 16384 };
	provider.existing = false;
	provider.metadata = {};
	vi.clearAllMocks();
	provider.resize.mockResolvedValue(undefined);
	provider.update.mockResolvedValue(undefined);
	provider.remove.mockResolvedValue(undefined);
	provider.exec.mockResolvedValue({ statusCode: 0 });
});
afterEach(() => vi.unstubAllEnvs());
it("grows a prepared new copy to Large by default", async () => {
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
	);
	expect(provider.resize).toHaveBeenCalledWith({
		cpu: 4,
		memory: 16384,
		storage: 32768,
	});
	expect(provider.create).toHaveBeenCalledWith(
		expect.objectContaining({
			snapshotId: "sh-template",
			idleTimeoutSeconds: 60,
		}),
	);
});
it("provisions the saved extra-large preference as Ultra", async () => {
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
		"extra-large",
	);
	expect(provider.resize).toHaveBeenCalledWith({
		cpu: 8,
		memory: 16384,
		storage: 65536,
	});
});
it("preserves legacy Extra Large machines when reconnecting", async () => {
	provider.existing = true;
	provider.metadata = { machine_size: "extra-large" };
	provider.resources = { cpu: 8, memory: 32768, storage: 131072 };
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
		"extra-large",
	);
	expect(provider.resize).not.toHaveBeenCalled();
	expect(provider.create).not.toHaveBeenCalled();
	expect(provider.update).toHaveBeenCalledWith({
		autoDeleteSeconds: 2_592_000,
	});
});
it("honors Small and keeps larger snapshot resources", async () => {
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
		"small",
	);
	expect(provider.resize).not.toHaveBeenCalled();
	provider.resources = { cpu: 8, memory: 32768, storage: 131072 };
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
		"large",
	);
	expect(provider.resize).not.toHaveBeenCalled();
});
it("keeps a 64 GiB template disk when the default requests 32 GiB", async () => {
	provider.resources = { cpu: 2, memory: 4096, storage: 65536 };
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
	);
	expect(provider.resize).toHaveBeenCalledWith({
		cpu: 4,
		memory: 16384,
		storage: 65536,
	});
});
it("reconnects an existing Large 64 GiB machine without shrinking it", async () => {
	provider.existing = true;
	provider.metadata = { machine_size: "large" };
	provider.resources = { cpu: 4, memory: 16384, storage: 65536 };
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
	);
	expect(provider.create).not.toHaveBeenCalled();
	expect(provider.resize).not.toHaveBeenCalled();
});
it("does not resize existing work when the project preference changes", async () => {
	provider.existing = true;
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
		"extra-large",
	);
	expect(provider.create).not.toHaveBeenCalled();
	expect(provider.resize).not.toHaveBeenCalled();
});
it("removes only the unbound new copy if resizing fails", async () => {
	provider.resize.mockRejectedValueOnce(new Error("capacity exceeded"));
	await expect(
		createFreestyleWorkspaceMachines("test").provisionSession(
			"test-copy",
			"sh-template",
		),
	).rejects.toThrow();
	expect(provider.remove).toHaveBeenCalledOnce();
});

it("never uses a leftover undersized copy: it grows it to its tagged size first", async () => {
	provider.existing = true;
	provider.metadata = { machine_size: "large" };
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
		"small",
	);
	expect(provider.resize).toHaveBeenCalledWith({
		cpu: 4,
		memory: 16384,
		storage: 32768,
	});
	expect(provider.create).not.toHaveBeenCalled();
	expect(provider.remove).not.toHaveBeenCalled();
});

it("does not accept a leftover undersized copy whose resize is refused", async () => {
	provider.existing = true;
	provider.metadata = { machine_size: "large" };
	provider.resize.mockRejectedValueOnce(
		new FreestyleApiError(400, {
			code: "LIMIT_EXCEEDED",
			message: "memory limit exceeded",
		} as never),
	);
	await expect(
		createFreestyleWorkspaceMachines("test").provisionSession(
			"test-copy",
			"sh-template",
			"small",
		),
	).rejects.toThrow();
	expect(provider.remove).not.toHaveBeenCalled();
});

it("says the provider rejected the size instead of reporting a full plan", async () => {
	provider.remove.mockResolvedValue(undefined);
	provider.resize.mockRejectedValueOnce(
		new FreestyleApiError(400, {
			code: "LIMIT_EXCEEDED",
			message: "vCPU limit exceeded",
		} as never),
	);
	const failure = createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
		"extra-large",
	);
	await expect(failure).rejects.toThrow(
		"The provider rejected the Ultra machine size (8 vCPU, 16 GiB). Choose a smaller machine size in project settings.",
	);
	await expect(failure).rejects.not.toThrow(/LIMIT_EXCEEDED|at its limit/);
	expect(provider.remove).toHaveBeenCalledOnce();
	expect(provider.create).toHaveBeenCalledOnce();
});

it("polls a resize the provider reported as failed soon at first, then every 2 s, for a minute", async () => {
	const { resizeLands } = await import("./workspace-machines");
	let clock = 0;
	const pauses: number[] = [];
	const wait = async (ms: number) => {
		pauses.push(ms);
		clock += ms;
	};
	const target = { cpu: 4, memory: 16384, storage: 32768 };
	let reads = 0;
	const growing = {
		data: async () => {
			reads++;
			return {
				resources:
					reads >= 3 ? target : { cpu: 2, memory: 4096, storage: 16384 },
			};
		},
	};
	expect(await resizeLands(growing as never, target, wait, () => clock)).toBe(
		true,
	);
	expect(pauses).toEqual([200, 300]);
	pauses.length = 0;
	clock = 0;
	const stuck = {
		data: async () => ({ resources: { cpu: 2, memory: 4096, storage: 16384 } }),
	};
	expect(await resizeLands(stuck as never, target, wait, () => clock)).toBe(
		false,
	);
	expect(pauses.slice(0, 6)).toEqual([200, 300, 450, 675, 1013, 1520]);
	expect(Math.max(...pauses)).toBe(2_000);
	expect(clock).toBeLessThanOrEqual(60_000);
	expect(clock).toBeGreaterThan(57_000);
});
