import type { Freestyle, VmData } from "freestyle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	admitVmCreate,
	forgetRecentAdmission,
	recentAdmissionCovers,
} from "./usage-admission";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	release: vi.fn(),
	refund: vi.fn(),
	order: [] as string[],
}));
vi.mock("../database", () => ({
	database: () => ({ connect: async () => mocks, query: mocks.query }),
}));
vi.mock("../infrastructure-usage", () => ({
	reserveInfrastructureUsage: async (input: { amountMicroUsd: number }) =>
		input.amountMicroUsd,
	settleInfrastructureUsage: vi.fn(),
}));
vi.mock("../user-action-rate", () => ({
	consumeUserAction: vi.fn(),
	refundUserAction: mocks.refund,
}));
vi.mock("../product-settings", () => ({
	loadToolsSnapshotSetting: async () => undefined,
}));

beforeEach(() => {
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "true");
	forgetRecentAdmission();
	mocks.order = [];
	mocks.refund.mockReset();
	mocks.query.mockReset().mockImplementation(async (sql: string) => {
		if (sql.includes("insert into infrastructure_vm_lease")) {
			mocks.order.push("lease");
			return { rows: [{ holder: "h" }] };
		}
		if (sql.includes("array_agg(user_id)"))
			return {
				rows: [
					{ owners: ["owner"], retention_phase: null, retention_vm_id: null },
				],
			};
		if (sql.startsWith("insert into infrastructure_vm_admission"))
			return { rows: [{ slug: "copy" }] };
		return { rows: [] };
	});
});
afterEach(() => vi.unstubAllEnvs());

const resources = { cpu: 2, memory: 4096, storage: 16384 };
function provider(source: () => Promise<{ resources: typeof resources }>) {
	return {
		vms: {
			snapshots: {
				get: async () => {
					mocks.order.push("snapshot");
					return { sourceVmId: "vm-template", public: false };
				},
			},
			ref: () => ({ data: source }),
		},
	} as unknown as Freestyle;
}
const running = (cap: number) =>
	({
		id: "vm-new",
		state: "running",
		maxRunTotalSeconds: cap,
		automaticRestart: false,
		totalRunSeconds: 2,
	}) as VmData;

it("reads the snapshot's resources while the VM's lock is taken, and leaves the new copy's first guest operation to its own admission", async () => {
	let cap: number | undefined;
	const vmId = await admitVmCreate(
		provider(async () => ({ resources })),
		"copy",
		"sh-template",
		async (granted) => {
			cap = granted;
			return "vm-new";
		},
	);
	expect(vmId).toBe("vm-new");
	// The provider read was started before the lease insert.
	expect(mocks.order.slice(0, 2)).toEqual(["snapshot", "lease"]);
	expect(cap).toBeGreaterThan(75);
	// A create admission is never reused: the first guest operation runs the
	// full path (its retention touch included).
	expect(recentAdmissionCovers(running(cap as number), 60)).toBe(false);
	expect(mocks.query).toHaveBeenCalledWith(
		"update infrastructure_vm_admission set vm_id=$2 where slug=$1 and vm_id is null",
		["copy", "vm-new"],
	);
});

it("still refuses to spend when the snapshot's source cannot be read", async () => {
	const create = vi.fn();
	await expect(
		admitVmCreate(
			provider(async () => {
				throw new Error("provider unavailable");
			}),
			"copy",
			"sh-template",
			create,
		),
	).rejects.toThrow("provider unavailable");
	expect(create).not.toHaveBeenCalled();
	expect(recentAdmissionCovers(running(300), 60)).toBe(false);
});

it("gives the owner's creation count back when the provider refuses the create, so retries never burn the hourly limit", async () => {
	await expect(
		admitVmCreate(
			provider(async () => ({ resources })),
			"copy",
			"sh-template",
			async () => {
				throw new Error("429 LIMIT_EXCEEDED");
			},
		),
	).rejects.toThrow("LIMIT_EXCEEDED");
	expect(mocks.refund).toHaveBeenCalledWith("owner", "vm-create");
});

it("keeps the count for a machine that was created", async () => {
	await admitVmCreate(
		provider(async () => ({ resources })),
		"copy",
		"sh-template",
		async () => "vm-new",
	);
	expect(mocks.refund).not.toHaveBeenCalled();
});
