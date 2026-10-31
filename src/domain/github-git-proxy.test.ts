import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { issueGitProxyGrant, proxyGithubGit } from "./github-git-proxy";

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
