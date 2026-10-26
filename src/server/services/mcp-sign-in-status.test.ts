import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	servers: [] as {
		server: Record<string, unknown>;
		sealedOAuth: string | null;
	}[],
}));
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient: mocks.connect }));
vi.mock("../adapters/mcp-servers", () => ({
	listMcpServersWithOAuth: async () => mocks.servers,
	saveMcpOAuth: vi.fn(),
}));
vi.mock("./mcp-oauth", () => ({
	mcpOAuthRedirectUrl: () => "http://app/cb",
	readOAuthRecord: async (sealed: string | null) => ({
		tokens: sealed ? { access_token: "token" } : undefined,
	}),
	storedOAuthProvider: () => ({ authorizationUrl: undefined }),
}));
vi.mock("../config", () => ({
	serverConfig: () => ({ APP_URL: "http://app" }),
}));
vi.mock("../auth/token-vault", () => ({ seal: vi.fn() }));
vi.mock("../adapters/workers-fetch", () => ({
	redirectRefusingFetch: () => fetch,
}));

const { forgetMcpSignInChecks, listMcpServersChecked, SIGN_IN_CHECK_TTL_MS } =
	await import("./mcp-sign-in-status");

const oauth = (sealedOAuth: string | null, url = "https://mcp.example/a") => ({
	server: { id: "s1", auth: "oauth", url },
	sealedOAuth,
});
beforeEach(() => {
	forgetMcpSignInChecks();
	vi.useRealTimers();
	mocks.connect.mockReset().mockResolvedValue({ close: async () => {} });
	mocks.servers = [oauth("sealed-1")];
});

it("checks a server's sign-in once a minute, not on every read", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	expect((await listMcpServersChecked("u"))[0].signIn).toBe("signed-in");
	expect((await listMcpServersChecked("u"))[0].signIn).toBe("signed-in");
	expect(mocks.connect).toHaveBeenCalledTimes(1);
	vi.setSystemTime(Date.now() + SIGN_IN_CHECK_TTL_MS + 1);
	await listMcpServersChecked("u");
	expect(mocks.connect).toHaveBeenCalledTimes(2);
});

it("checks again at once after a new sign-in, a changed URL, or for another user", async () => {
	mocks.servers = [oauth(null)];
	expect((await listMcpServersChecked("u"))[0].signIn).toBe("needs-sign-in");
	mocks.servers = [oauth("sealed-2")];
	expect((await listMcpServersChecked("u"))[0].signIn).toBe("signed-in");
	mocks.servers = [oauth("sealed-2", "https://mcp.example/b")];
	await listMcpServersChecked("u");
	await listMcpServersChecked("v");
	expect(mocks.connect).toHaveBeenCalledTimes(3);
});

it("never reuses an unreachable answer", async () => {
	mocks.connect.mockRejectedValueOnce(new Error("down"));
	expect((await listMcpServersChecked("u"))[0].signIn).toBe("unreachable");
	expect((await listMcpServersChecked("u"))[0].signIn).toBe("signed-in");
	expect(mocks.connect).toHaveBeenCalledTimes(2);
});
