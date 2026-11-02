import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	taken: new Set<string>(),
	inFlight: false,
}));
vi.mock("../adapters/database", () => ({
	database: () => ({
		query: async (sql: string, values: unknown[]) => {
			if (sql.includes("as taken"))
				return { rows: [{ taken: state.taken.has(String(values[0])) }] };
			if (sql.includes("as pending"))
				return { rows: [{ pending: state.inFlight }] };
			throw new Error(`unexpected query: ${sql}`);
		},
	}),
}));
vi.mock("../records/tools-snapshot-store", () => ({
	readToolsSnapshotId: async () => null,
}));

const {
	earlyMachineSlug,
	releaseUntakenEnvironmentMachine,
	startEnvironmentMachineEarly,
	takeEarlyEnvironmentMachine,
} = await import("./environment-prestart");

const workspaceId = "00000000-0000-4000-8000-0000000000aa";
const slug = earlyMachineSlug(workspaceId);

function fakeRuntime(machines: Map<string, string> = new Map()) {
	return {
		machines,
		provision: vi.fn(
			async (name: string, options?: { snapshotId?: string }) => {
				const existing = machines.get(name);
				if (existing) return existing;
				const vm = `vm-${machines.size + 1}-${options?.snapshotId ?? "base"}`;
				machines.set(name, vm);
				return vm;
			},
		),
		findBySlug: vi.fn(async (name: string) => machines.get(name) ?? null),
		delete: vi.fn(async (vm: string) => {
			for (const [name, id] of machines) if (id === vm) machines.delete(name);
		}),
	};
}
type Runtime = Parameters<typeof takeEarlyEnvironmentMachine>[2];

beforeEach(() => {
	vi.stubEnv("YTIMESY_TOOLS_SNAPSHOT_ID", "tools-snap");
	state.taken.clear();
	state.inFlight = false;
});
afterEach(() => vi.unstubAllEnvs());

const first = { workspaceId, baseSnapshotId: "tools-snap", incremental: null };

it("starts the first build's machine from the tools image, under the workspace's name", async () => {
	const runtime = fakeRuntime();
	const vm = await startEnvironmentMachineEarly(
		workspaceId,
		runtime as unknown as Runtime,
	);
	expect(vm).toBe("vm-1-tools-snap");
	expect(runtime.provision).toHaveBeenCalledWith(slug, {
		snapshotId: "tools-snap",
		maxRunSeconds: expect.any(Number),
	});
	vi.stubEnv("YTIMESY_ENVIRONMENT_EARLY_MACHINE", "false");
	expect(
		await startEnvironmentMachineEarly(
			workspaceId,
			runtime as unknown as Runtime,
		),
	).toBeNull();
});

it("a first build takes the machine started early", async () => {
	const runtime = fakeRuntime(new Map([[slug, "early-vm"]]));
	expect(
		await takeEarlyEnvironmentMachine(
			first,
			false,
			runtime as unknown as Runtime,
		),
	).toBe("early-vm");
});

it("waits for an early machine still being created, then takes it", async () => {
	const runtime = fakeRuntime();
	state.inFlight = true;
	let waits = 0;
	const vm = await takeEarlyEnvironmentMachine(
		first,
		false,
		runtime as unknown as Runtime,
		async () => {
			waits += 1;
			if (waits === 2) runtime.machines.set(slug, "booted-meanwhile");
		},
	);
	expect(vm).toBe("booted-meanwhile");
	expect(runtime.provision).toHaveBeenCalledOnce();
	expect(runtime.machines.size).toBe(1);
});

it("never runs a second build on a machine an earlier build used, nor takes one for other builds", async () => {
	const used = fakeRuntime(new Map([[slug, "failed-build-vm"]]));
	state.taken.add("failed-build-vm");
	expect(
		await takeEarlyEnvironmentMachine(first, false, used as unknown as Runtime),
	).toBeNull();
	expect(used.provision).not.toHaveBeenCalled();
	const runtime = fakeRuntime(new Map([[slug, "early-vm"]]));
	// An environment exists already; an incremental build; another image.
	expect(
		await takeEarlyEnvironmentMachine(
			first,
			true,
			runtime as unknown as Runtime,
		),
	).toBeNull();
	expect(
		await takeEarlyEnvironmentMachine(
			{ ...first, incremental: { snapshotId: "t" } },
			false,
			runtime as unknown as Runtime,
		),
	).toBeNull();
	expect(
		await takeEarlyEnvironmentMachine(
			{ ...first, baseSnapshotId: "other" },
			false,
			runtime as unknown as Runtime,
		),
	).toBeNull();
	expect(runtime.provision).not.toHaveBeenCalled();
});

it("removes an early machine nobody took when setup cannot start, never a taken one", async () => {
	const runtime = fakeRuntime(new Map([[slug, "early-vm"]]));
	state.taken.add("early-vm");
	expect(
		await releaseUntakenEnvironmentMachine(
			workspaceId,
			runtime as unknown as Runtime,
		),
	).toBe(false);
	state.taken.clear();
	expect(
		await releaseUntakenEnvironmentMachine(
			workspaceId,
			runtime as unknown as Runtime,
		),
	).toBe(true);
	expect(runtime.delete).toHaveBeenCalledWith("early-vm");
});
