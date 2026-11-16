import { FreestyleApiError } from "freestyle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
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
	write: vi.fn(),
}));
vi.mock("freestyle", async (importOriginal) => {
	const actual = await importOriginal<typeof import("freestyle")>();
	const vm = {
		id: "vm-copy",
		data: async () => ({
			state: "running",
			resources: provider.resources,
			metadata: provider.metadata,
			idleTimeoutSeconds: 180,
			autoDeleteSeconds: 7_776_000,
		}),
		resize: provider.resize,
		update: provider.update,
		delete: provider.remove,
		exec: provider.exec,
		fs: { writeTextFile: provider.write },
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
	provider.exec.mockResolvedValue({ statusCode: 0 });
	provider.write.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
it("hands over a new copy only once its guest answers, retrying a fresh guest's fetch failure", async () => {
	vi.useFakeTimers();
	provider.exec
		.mockRejectedValueOnce(new TypeError("fetch failed"))
		.mockResolvedValue({ statusCode: 0 });
	const provisioning = createFreestyleWorkspaceMachines(
		"test",
	).provisionSession("test-copy", "sh-template");
	await vi.runAllTimersAsync();
	await expect(provisioning).resolves.toBe("vm-copy");
	vi.useRealTimers();
	expect(provider.exec).toHaveBeenCalledTimes(2);
	expect(provider.exec).toHaveBeenCalledWith(
		expect.objectContaining({ command: "true" }),
	);
	expect(provider.remove).not.toHaveBeenCalled();
});
it("says the machine is not answering when a new copy's guest never does", async () => {
	vi.useFakeTimers();
	provider.exec.mockRejectedValue(new TypeError("fetch failed"));
	const provisioning = createFreestyleWorkspaceMachines(
		"test",
	).provisionSession("test-copy", "sh-template");
	const assertion = expect(provisioning).rejects.toThrow(
		"Agent session VM started but is not answering yet. Try again in a minute.",
	);
	await vi.runAllTimersAsync();
	await assertion;
	vi.useRealTimers();
	// Kept for the next attempt, which finds it by slug and probes it again.
	expect(provider.remove).not.toHaveBeenCalled();
});
it("probes a copy an earlier attempt left behind, even though it reads as running", async () => {
	provider.existing = true;
	await createFreestyleWorkspaceMachines("test").provisionSession(
		"test-copy",
		"sh-template",
	);
	expect(provider.create).not.toHaveBeenCalled();
	expect(provider.exec).toHaveBeenCalledWith(
		expect.objectContaining({ command: "true" }),
	);
});
it("never repeats a user's command, and names a provider failure plainly", async () => {
	provider.exec.mockRejectedValue(new TypeError("fetch failed"));
	await expect(
		createFreestyleWorkspaceMachines("test").exec(
			WorkspaceId("vm-copy"),
			"npm install",
		),
	).rejects.toMatchObject({
		message: "The workspace machine is not responding. Try again in a minute.",
	});
	expect(provider.exec).toHaveBeenCalledTimes(1);
});
it("writes a file again after a transient failure (the same contents)", async () => {
	vi.useFakeTimers();
	provider.write
		.mockRejectedValueOnce(
			new FreestyleApiError(
				504,
				{ code: "UNKNOWN_ERROR", message: "Request Timeout" },
				"/v5/vms/vm-copy/fs/write",
			),
		)
		.mockResolvedValue(undefined);
	const writing = createFreestyleWorkspaceMachines("test").writeTextFile(
		WorkspaceId("vm-copy"),
		"/tb/setup.sh",
		"echo hi",
	);
	await vi.runAllTimersAsync();
	await writing;
	vi.useRealTimers();
	expect(provider.write).toHaveBeenCalledTimes(2);
});
