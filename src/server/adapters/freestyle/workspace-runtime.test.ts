import { describe, expect, it } from "vitest";
import { UnconfiguredWorkspaceRuntime } from "../workspace-runtime";
import {
	FreestyleWorkspaceRuntime,
	workspaceRuntimeFromEnv,
} from "./workspace-runtime";

describe("workspaceRuntimeFromEnv", () => {
	it("stays unconfigured until a Freestyle API key is present", () => {
		expect(workspaceRuntimeFromEnv({})).toBeInstanceOf(
			UnconfiguredWorkspaceRuntime,
		);
		expect(workspaceRuntimeFromEnv({ FREESTYLE_API_KEY: "  " })).toBeInstanceOf(
			UnconfiguredWorkspaceRuntime,
		);
		expect(
			workspaceRuntimeFromEnv({ FREESTYLE_API_KEY: "fs_test" }),
		).toBeInstanceOf(FreestyleWorkspaceRuntime);
	});
});

describe("FreestyleWorkspaceRuntime.pause", () => {
	it("takes down the VM's desktop and tool routes before pausing it", async () => {
		const calls: string[] = [];
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			calls.push(`${method} ${url.pathname}`);
			if (url.pathname === "/v5/tls")
				return Response.json({
					totalCount: 2,
					rules: [
						{
							id: "desk",
							domain: "ytimesy-desk-abc.style.dev",
							source: { public: true },
							destination: { vmId: "vm-1", port: 6080 },
						},
						{
							id: "preview",
							domain: "ytimesy-pv-abc-3000.style.dev",
							source: { public: true },
							destination: { vmId: "vm-1", port: 3000 },
						},
					],
				});
			if (method === "DELETE") return new Response(null, { status: 204 });
			return Response.json({ id: "vm-1", state: "running" });
		};
		await new FreestyleWorkspaceRuntime("fs_test", {
			fetch: fetch as typeof globalThis.fetch,
		}).pause("vm-1");
		expect(calls).toEqual([
			"GET /v5/tls",
			"DELETE /v5/tls/desk",
			"GET /v5/vms/vm-1",
			"POST /v5/vms/vm-1/pause",
		]);
	});
});

describe("FreestyleWorkspaceRuntime admission reuse", () => {
	const fetch = (async () =>
		Response.json({
			statusCode: 0,
			stdout: "",
			stderr: "",
		})) as unknown as typeof globalThis.fetch;
	async function recoveries(
		options: { admissionReuseMs?: number },
		timeouts: number[],
	) {
		const previous = process.env.YTIMESY_INFRASTRUCTURE_ADMISSION;
		process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "true";
		try {
			const runtime = new FreestyleWorkspaceRuntime("fs_test", {
				fetch,
				...options,
			});
			const recovered: number[] = [];
			runtime.recover = async (ref: string, seconds = 60) => {
				recovered.push(seconds);
				return ref;
			};
			for (const timeout of timeouts)
				await runtime.exec("vm-1", ["true"], {}, timeout);
			return recovered;
		} finally {
			if (previous === undefined)
				delete process.env.YTIMESY_INFRASTRUCTURE_ADMISSION;
			else process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = previous;
		}
	}

	it("admits every command by default", async () => {
		expect(await recoveries({}, [15_000, 15_000, 15_000])).toEqual([
			15, 15, 15,
		]);
	});

	it("lets a build's short commands reuse a recent admission, not a long one", async () => {
		expect(
			await recoveries({ admissionReuseMs: 30_000 }, [15_000, 15_000, 25_000]),
		).toEqual([15]);
		// A command needing more than the admission is sure to cover is admitted again.
		expect(
			await recoveries({ admissionReuseMs: 30_000 }, [15_000, 200_000]),
		).toEqual([15, 200]);
	});
});
