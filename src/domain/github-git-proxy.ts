import { z } from "zod";
import { signDeliveryRequest, verifyDeliveryRequest } from "./delivery-auth";

const repositoryPart = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const grantSchema = z
	.object({
		userId: z.string().min(1).max(128),
		projectId: z.uuid(),
		owner: repositoryPart,
		name: repositoryPart,
		installationId: z.number().int().positive(),
		access: z.enum(["read", "write"]),
	})
	.strict();
export type GitProxyGrant = z.infer<typeof grantSchema>;
const grantUrl = "https://git-grant.internal/git-grant";
const grantHeader = "x-ytimesy-git-grant";
export class GitProxyFailure extends Error {
	constructor(
		readonly stage:
			| "database"
			| "user-connection"
			| "repository-access"
			| "installation-token",
	) {
		super("Git proxy authorization failed.");
	}
}

/** Short-lived repository capability, not a GitHub credential. Never put it in a URL. */
export async function issueGitProxyGrant(secret: string, input: GitProxyGrant) {
	const body = JSON.stringify(grantSchema.parse(input));
	return {
		[grantHeader]: body,
		...(await signDeliveryRequest(secret, "POST", grantUrl, body)),
	};
}

function gitTarget(request: Request, grant: GitProxyGrant) {
	const url = new URL(request.url);
	const root = `/git/${grant.owner}/${grant.name}.git/`;
	if (url.pathname === `${root}info/refs` && request.method === "GET") {
		const service = url.searchParams.get("service");
		if (url.search !== `?service=${service}`) return null;
		if (
			service === "git-upload-pack" ||
			(service === "git-receive-pack" && grant.access === "write")
		)
			return `https://github.com/${grant.owner}/${grant.name}.git/info/refs${url.search}`;
	}
	if (request.method !== "POST" || url.search) return null;
	for (const service of ["git-upload-pack", "git-receive-pack"]) {
		if (service === "git-receive-pack" && grant.access !== "write") continue;
		if (
			url.pathname === `${root}${service}` &&
			request.headers.get("content-type") === `application/x-${service}-request`
		)
			return `https://github.com/${grant.owner}/${grant.name}.git/${service}`;
	}
	return null;
}

/** Fixed-origin Git smart HTTP only. Neither Git packs nor responses are buffered. */
export async function proxyGithubGit(
	request: Request,
	secret: string,
	authorize: (grant: GitProxyGrant) => Promise<string | null>,
	upstream: typeof fetch = fetch,
) {
	const body = request.headers.get(grantHeader);
	if (!body || body.length > 2048) return new Response(null, { status: 401 });
	let grant: GitProxyGrant;
	try {
		grant = grantSchema.parse(JSON.parse(body));
	} catch {
		return new Response(null, { status: 401 });
	}
	if (
		!(await verifyDeliveryRequest(
			secret,
			new Request(grantUrl, { method: "POST", headers: request.headers }),
			body,
		))
	)
		return new Response(null, { status: 401 });
	const target = gitTarget(request, grant);
	if (!target) return new Response(null, { status: 403 });
	try {
		const token = await authorize(grant);
		if (!token) return new Response(null, { status: 403 });
		const headers = new Headers({
			authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
			"user-agent": "ytimesy-git-proxy",
		});
		for (const name of [
			"content-type",
			"git-protocol",
			"accept",
			"content-encoding",
		])
			if (request.headers.has(name))
				headers.set(name, request.headers.get(name) ?? "");
		const response = await upstream(target, {
			method: request.method,
			headers,
			body: request.method === "POST" ? request.body : null,
			redirect: "manual",
			signal: request.signal,
			duplex: "half",
		} as RequestInit);
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			return new Response(null, { status: 502 });
		}
		if (!response.ok) {
			await response.body?.cancel();
			return new Response(null, {
				status: response.status === 401 || response.status === 403 ? 403 : 502,
			});
		}
		return new Response(response.body, {
			status: response.status,
			headers: {
				"content-type":
					response.headers.get("content-type") ?? "application/octet-stream",
				"cache-control": "no-store",
			},
		});
	} catch (cause) {
		console.warn("Git proxy operation failed.", {
			stage: cause instanceof GitProxyFailure ? cause.stage : "transport",
		});
		return new Response(null, { status: 503 });
	}
}
