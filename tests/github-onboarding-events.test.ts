import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	capture: vi.fn(),
	requireUser: vi.fn(),
	finish: vi.fn(),
	start: vi.fn(),
}));
vi.mock("../src/server/adapters/analytics", () => ({
	captureServerAnalytics: mocks.capture,
}));
vi.mock("../src/server/auth/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({ APP_URL: "https://ytimesy.com" }),
}));
vi.mock("../src/server/http", () => ({
	endpoint: async (run: () => Promise<unknown>) => Response.json(await run()),
	requireSameOrigin: () => undefined,
}));
vi.mock("../src/server/auth/github-connection", async () => {
	class GithubConnectionFailure extends Error {
		constructor(readonly reason: string) {
			super(reason);
		}
	}
	return {
		GithubConnectionFailure,
		finishGithubConnection: mocks.finish,
		startGithubConnection: mocks.start,
	};
});

type Handler = (input: { request: Request }) => Promise<Response>;
async function handler(path: string, method: "GET" | "POST") {
	const { Route } = await import(path);
	return (Route.options.server.handlers as Record<string, Handler>)[method];
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.requireUser.mockResolvedValue({ id: "user-1" });
	mocks.finish.mockResolvedValue(undefined);
	mocks.start.mockResolvedValue("https://github.com/login/oauth/authorize?x");
});

it("records the start of a GitHub connection", async () => {
	const post = await handler("../src/routes/api/github/connect", "POST");
	const response = await post({
		request: new Request("https://ytimesy.com/api/github/connect", {
			method: "POST",
		}),
	});
	expect(await response.json()).toEqual({
		url: "https://github.com/login/oauth/authorize?x",
	});
	expect(mocks.capture).toHaveBeenCalledWith(
		"user-1",
		"github_connect_started",
		{},
		expect.objectContaining({ key: expect.any(String) }),
	);
});

it("records how the GitHub connection finished, keeping the redirect unchanged", async () => {
	const get = await handler("../src/routes/api/github/callback", "GET");
	const callback = (query: string) =>
		get({
			request: new Request(`https://ytimesy.com/api/github/callback?${query}`),
		});
	const outcomes = () => mocks.capture.mock.calls.map((call) => call[2]);

	let response = await callback("state=s&code=c");
	expect(response.headers.get("location")).toBe(
		"https://ytimesy.com/?addProject=1",
	);
	response = await callback("error=access_denied");
	expect(response.headers.get("location")).toContain("connection=denied");
	mocks.finish.mockRejectedValueOnce(new Error("boom"));
	await callback("state=s&code=c");
	expect(outcomes()).toEqual([
		{ outcome: "connected" },
		{ outcome: "denied" },
		{ outcome: "failed" },
	]);
	expect(mocks.capture.mock.calls[0][1]).toBe("github_connect_finished");

	// Not signed in: the same "failed" redirect as before, and nothing recorded.
	mocks.capture.mockClear();
	mocks.requireUser.mockRejectedValueOnce(new Error("Unauthorized"));
	response = await callback("state=s&code=c");
	expect(response.headers.get("location")).toContain("connection=failed");
	expect(mocks.capture).not.toHaveBeenCalled();
});
