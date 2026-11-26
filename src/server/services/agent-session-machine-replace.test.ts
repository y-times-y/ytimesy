import { describe, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	MACHINE_START_ABANDON_WINDOW_MS,
	machineStartAbandoned,
} from "#/domain/machine-replacement";
import { machineStartUnstartable } from "../adapters/freestyle/machine-failure.ts";
import { executeSessionMachinePlan } from "./agent-session-machine.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";
const STUCK = new Error("Workspace VM did not become running");
const START = 60_000;
const WINDOW = MACHINE_START_ABANDON_WINDOW_MS;

/** A provider whose VM `stuck-vm` never starts, and whose slug-keyed copies are adopted like Freestyle's. */
function fleet(options: { unstartable?: (cause: unknown) => boolean } = {}) {
	const bySlug = new Map<string, string>([
		["ytimesy-ag-1111111122223333", "stuck-vm"],
	]);
	const calls = {
		destroyed: [] as string[],
		provisioned: [] as string[],
		saved: [] as string[],
		rebound: [] as string[],
	};
	const streakStartedAt: number | null = START;
	const failures = 3;
	const api = {
		snapshotEnvironment: async () => "snap-1",
		provisionSession: async (slug: string) => {
			calls.provisioned.push(slug);
			const adopted = bySlug.get(slug);
			if (adopted) return WorkspaceId(adopted);
			const id = `vm-for-${slug}`;
			bySlug.set(slug, id);
			return WorkspaceId(id);
		},
		ensureRunning: async (id: string) => {
			if (id === "stuck-vm") throw STUCK;
			return WorkspaceId(id);
		},
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		writeTextFile: async () => {},
		rebindRetainedSession: async (_s: string, from: string, to: string) => {
			calls.rebound.push(`${from}>${to}`);
		},
		replacementSessionSlug: async (_s: string, oldVm: string) =>
			oldVm === "stuck-vm"
				? "ytimesy-ag-1111111122223333-r2"
				: "ytimesy-ag-1111111122223333-r3",
		destroy: async (id: string) => {
			calls.destroyed.push(id);
		},
	};
	const input = (now: number, extra: Record<string, unknown> = {}) => ({
		machines: api,
		sessionId: SESSION,
		sessionProviderRef: "stuck-vm",
		replaceMissingReadOnly: true,
		replaceUnstartable: async (_vm: string, cause: unknown) =>
			(options.unstartable ?? machineStartUnstartable)(cause) &&
			machineStartAbandoned({
				firstFailureAt:
					streakStartedAt === null ? null : new Date(streakStartedAt),
				failures,
				now: new Date(now),
			}),
		workspaceId: "ws-1",
		templateSnapshotId: "snap-1",
		templateProviderRef: "repo-vm",
		saveTemplateSnapshot: async () => undefined,
		saveSessionProviderRef: async (ref: string) => {
			calls.saved.push(ref);
		},
		...extra,
	});
	return { api, calls, input };
}

describe("machineStartAbandoned", () => {
	const first = new Date(0);
	it("is false before the window, with no record, and after one failure", () => {
		expect(
			machineStartAbandoned({
				firstFailureAt: first,
				now: new Date(WINDOW - 1),
			}),
		).toBe(false);
		expect(
			machineStartAbandoned({
				firstFailureAt: null,
				now: new Date(WINDOW * 9),
			}),
		).toBe(false);
		expect(
			machineStartAbandoned({
				firstFailureAt: first,
				failures: 1,
				now: new Date(WINDOW * 9),
			}),
		).toBe(false);
	});
	it("is true from the window on, and the window is injectable", () => {
		expect(
			machineStartAbandoned({
				firstFailureAt: first,
				failures: 2,
				now: new Date(WINDOW),
			}),
		).toBe(true);
		expect(
			machineStartAbandoned({
				firstFailureAt: first,
				now: new Date(1000),
				windowMs: 1000,
			}),
		).toBe(true);
	});
});

describe("replacing a VM that cannot start", () => {
	it("keeps failing the start before the window has passed", async () => {
		const f = fleet();
		await expect(
			executeSessionMachinePlan(f.input(START + WINDOW - 1)),
		).rejects.toBe(STUCK);
		expect(f.calls.provisioned).toEqual([]);
		expect(f.calls.saved).toEqual([]);
	});

	it("gives the chat a new generation's VM after the window, never destroying the old one", async () => {
		const f = fleet();
		const result = await executeSessionMachinePlan(f.input(START + WINDOW));
		expect(result).toEqual({
			providerRef: "vm-for-ytimesy-ag-1111111122223333-r2",
			planKind: "replace-unstartable",
			replacedProviderRef: "stuck-vm",
		});
		expect(f.calls.provisioned).toEqual(["ytimesy-ag-1111111122223333-r2"]);
		expect(f.calls.rebound).toEqual([
			"stuck-vm>vm-for-ytimesy-ag-1111111122223333-r2",
		]);
		expect(f.calls.destroyed).toEqual([]);
	});

	it("finds the replacement a crashed attempt made instead of making a third", async () => {
		const f = fleet();
		const first = await executeSessionMachinePlan(f.input(START + WINDOW));
		// The crash came before the chat saved it: the chat still names stuck-vm.
		const second = await executeSessionMachinePlan(
			f.input(START + WINDOW + 5_000),
		);
		expect(second.providerRef).toBe(first.providerRef);
		expect(f.calls.provisioned).toEqual([
			"ytimesy-ag-1111111122223333-r2",
			"ytimesy-ag-1111111122223333-r2",
		]);
		expect(f.calls.destroyed).toEqual([]);
	});

	it("never replaces a subagent's machine", async () => {
		const f = fleet();
		await expect(
			executeSessionMachinePlan(
				f.input(START + WINDOW, { replaceMissingReadOnly: false }),
			),
		).rejects.toBe(STUCK);
		expect(f.calls.provisioned).toEqual([]);
	});

	it("never replaces for capacity or allowance refusals", async () => {
		for (const message of [
			"LIMIT_EXCEEDED: account is at its VM limit",
			"allowance for vcpu_time has been used",
		]) {
			const f = fleet();
			const cause = new Error(message);
			f.api.ensureRunning = async () => {
				throw cause;
			};
			await expect(
				executeSessionMachinePlan(f.input(START + WINDOW * 3)),
			).rejects.toBe(cause);
			expect(f.calls.provisioned).toEqual([]);
		}
	});

	it("leaves the not-found path as it was", async () => {
		const f = fleet();
		f.api.ensureRunning = async () => {
			throw new Error("VM not found");
		};
		const result = await executeSessionMachinePlan(f.input(START));
		expect(result.planKind).toBe("recover-read-only");
		expect(f.calls.provisioned).toEqual(["ytimesy-ag-1111111122223333"]);
	});
});
