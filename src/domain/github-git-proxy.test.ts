import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import {
	forgetGitReadAuthorizationsForTests,
	issueGitProxyGrant,
	proxyGithubGit,
} from "./github-git-proxy";

const SECRET = "s".repeat(48);
const ORIGIN = "https://proxy.example.test";

async function proxied(body: Uint8Array, headers: Record<string, string>) {
	const grant = await issueGitProxyGrant(SECRET, {
		userId: "u1",
		projectId: "00000000-0000-4000-8000-000000000001",
		owner: "you",
		name: "web",
		installationId: 1,
		access: "read",
	});
	const seen: { body: string; encoding: string | null }[] = [];
	const upstream = (async (_url: string, init: RequestInit) => {
		const text = await new Response(init.body as BodyInit).text();
		seen.push({
			body: text,
			encoding: new Headers(init.headers).get("content-encoding"),
		});
		return new Response("ok", { status: 200 });
	}) as unknown as typeof fetch;
	const response = await proxyGithubGit(
		new Request(`${ORIGIN}/git/you/web.git/git-upload-pack`, {
			method: "POST",
			headers: {
				...grant,
				"content-type": "application/x-git-upload-pack-request",
				...headers,
			},
			body,
			duplex: "half",
		} as RequestInit),
		SECRET,
		async () => "token",
		upstream,
	);
	return { status: response.status, seen };
}

it("sends GitHub a gzipped fetch request plain", async () => {
	const plain = "0011command=fetch\n0000";
	const { status, seen } = await proxied(gzipSync(plain), {
		"content-encoding": "gzip",
	});
	expect(status).toBe(200);
	expect(seen).toEqual([{ body: plain, encoding: null }]);
});

it("passes a plain fetch request through", async () => {
	const plain = "0011command=fetch\n0000";
	const { seen } = await proxied(new TextEncoder().encode(plain), {});
	expect(seen).toEqual([{ body: plain, encoding: null }]);
});

it("forwards a body already decoded on the way, without the gzip header", async () => {
	const plain = "0011command=fetch\n0000";
	const { seen } = await proxied(new TextEncoder().encode(plain), {
		"content-encoding": "gzip",
	});
	expect(seen).toEqual([{ body: plain, encoding: null }]);
});

it("authorizes a read grant once for all of a fetch's requests, but not another grant's", async () => {
	forgetGitReadAuthorizationsForTests();
	const issue = () =>
		issueGitProxyGrant(SECRET, {
			userId: "u1",
			projectId: "00000000-0000-4000-8000-000000000001",
			owner: "you",
			name: "web",
			installationId: 1,
			access: "read",
		});
	const upstream = (async () =>
		new Response("ok", { status: 200 })) as unknown as typeof fetch;
	let checks = 0;
	const authorize = async () => {
		checks += 1;
		return "token";
	};
	const request = (grant: Record<string, string>) =>
		proxyGithubGit(
			new Request(
				`${ORIGIN}/git/you/web.git/info/refs?service=git-upload-pack`,
				{ headers: grant },
			),
			SECRET,
			authorize,
			upstream,
		);
	const grant = await issue();
	const statuses = [
		(await request(grant)).status,
		(await request(grant)).status,
		(await request(grant)).status,
	];
	expect(statuses).toEqual([200, 200, 200]);
	expect(checks).toBe(1);
	await new Promise((resolve) => setTimeout(resolve, 2));
	await request(await issue());
	expect(checks).toBe(2);
});

it("checks a refused read grant again on its next request", async () => {
	forgetGitReadAuthorizationsForTests();
	const grant = await issueGitProxyGrant(SECRET, {
		userId: "u1",
		projectId: "00000000-0000-4000-8000-000000000001",
		owner: "you",
		name: "web",
		installationId: 1,
		access: "read",
	});
	let checks = 0;
	const request = () =>
		proxyGithubGit(
			new Request(
				`${ORIGIN}/git/you/web.git/info/refs?service=git-upload-pack`,
				{ headers: grant },
			),
			SECRET,
			async () => {
				checks += 1;
				return null;
			},
		);
	expect((await request()).status).toBe(403);
	expect((await request()).status).toBe(403);
	expect(checks).toBe(2);
});
