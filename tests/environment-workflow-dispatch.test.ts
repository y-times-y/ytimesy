import { afterEach, expect, it, vi } from "vitest";
import { dispatchEnvironmentWorkflow } from "../src/server/adapters/environment-workflow-dispatch";

const workspace = "00000000-0000-4000-8000-000000000001";
const job = "00000000-0000-4000-8000-000000000002";
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("retains the job identity across network and outer queue retries", async () => {
	vi.stubEnv(
		"YTIMESY_ENVIRONMENT_WORKFLOW_URL",
		"https://development.example/",
	);
	vi.stubEnv(
		"YTIMESY_ENVIRONMENT_WORKFLOW_SECRET",
		"local-test-secret".repeat(4),
	);
	const bodies: string[] = [];
	const fetcher = vi.fn(async (_url: string, request: RequestInit) => {
		bodies.push(String(request.body));
		if (bodies.length <= 2) throw new Error("lost response");
		return new Response(null, { status: 202 });
	});
	vi.stubGlobal("fetch", fetcher);
	await expect(
		dispatchEnvironmentWorkflow(workspace, true, null, job),
	).rejects.toThrow("uncertain");
	expect(await dispatchEnvironmentWorkflow(workspace, true, null, job)).toBe(
		true,
	);
	expect(new Set(bodies).size).toBe(1);
	expect(JSON.parse(bodies[0])).toEqual({
		requestId: job,
		workspaceId: workspace,
		force: true,
		repairModel: null,
	});
});

it("does not contact Cloudflare when the environment cutover is unset", async () => {
	vi.stubEnv("YTIMESY_ENVIRONMENT_WORKFLOW_URL", "");
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	expect(await dispatchEnvironmentWorkflow(workspace, false, null, job)).toBe(
		false,
	);
	expect(fetcher).not.toHaveBeenCalled();
});

it("rejects invalid job IDs before any remote request", async () => {
	vi.stubEnv(
		"YTIMESY_ENVIRONMENT_WORKFLOW_URL",
		"https://development.example/",
	);
	vi.stubEnv(
		"YTIMESY_ENVIRONMENT_WORKFLOW_SECRET",
		"local-test-secret".repeat(4),
	);
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	await expect(
		dispatchEnvironmentWorkflow(workspace, true, null, "invalid"),
	).rejects.toThrow();
	expect(fetcher).not.toHaveBeenCalled();
});
