import { describe, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { isTemplateRebuilding } from "#/domain/template-rebuild";
import { isMachineRefusalThatPasses } from "#/domain/turn-interruption";
import { executeSessionMachinePlan } from "./agent-session-machine.ts";

function runtime(options: { provisionError: string; ensureError?: string }) {
	let provisions = 0;
	return {
		provisions: () => provisions,
		api: {
			snapshotEnvironment: async () => "snap-new",
			provisionSession: async () => {
				provisions += 1;
				throw new Error(options.provisionError);
			},
			ensureRunning: async (id: string) => {
				if (options.ensureError) throw new Error(options.ensureError);
				return WorkspaceId(id);
			},
			exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			writeTextFile: async () => undefined,
		},
	};
}

const base = {
	sessionId: "11111111-2222-3333-4444-555555555555",
	sessionProviderRef: null,
	workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	templateSnapshotId: "sh-old",
	saveTemplateSnapshot: async () => undefined,
	saveSessionProviderRef: async () => undefined,
};

describe("a project whose template is gone", () => {
	it("rebuilds once and fails the start as a retryable wait when snapshot and build VM are both 404", async () => {
		const machines = runtime({
			provisionError: "Snapshot sh-old not found (404 NOT_FOUND)",
			ensureError: "VM repo-vm not found (404 NOT_FOUND)",
		});
		let rebuilds = 0;
		const failure = await executeSessionMachinePlan({
			...base,
			machines: machines.api,
			templateProviderRef: "repo-vm",
			rebuildMissingTemplate: async () => {
				rebuilds += 1;
			},
		}).catch((cause) => cause);
		expect(rebuilds).toBe(1);
		expect(isTemplateRebuilding(failure)).toBe(true);
		// The turn's executor resumes the step instead of failing it.
		expect(isMachineRefusalThatPasses(failure)).toBe(true);
		expect(String(failure.message)).not.toMatch(/404|NOT_FOUND/);
	});

	it("rebuilds when the snapshot is 404 and the project has no build VM left", async () => {
		const machines = runtime({ provisionError: "Snapshot not found (404)" });
		let rebuilds = 0;
		const failure = await executeSessionMachinePlan({
			...base,
			machines: machines.api,
			templateProviderRef: null,
			rebuildMissingTemplate: async () => {
				rebuilds += 1;
			},
		}).catch((cause) => cause);
		expect(rebuilds).toBe(1);
		expect(isTemplateRebuilding(failure)).toBe(true);
	});

	it("still reseals from the build VM when it exists (no rebuild)", async () => {
		const sealed: string[] = [];
		let first = true;
		const machines = {
			snapshotEnvironment: async () => "snap-resealed",
			provisionSession: async () => {
				if (first) {
					first = false;
					throw new Error("Snapshot not found (404)");
				}
				return WorkspaceId("agent-vm");
			},
			ensureRunning: async (id: string) => WorkspaceId(id),
			exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			writeTextFile: async () => undefined,
		};
		let rebuilds = 0;
		const result = await executeSessionMachinePlan({
			...base,
			machines,
			templateProviderRef: "repo-vm",
			saveTemplateSnapshot: async (id) => {
				sealed.push(id);
			},
			rebuildMissingTemplate: async () => {
				rebuilds += 1;
			},
		});
		expect(rebuilds).toBe(0);
		expect(sealed).toEqual(["snap-resealed"]);
		expect(result.providerRef).toBe("agent-vm");
	});

	it("never rebuilds for capacity, quota or other non-404 failures", async () => {
		const machines = runtime({
			provisionError: "Account resource limit exceeded (LIMIT_EXCEEDED)",
		});
		let rebuilds = 0;
		await executeSessionMachinePlan({
			...base,
			machines: machines.api,
			templateProviderRef: null,
			wait: async () => undefined,
			rebuildMissingTemplate: async () => {
				rebuilds += 1;
			},
		}).catch(() => undefined);
		expect(rebuilds).toBe(0);
	});
});
