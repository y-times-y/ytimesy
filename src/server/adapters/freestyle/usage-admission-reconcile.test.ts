import type { VmData } from "freestyle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	reconcilePausedVm,
	START_GRACE_SECONDS,
	startAdmittedVm,
} from "./usage-admission";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	release: vi.fn(),
	settle: vi.fn(),
}));
vi.mock("../database", () => ({
	database: () => ({ connect: async () => mocks }),
}));
vi.mock("../infrastructure-usage", () => ({
	reserveInfrastructureUsage: vi.fn(),
	settleInfrastructureUsage: mocks.settle,
}));

const now = Date.parse("2026-11-19T20:05:43Z");
// vm-8689…: admitted at 20:04:37 for a start the provider answered 93 s later.
const admission = (updatedAt: Date) => ({
	slug: "ytimesy-ag-d41986e34c6445b2",
	vm_id: "vm-8689",
	user_id: "user-1",
	reservation_id: "hold-1",
	max_run_total_seconds: "488",
	baseline_seconds: "188",
	hourly_micro_usd: "367680",
	updated_at: updatedAt,
});
const paused = {
	id: "vm-8689",
	slug: "ytimesy-ag-d41986e34c6445b2",
	state: "paused",
	totalRunSeconds: 188,
	maxRunTotalSeconds: 488,
} as unknown as VmData;

function pausedVm() {
	return {
		id: "vm-8689",
		data: vi.fn(async () => paused),
		update: vi.fn(async () => undefined),
		start: vi.fn(),
	};
}

function answerQueries(row: ReturnType<typeof admission>) {
	mocks.query.mockImplementation(async (sql: string) => {
		if (sql.includes("infrastructure_vm_lease") && sql.startsWith("insert"))
			return { rows: [{ holder: "h" }] };
		if (sql.startsWith("select * from infrastructure_vm_admission"))
			return { rows: [row] };
		return { rows: [] };
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "true");
});
afterEach(() => vi.unstubAllEnvs());

it("leaves a paused VM's fresh admission alone: its start may still be in flight", async () => {
	answerQueries(admission(new Date(now - 66_000)));
	const vm = pausedVm();
	await reconcilePausedVm(vm as never, now);
	expect(vm.update).not.toHaveBeenCalled();
	expect(mocks.settle).not.toHaveBeenCalled();
});

it("still revokes and settles a paused VM's admission once the grace has passed", async () => {
	answerQueries(admission(new Date(now - (START_GRACE_SECONDS + 1) * 1000)));
	const vm = pausedVm();
	vm.data.mockResolvedValue({ ...paused, maxRunTotalSeconds: 188 });
	await reconcilePausedVm(vm as never, now);
	expect(vm.update).toHaveBeenCalledWith({
		maxRunTotalSeconds: 188,
		automaticRestart: false,
	});
	expect(mocks.settle).toHaveBeenCalledWith(
		{ id: "hold-1", userId: "user-1", consumedMicroUsd: 0 },
		mocks,
	);
});

const spent = new Error(
	"FreestyleApiError 409 CONFLICT /v5/vms/vm-8689/start: conflict: vm vm-8689 has used its total runtime budget of 188s (188s used); raise maxRunTotalSeconds to start it again",
);

it("admits again and retries a start the provider refused for a spent budget", async () => {
	const vm = pausedVm();
	vm.start.mockRejectedValueOnce(spent).mockResolvedValueOnce(undefined);
	const admit = vi.fn(async () => undefined);
	await startAdmittedVm(vm as never, 60, admit);
	expect(admit).toHaveBeenCalledWith(vm, paused, 60);
	expect(vm.start).toHaveBeenCalledTimes(2);
});

it("passes any other start failure through without admitting again", async () => {
	const vm = pausedVm();
	vm.start.mockRejectedValueOnce(new Error("upstream 502"));
	const admit = vi.fn();
	await expect(startAdmittedVm(vm as never, 60, admit)).rejects.toThrow(
		"upstream 502",
	);
	expect(admit).not.toHaveBeenCalled();
});
