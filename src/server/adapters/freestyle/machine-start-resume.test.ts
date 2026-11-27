import { FreestyleApiError } from "freestyle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	machineFailureCause,
	machineFailureMessage,
} from "#/domain/api-turn-failure";
import { createFreestyleWorkspaceMachines } from "./workspace-machines";

/**
 * A stateful fake of the provider's slug-keyed VMs: what a chat's machine
 * start meets after a Durable Object restart cut an earlier attempt off.
 */
const provider = vi.hoisted(() => {
	type Vm = {
		id: string;
		slug: string;
		state: string;
		resources: { cpu: number; memory: number; storage: number };
		metadata: Record<string, string>;
		/** Lists before the VM shows up (the provider lists a new VM late). */
		hiddenFor: number;
	};
	return {
		vms: [] as Vm[],
		creates: 0,
		listFailures: [] as unknown[],
		createFailure: null as unknown,
		resize: vi.fn(),
	};
});
vi.mock("freestyle", async (importOriginal) => {
	const actual = await importOriginal<typeof import("freestyle")>();
	const handle = (id: string) => {
		const find = () => {
			const vm = provider.vms.find((candidate) => candidate.id === id);
			if (!vm)
				throw new actual.FreestyleApiError(404, {
					code: "NOT_FOUND",
					message: `not found: vm ${id}`,
				});
			return vm;
		};
		return {
			id,
			data: async () => {
				const vm = find();
				// A starting VM is running on the next read.
				const read = {
					...vm,
					idleTimeoutSeconds: 180,
					autoDeleteSeconds: 7_776_000,
					totalRunSeconds: 0,
				};
				if (vm.state === "starting") vm.state = "running";
				return read;
			},
			resize: async (target: Record<string, number>) => {
				provider.resize(target);
				Object.assign(find().resources, target);
			},
			start: async () => {
				find().state = "running";
			},
			update: async () => ({}),
			exec: async () => ({ statusCode: 0, stdout: "", stderr: "" }),
			delete: async () => {
				provider.vms = provider.vms.filter((vm) => vm.id !== id);
			},
		};
	};
	return {
		...actual,
		Freestyle: class {
			vms = {
				list: async ({ slug }: { slug: string }) => {
					const failure = provider.listFailures.shift();
					if (failure) throw failure;
					return {
						vms: provider.vms.filter((vm) => {
							if (vm.slug !== slug) return false;
							if (vm.hiddenFor > 0) {
								vm.hiddenFor -= 1;
								return false;
							}
							return true;
						}),
					};
				},
				ref: (id: string) => handle(id),
				create: async (fields: {
					slug: string;
					metadata: Record<string, string>;
				}) => {
					provider.creates += 1;
					if (provider.createFailure) throw provider.createFailure;
					if (provider.vms.some((vm) => vm.slug === fields.slug))
						throw new actual.FreestyleApiError(
							409,
							{
								code: "CONFLICT",
								message: `conflict: vm slug \`${fields.slug}\` is already in use`,
							},
							"/v5/vms",
						);
					const id = `vm-${provider.vms.length + 1}`;
					provider.vms.push({
						id,
						slug: fields.slug,
						state: "starting",
						resources: { cpu: 2, memory: 4096, storage: 16384 },
						metadata: fields.metadata,
						hiddenFor: 0,
					});
					return { vm: handle(id), vmId: id };
				},
			};
		},
	};
});

/** Runs an operation whose backoff uses timers to completion. */
async function settle<T>(operation: Promise<T>): Promise<T> {
	let done = false;
	const watched = operation.finally(() => {
		done = true;
	});
	watched.catch(() => {});
	for (let step = 0; step < 400 && !done; step++)
		await vi.advanceTimersByTimeAsync(1_000);
	return watched;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	provider.vms = [];
	provider.creates = 0;
	provider.listFailures = [];
	provider.createFailure = null;
	provider.resize.mockClear();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("resumes a start a Durable Object restart cut off: the copy it made is finished, not made again", async () => {
	// The killed attempt's create landed; it died before growing the copy.
	provider.vms.push({
		id: "vm-interrupted",
		slug: "ytimesy-ag-chat",
		state: "starting",
		resources: { cpu: 2, memory: 4096, storage: 16384 },
		metadata: { machine_size: "large" },
		hiddenFor: 0,
	});
	const vm = await settle(
		createFreestyleWorkspaceMachines("test").provisionSession(
			"ytimesy-ag-chat",
			"sh-template",
		),
	);
	expect(vm).toBe("vm-interrupted");
	expect(provider.creates).toBe(0);
	expect(provider.resize).toHaveBeenCalledWith({
		cpu: 4,
		memory: 16384,
		storage: 32768,
	});
});

it("waits for a copy another attempt is still creating instead of failing on the taken slug", async () => {
	// The earlier attempt's create is in flight: the slug is taken, but the
	// provider does not list the VM yet.
	provider.vms.push({
		id: "vm-in-flight",
		slug: "ytimesy-ag-chat",
		state: "starting",
		resources: { cpu: 4, memory: 16384, storage: 32768 },
		metadata: { machine_size: "large" },
		hiddenFor: 2,
	});
	const vm = await settle(
		createFreestyleWorkspaceMachines("test").provisionSession(
			"ytimesy-ag-chat",
			"sh-template",
		),
	);
	expect(vm).toBe("vm-in-flight");
	expect(provider.creates).toBe(1);
	expect(provider.vms).toHaveLength(1);
});

it("retries transient provider errors and rate limits with backoff", async () => {
	provider.listFailures = [
		new FreestyleApiError(502, { code: "BAD_GATEWAY", message: "Bad gateway" }),
		new FreestyleApiError(429, {
			code: "RATE_LIMITED",
			message: "Too many requests",
		}),
		new Error("fetch failed"),
	];
	const vm = await settle(
		createFreestyleWorkspaceMachines("test").provisionSession(
			"ytimesy-ag-chat",
			"sh-template",
		),
	);
	expect(vm).toBe("vm-1");
	expect(provider.listFailures).toHaveLength(0);
	expect(console.warn).toHaveBeenCalledWith(
		"Machine operation failed",
		expect.objectContaining({ willRetry: true, kind: "rate-limited" }),
	);
});

it("surfaces a permanent unknown error at once, with its raw cause logged and kept (redacted)", async () => {
	provider.createFailure = new Error(
		"weird provider state for slug ytimesy-ag-chat token=abc123secret",
	);
	const failure = await settle(
		createFreestyleWorkspaceMachines("test").provisionSession(
			"ytimesy-ag-chat",
			"sh-template",
		),
	).then(
		() => null,
		(error: unknown) => error,
	);
	expect(provider.creates).toBe(1);
	expect(console.warn).toHaveBeenCalledWith(
		"Machine operation failed",
		expect.objectContaining({
			operation: "provisionSession",
			slug: "ytimesy-ag-chat",
			willRetry: false,
			kind: "permanent",
			detail: expect.stringContaining("weird provider state"),
		}),
	);
	const logged = vi
		.mocked(console.warn)
		.mock.calls.find((call) => call[0] === "Machine operation failed");
	expect(JSON.stringify(logged)).not.toContain("abc123secret");
	// The user still reads fixed wording; the owner reads the cause.
	expect(machineFailureMessage(failure)).toBe(
		"Couldn't start your workspace right now. Your message and work are saved; ytimesy tries again when you send your next message.",
	);
	const cause = machineFailureCause(failure);
	expect(cause).toContain("weird provider state for slug ytimesy-ag-chat");
	expect(cause).not.toContain("abc123secret");
});
