import { describe, expect, it, vi } from "vitest";
import {
	type GitProxyGrant,
	issueGitProxyGrant,
	proxyGithubGit,
} from "../src/domain/github-git-proxy";

const secret = "test-only-signing-key-for-git-proxy-123456789";
const grant: GitProxyGrant = {
	userId: "user-1",
	projectId: "00000000-0000-4000-8000-000000000001",
	owner: "owner",
	name: "repo",
	installationId: 123,
	access: "read",
};
async function request(
	path = "/git/owner/repo.git/info/refs?service=git-upload-pack",
	input = grant,
) {
	return new Request(`https://proxy.test${path}`, {
		headers: await issueGitProxyGrant(secret, input),
	});
}
describe("credential-isolated Git streaming proxy", () => {
	it("does not authorize unsigned or altered grants", async () => {
		const authorize = vi.fn();
		expect(
			(
				await proxyGithubGit(
					new Request("https://proxy.test/git/owner/repo.git/info/refs"),
					secret,
					authorize,
				)
			).status,
		).toBe(401);
		const signed = await request();
		signed.headers.set(
			"x-ytimesy-git-grant",
			JSON.stringify({ ...grant, name: "other" }),
		);
		expect((await proxyGithubGit(signed, secret, authorize)).status).toBe(401);
		expect(authorize).not.toHaveBeenCalled();
	});
	it("rejects write service for read grants, other repositories, arbitrary endpoints and query parameters", async () => {
		const authorize = vi.fn();
		for (const path of [
			"/git/owner/repo.git/info/refs?service=git-receive-pack",
			"/git/other/repo.git/info/refs?service=git-upload-pack",
			"/git/owner/repo.git/info/refs?service=git-upload-pack&url=https://evil.test",
			"/git/owner/repo.git/objects/abc",
		])
			expect(
				(await proxyGithubGit(await request(path), secret, authorize)).status,
			).toBe(403);
		expect(authorize).not.toHaveBeenCalled();
	});
	it("rechecks revocation before contacting GitHub", async () => {
		const upstream = vi.fn();
		expect(
			(
				await proxyGithubGit(
					await request(),
					secret,
					async () => null,
					upstream,
				)
			).status,
		).toBe(403);
		expect(upstream).not.toHaveBeenCalled();
	});
	it("streams packs, replaces caller credentials, and never returns upstream secrets", async () => {
		const headers = new Headers(
			await issueGitProxyGrant(secret, { ...grant, access: "write" }),
		);
		headers.set("content-type", "application/x-git-receive-pack-request");
		headers.set("authorization", "caller-token");
		headers.set("cookie", "private-cookie");
		const incoming = new Request(
			"https://proxy.test/git/owner/repo.git/git-receive-pack",
			{ method: "POST", headers, body: "pack" },
		);
		const upstream = vi.fn(
			async (_url: string | URL | Request, options?: RequestInit) => {
				expect(options?.body).toBe(incoming.body);
				const forwarded = new Headers(options?.headers);
				expect(forwarded.get("authorization")).toBe(
					`Basic ${btoa("x-access-token:server-token")}`,
				);
				expect(forwarded.has("cookie")).toBe(false);
				expect(forwarded.has("x-ytimesy-git-grant")).toBe(false);
				expect(options?.redirect).toBe("manual");
				return new Response("result", {
					headers: { "set-cookie": "secret", "x-private-token": "secret" },
				});
			},
		);
		const response = await proxyGithubGit(
			incoming,
			secret,
			async () => "server-token",
			upstream,
		);
		expect(await response.text()).toBe("result");
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(response.headers.has("x-private-token")).toBe(false);
		expect(upstream.mock.calls[0][0]).toBe(
			"https://github.com/owner/repo.git/git-receive-pack",
		);
	});
	it("does not follow redirects or expose authorization failures", async () => {
		for (const status of [302, 401, 500]) {
			const response = await proxyGithubGit(
				await request(),
				secret,
				async () => "token",
				async () =>
					new Response("secret diagnostic", {
						status,
						headers: { location: "https://evil.test" },
					}),
			);
			expect(response.status).toBe(status === 401 ? 403 : 502);
			expect(await response.text()).toBe("");
		}
	});
});
