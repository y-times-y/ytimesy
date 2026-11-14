import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { forgetRunningGuest } from "./recent-guest-state";
import { createFreestyleWorkspaceMachines } from "./workspace-machines";

/** Provider round trips a turn's machine preparation makes, counted. */
const provider = vi.hoisted(() => ({
	state: "paused",
	data: vi.fn(),
	start: vi.fn(),
	exec: vi.fn(),
	admission: false,
	admit: vi.fn(),
	clearWake: vi.fn(),
}));
vi.mock("freestyle", async (importOriginal) => {
	const actual = await importOriginal<typeof import("freestyle")>();
	const record = () => ({
		id: "vm-chat",
		slug: "ytimesy-ag-chat",
		state: provider.state,
		idleTimeoutSeconds: 180,
		autoDeleteSeconds: 30 * 24 * 60 * 60,
		maxRunTotalSeconds: 3_600,
		automaticRestart: false,
		totalRunSeconds: 10,
	});
	const vm = {
		id: "vm-chat",
		data: async () => {
			provider.data();
			return record();
		},
		start: async () => {
			provider.start();
			provider.state = "running";
		},
		update: async () => record(),
		exec: async (input: unknown) => {
			provider.exec(input);
			return { statusCode: 0, stdout: "", stderr: "" };
		},
	};
	return {
		...actual,
		Freestyle: class {
			vms = { ref: () => vm };
		},
	};
});
vi.mock("./usage-admission", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./usage-admission")>();
	return {
		...actual,
		infrastructureAdmissionEnabled: () => provider.admission,
		recentAdmissionCovers: () => false,
		// With admission on, the admission answers with the record it read under its lease.
		admitVmResume: async (_vm: unknown, data: { state: string }) => {
			provider.admit();
			return provider.admission
				? { ...data, state: provider.state }
				: undefined;
		},
	};
});
vi.mock("#/server/adapters/machine-wake-failures", () => ({
	clearWakeFailures: async () => provider.clearWake(),
	recordWakeFailure: async () => {},
}));

const vmId = WorkspaceId("vm-chat");

beforeEach(() => {
	provider.state = "paused";
	provider.admission = false;
	vi.clearAllMocks();
	forgetRunningGuest(vmId);
});
afterEach(() => forgetRunningGuest(vmId));

it("after resuming a machine whose guest answered, the next ensure and command skip the provider read", async () => {
	const machines = createFreestyleWorkspaceMachines("test");
	await machines.ensureRunning(vmId);
	expect(provider.start).toHaveBeenCalledTimes(1);
	// The probe proved the guest answers.
	expect(provider.exec).toHaveBeenCalledWith(
		expect.objectContaining({ command: "true" }),
	);
	const readsAfterResume = provider.data.mock.calls.length;
	// The turn ensures its machine again before its checkout, then runs commands.
	await machines.ensureRunning(vmId);
	await machines.exec(vmId, "git status", 15_000);
	expect(provider.data).toHaveBeenCalledTimes(readsAfterResume);
	expect(provider.start).toHaveBeenCalledTimes(1);
	expect(provider.clearWake).toHaveBeenCalledTimes(1);
});

it("a machine the admission just read as running is not read again", async () => {
	provider.state = "running";
	provider.admission = true;
	await createFreestyleWorkspaceMachines("test").ensureRunning(vmId);
	expect(provider.admit).toHaveBeenCalledTimes(1);
	// The read that decided to admit; the admission's own read stands in for a third.
	expect(provider.data).toHaveBeenCalledTimes(1);
	expect(provider.start).not.toHaveBeenCalled();
	// A running machine's guest is not probed (as before).
	expect(provider.exec).not.toHaveBeenCalled();
});

it("a machine that was not resumed by this isolate is still read before it is trusted", async () => {
	provider.state = "running";
	const machines = createFreestyleWorkspaceMachines("test");
	await machines.ensureRunning(vmId);
	await machines.ensureRunning(vmId);
	// Admission off: each ensure reads the provider (no guest activity vouches for it).
	expect(provider.data.mock.calls.length).toBeGreaterThanOrEqual(2);
});
