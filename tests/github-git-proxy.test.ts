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
const zero = "0".repeat(40);
const commit = "a".repeat(40);
const pkt = (line: string) =>
	`${(new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;
async function push(body: string, branch = "ytimesy/chat") {
	const headers = new Headers(
		await issueGitProxyGrant(secret, { ...grant, access: "write", branch }),
	);
	headers.set("content-type", "application/x-git-receive-pack-request");
	return new Request("https://proxy.test/git/owner/repo.git/git-receive-pack", {
		method: "POST",
		headers,
		body,
	});
}
/** Spent nonces, as the executor's grant claim table keeps them. */
function claims() {
	const spent = new Set<string>();
	return vi.fn(async (nonce: string, expiresAt: number) => {
		expect(expiresAt).toBeGreaterThan(Date.now());
		if (spent.has(nonce)) return false;
		spent.add(nonce);
		return true;
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
			await issueGitProxyGrant(secret, {
				...grant,
				access: "write",
				branch: "ytimesy/chat",
			}),
		);
		headers.set("content-type", "application/x-git-receive-pack-request");
		headers.set("authorization", "caller-token");
		headers.set("cookie", "private-cookie");
		const pushed = `${pkt(`${zero} ${commit} refs/heads/ytimesy/chat\0report-status`)}0000PACK-bytes`;
		const incoming = new Request(
			"https://proxy.test/git/owner/repo.git/git-receive-pack",
			{ method: "POST", headers, body: pushed },
		);
		const upstream = vi.fn(
			async (_url: string | URL | Request, options?: RequestInit) => {
				expect(await new Response(options?.body as ReadableStream).text()).toBe(
					pushed,
				);
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
			async () => true,
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
	it("lets a push grant update only its own branch, once", async () => {
		const upstream = vi.fn(async () => new Response("ok"));
		const claim = claims();
		const body = `${pkt(`${commit} ${"b".repeat(40)} refs/heads/ytimesy/chat\0report-status side-band-64k`)}0000PACK`;
		const allowed = await push(body);
		const replay = new Request(allowed.url, {
			method: "POST",
			headers: allowed.headers,
			body,
		});
		expect(
			(await proxyGithubGit(allowed, secret, async () => "t", upstream, claim))
				.status,
		).toBe(200);
		expect(
			(await proxyGithubGit(replay, secret, async () => "t", upstream, claim))
				.status,
		).toBe(403);
		expect(upstream).toHaveBeenCalledTimes(1);
		expect(claim).toHaveBeenCalledTimes(2);
	});
	it("refuses other refs, deletes, several updates and unparseable commands", async () => {
		const upstream = vi.fn(async () => new Response("ok"));
		const claim = claims();
		for (const body of [
			`${pkt(`${zero} ${commit} refs/heads/main\0report-status`)}0000PACK`,
			`${pkt(`${zero} ${commit} refs/tags/v1\0report-status`)}0000PACK`,
			`${pkt(`${commit} ${zero} refs/heads/ytimesy/chat\0report-status`)}0000`,
			`${pkt(`${zero} ${commit} refs/heads/ytimesy/chat\0report-status`)}${pkt(`${zero} ${commit} refs/heads/main`)}0000PACK`,
			`${pkt(`${zero} ${commit} refs/heads/ytimesy/chat-2\0report-status`)}0000PACK`,
			`${pkt("push-cert\0report-status")}0000`,
			"PACK",
			pkt(`${zero} ${commit} refs/heads/ytimesy/chat`),
		])
			expect(
				(
					await proxyGithubGit(
						await push(body),
						secret,
						async () => "t",
						upstream,
						claim,
					)
				).status,
			).toBe(403);
		expect(upstream).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});
	it("forwards Git's empty probe without spending the grant", async () => {
		const upstream = vi.fn(async () => new Response("ok"));
		const claim = claims();
		const probe = await push("0000");
		const real = new Request(probe.url, {
			method: "POST",
			headers: probe.headers,
			body: `${pkt(`${zero} ${commit} refs/heads/ytimesy/chat\0report-status`)}0000PACK`,
		});
		for (const incoming of [probe, real])
			expect(
				(
					await proxyGithubGit(
						incoming,
						secret,
						async () => "t",
						upstream,
						claim,
					)
				).status,
			).toBe(200);
		expect(claim).toHaveBeenCalledTimes(1);
	});
	it("refuses pushes when no grant store is wired and write grants without a branch", async () => {
		const upstream = vi.fn(async () => new Response("ok"));
		expect(
			(
				await proxyGithubGit(
					await push(
						`${pkt(`${zero} ${commit} refs/heads/ytimesy/chat\0report-status`)}0000PACK`,
					),
					secret,
					async () => "t",
					upstream,
				)
			).status,
		).toBe(403);
		await expect(
			issueGitProxyGrant(secret, { ...grant, access: "write" }),
		).rejects.toThrow();
		await expect(
			issueGitProxyGrant(secret, { ...grant, branch: "main" }),
		).rejects.toThrow();
		expect(upstream).not.toHaveBeenCalled();
	});
});
