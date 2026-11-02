import { expect, it, vi } from "vitest";
import { Route } from "../src/routes/api/workspaces";

const jobs = vi.hoisted(() => ({
	prepare: vi.fn(),
	refresh: vi.fn(),
	progress: vi.fn(async (workspaceId: string) => ({
		build: { id: "build", status: "running", workspaceId },
		steps: [],
	})),
}));
vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: unknown) => options,
}));
vi.mock("../src/server/auth/auth", () => ({
	requireUser: async () => ({ id: "alice" }),
}));
vi.mock("../src/server/adapters/workspaces", () => ({
	workspaceForProject: async () => ({ id: "workspace", status: "ready" }),
}));
vi.mock("../src/server/services/workspaces", () => ({
	enqueueProjectWorkspace: jobs.prepare,
	enqueueWorkspaceSnapshotRefresh: jobs.refresh,
	workspaceStatusView: async (workspace: unknown) => workspace,
}));
vi.mock("../src/server/adapters/environment-build-steps", () => ({
	environmentBuildProgress: jobs.progress,
}));
vi.mock("../src/server/http", () => ({
	endpoint: async (fn: () => Promise<unknown>) => Response.json(await fn()),
}));

it("repeated status reads do not create environment jobs", async () => {
	const route = Route as unknown as {
		server: {
			handlers: { GET: (input: { request: Request }) => Promise<Response> };
		};
	};
	for (let i = 0; i < 10; i++) {
		const response = await route.server.handlers.GET({
			request: new Request(
				"http://localhost/api/workspaces?projectId=11111111-1111-4111-8111-111111111111",
			),
		});
		expect(await response.json()).toEqual({ id: "workspace", status: "ready" });
	}
	expect(jobs.prepare).not.toHaveBeenCalled();
	expect(jobs.refresh).not.toHaveBeenCalled();
});

it("reads the newest build's steps for the live setup view, without starting a job", async () => {
	const route = Route as unknown as {
		server: {
			handlers: { GET: (input: { request: Request }) => Promise<Response> };
		};
	};
	const response = await route.server.handlers.GET({
		request: new Request(
			"http://localhost/api/workspaces?projectId=11111111-1111-4111-8111-111111111111&progress=1",
		),
	});
	expect(await response.json()).toEqual({
		build: { id: "build", status: "running", workspaceId: "workspace" },
		steps: [],
	});
	expect(jobs.progress).toHaveBeenCalledWith("workspace");
	expect(jobs.prepare).not.toHaveBeenCalled();
});
