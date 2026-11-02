import { z } from "zod";
import {
	EXPIRY_HEADER,
	signDeliveryRequest,
	verifyDeliveryRequest,
} from "./delivery-auth";

const repositoryPart = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
/**
 * A write grant names the one branch it may update and carries a nonce the
 * proxy consumes on the ref update, so a copied grant cannot be replayed.
 */
const grantSchema = z
	.object({
		userId: z.string().min(1).max(128),
		projectId: z.uuid(),
		owner: repositoryPart,
		name: repositoryPart,
		installationId: z.number().int().positive(),
		access: z.enum(["read", "write"]),
		branch: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[^\s\0~^:?*[\\]+$/)
			.optional(),
		nonce: z
			.string()
			.regex(/^[a-f0-9]{32}$/)
			.optional(),
	})
	.strict()
	.refine((grant) =>
		grant.access === "write"
			? Boolean(grant.branch && grant.nonce)
			: !grant.branch && !grant.nonce,
	);
export type GitProxyGrant = z.infer<typeof grantSchema>;
type GitProxyGrantInput = Omit<GitProxyGrant, "nonce">;
const grantUrl = "https://git-grant.internal/git-grant";
const grantHeader = "x-ytimesy-git-grant";
export class GitProxyFailure extends Error {
	constructor(
		readonly stage:
			| "database"
			| "user-connection"
			| "repository-access"
			| "installation-token"
			| "grant-claim",
	) {
		super("Git proxy authorization failed.");
	}
}

/** Short-lived repository capability, not a GitHub credential. Never put it in a URL. */
export async function issueGitProxyGrant(
	secret: string,
	input: GitProxyGrantInput,
) {
	const nonce =
		input.access === "write"
			? Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
					value.toString(16).padStart(2, "0"),
				).join("")
			: undefined;
	const body = JSON.stringify(grantSchema.parse({ ...input, nonce }));
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

type RefUpdate = { oldId: string; newId: string; ref: string };
const MAX_COMMAND_BYTES = 65_536;
const objectId = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
const commandLine = new RegExp(`^(${objectId}) (${objectId}) (\\S+)$`);
const shallowLine = new RegExp(`^shallow ${objectId}$`);

function ascii(bytes: Uint8Array) {
	return String.fromCharCode(...bytes);
}

/**
 * Reads receive-pack's ref update commands (pkt-lines up to the first flush)
 * and returns a body that replays them ahead of the unread pack. Only the
 * command list is buffered; null means it is malformed or too large.
 */
export async function readReceivePackCommands(
	body: ReadableStream<Uint8Array>,
) {
	const reader = body.getReader();
	let buffer = new Uint8Array(0);
	let offset = 0;
	const updates: RefUpdate[] = [];
	const fail = () => {
		reader.cancel().catch(() => undefined);
		return null;
	};
	for (;;) {
		if (buffer.length - offset >= 4) {
			const header = ascii(buffer.subarray(offset, offset + 4));
			if (!/^[0-9a-f]{4}$/i.test(header)) return fail();
			const length = Number.parseInt(header, 16);
			if (length === 0) break;
			if (length < 5) return fail();
			if (buffer.length - offset >= length) {
				const line = ascii(buffer.subarray(offset + 4, offset + length))
					.split("\0")[0]
					.replace(/\n$/, "");
				const command = commandLine.exec(line);
				if (command)
					updates.push({
						oldId: command[1],
						newId: command[2],
						ref: command[3],
					});
				else if (!shallowLine.test(line)) return fail();
				offset += length;
				continue;
			}
		}
		if (buffer.length >= MAX_COMMAND_BYTES) return fail();
		const { done, value } = await reader.read();
		if (done) return fail();
		const next = new Uint8Array(buffer.length + value.length);
		next.set(buffer);
		next.set(value, buffer.length);
		buffer = next;
	}
	const prefix = buffer;
	return {
		updates,
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(prefix);
			},
			async pull(controller) {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		}),
	};
}

/**
 * Fixed-origin Git smart HTTP only. Packs and responses are streamed; a push
 * may update only the grant's branch, never delete it, and consumes the grant.
 */
/**
 * A gzip request body as plain bytes: gunzipped when it starts with the gzip
 * magic bytes, as is when something on the way already decoded it.
 */
async function plainBody(
	body: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
	const reader = body.getReader();
	const first = await reader.read();
	const head = first.value ?? new Uint8Array();
	const rest = new ReadableStream<Uint8Array>({
		start(controller) {
			if (head.length) controller.enqueue(head);
			if (first.done) controller.close();
		},
		async pull(controller) {
			const next = await reader.read();
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	if (head[0] !== 0x1f || head[1] !== 0x8b) return rest;
	return rest.pipeThrough(
		new DecompressionStream("gzip") as unknown as ReadableWritablePair<
			Uint8Array,
			Uint8Array
		>,
	);
}

/**
 * A fetch is two or three requests (refs, then packs) carrying the same read
 * grant: they share one authorization, which re-checked the owner and GitHub
 * access, instead of each repeating it (about a second each). Keyed by the
 * grant's signature, so only that grant's own requests share it, and never
 * past the grant's expiry (at most a minute). Write grants authorize every
 * request.
 */
const readAuthorizations = new Map<
	string,
	{ readonly expiresAt: number; readonly token: Promise<string | null> }
>();
const MAX_READ_AUTHORIZATIONS = 256;

function authorizeReadOnce(
	request: Request,
	grant: GitProxyGrant,
	authorize: (grant: GitProxyGrant) => Promise<string | null>,
) {
	const signature = request.headers.get("x-ytimesy-delivery-signature") ?? "";
	const expiresAt = Number(request.headers.get(EXPIRY_HEADER));
	const now = Date.now();
	const known = readAuthorizations.get(signature);
	if (known && known.expiresAt > now) return known.token;
	for (const [key, entry] of readAuthorizations)
		if (
			entry.expiresAt <= now ||
			readAuthorizations.size >= MAX_READ_AUTHORIZATIONS
		)
			readAuthorizations.delete(key);
	const token = authorize(grant);
	readAuthorizations.set(signature, { expiresAt, token });
	// A refusal or failure is not remembered: the next request checks again.
	token.then(
		(value) => {
			if (!value) readAuthorizations.delete(signature);
		},
		() => readAuthorizations.delete(signature),
	);
	return token;
}

export function forgetGitReadAuthorizationsForTests() {
	readAuthorizations.clear();
}

export async function proxyGithubGit(
	request: Request,
	secret: string,
	authorize: (grant: GitProxyGrant) => Promise<string | null>,
	upstream: typeof fetch = fetch,
	claimGrant: (
		nonce: string,
		expiresAt: number,
	) => Promise<boolean> = async () => false,
) {
	const signed = request.headers.get(grantHeader);
	if (!signed || signed.length > 2048)
		return new Response(null, { status: 401 });
	let grant: GitProxyGrant;
	try {
		grant = grantSchema.parse(JSON.parse(signed));
	} catch {
		return new Response(null, { status: 401 });
	}
	if (
		!(await verifyDeliveryRequest(
			secret,
			new Request(grantUrl, { method: "POST", headers: request.headers }),
			signed,
		))
	)
		return new Response(null, { status: 401 });
	const target = gitTarget(request, grant);
	if (!target) return new Response(null, { status: 403 });
	let body: ReadableStream<Uint8Array> | null =
		request.method === "POST" ? request.body : null;
	let claims = false;
	if (request.method === "POST" && target.endsWith("/git-receive-pack")) {
		if (!request.body || request.headers.has("content-encoding"))
			return new Response(null, { status: 403 });
		const commands = await readReceivePackCommands(request.body);
		if (
			!commands ||
			commands.updates.length > 1 ||
			commands.updates.some(
				(update) =>
					update.ref !== `refs/heads/${grant.branch}` ||
					/^0+$/.test(update.newId),
			)
		)
			return new Response(null, { status: 403 });
		body = commands.body;
		// Git probes large pushes with an empty command list first; only the
		// request that updates the ref spends the grant.
		claims = commands.updates.length === 1;
	}
	try {
		const token = await (grant.access === "read"
			? authorizeReadOnce(request, grant, authorize)
			: authorize(grant));
		if (!token) return new Response(null, { status: 403 });
		if (
			claims &&
			!(await claimGrant(
				grant.nonce ?? "",
				Number(request.headers.get(EXPIRY_HEADER)),
			))
		) {
			body?.cancel().catch(() => undefined);
			return new Response(null, { status: 403 });
		}
		const headers = new Headers({
			authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
			"user-agent": "ytimesy-git-proxy",
		});
		for (const name of ["content-type", "git-protocol", "accept"])
			if (request.headers.has(name))
				headers.set(name, request.headers.get(name) ?? "");
		// Git gzips fetch requests over 1 KB (a checkout with history sends
		// many "have" lines); a fresh clone's are smaller. GitHub gets the
		// request plain, so the body it reads is the body Git meant.
		const encoding = request.headers.get("content-encoding")?.toLowerCase();
		if (body && encoding === "gzip") body = await plainBody(body);
		else if (encoding && encoding !== "identity")
			headers.set("content-encoding", encoding);
		const response = await upstream(target, {
			method: request.method,
			headers,
			body,
			redirect: "manual",
			signal: request.signal,
			duplex: "half",
		} as RequestInit);
		if (!response.ok)
			// What GitHub answered, so a failed fetch or push can be told apart.
			console.warn("Git proxy upstream refused.", {
				status: response.status,
				service: target.slice(target.lastIndexOf("/") + 1).split("?")[0],
				encoding: encoding ?? "none",
			});
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
