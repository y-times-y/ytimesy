import { z } from "zod";
import {
	EXPIRY_HEADER,
	signDeliveryRequest,
	verifyDeliveryRequest,
} from "./delivery-auth";

export const repositoryPart = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
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
const branchName = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[^\s\0~^:?*[\\]+$/);
/**
 * A grant plain `git` on a chat's VM asked for (machine-git-grant.ts). A
 * read may name no installation: a public repository, fetched anonymously.
 * A write may name no branch: the push rules (machinePushVerdicts) decide
 * per ref, and the nonce still makes it one push.
 */
const machineGrantSchema = z
	.object({
		kind: z.literal("machine"),
		userId: z.string().min(1).max(128),
		sessionId: z.uuid(),
		projectId: z.uuid(),
		owner: repositoryPart,
		name: repositoryPart,
		installationId: z.number().int().positive().optional(),
		access: z.enum(["read", "write"]),
		/** Absent: the chat's agent. A terminal's push to the default branch is approved from the chat. */
		holder: z.literal("terminal").optional(),
		branch: branchName.optional(),
		nonce: z
			.string()
			.regex(/^[a-f0-9]{32}$/)
			.optional(),
	})
	.strict()
	.refine((grant) =>
		grant.access === "write"
			? Boolean(grant.nonce && grant.installationId)
			: !grant.branch && !grant.nonce,
	);
export type MachineGitGrant = z.infer<typeof machineGrantSchema>;
type MachineGitGrantInput = Omit<MachineGitGrant, "nonce" | "kind">;
const grantUrl = "https://git-grant.internal/git-grant";
const grantHeader = "x-ytimesy-git-grant";
/** The user name of a grant sent as HTTP Basic credentials (plain git's credential helper). */
export const GIT_GRANT_USERNAME = "ytimesy-grant";
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
	const nonce = input.access === "write" ? randomNonce() : undefined;
	const body = JSON.stringify(grantSchema.parse({ ...input, nonce }));
	return {
		[grantHeader]: body,
		...(await signDeliveryRequest(secret, "POST", grantUrl, body)),
	};
}

function randomNonce() {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
}

/** Like issueGitProxyGrant, for plain git on a chat's VM. */
export async function issueMachineGitGrant(
	secret: string,
	input: MachineGitGrantInput,
) {
	const nonce = input.access === "write" ? randomNonce() : undefined;
	const body = JSON.stringify(
		machineGrantSchema.parse({ kind: "machine", ...input, nonce }),
	);
	return {
		[grantHeader]: body,
		...(await signDeliveryRequest(secret, "POST", grantUrl, body)),
	};
}

/**
 * A grant's headers as the password of HTTP Basic credentials, which is all
 * a git credential helper can hand git: base64url JSON, no newlines.
 */
export function gitGrantPassword(headers: Record<string, string>) {
	return btoa(JSON.stringify(headers))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/** The grant headers a request carries: as headers, or as Basic credentials' password. */
function grantHeaders(request: Request): Headers | null {
	if (request.headers.has(grantHeader)) return request.headers;
	const basic = /^Basic ([A-Za-z0-9+/=]{1,8192})$/.exec(
		request.headers.get("authorization") ?? "",
	);
	if (!basic) return null;
	try {
		const credentials = atob(basic[1]);
		const prefix = `${GIT_GRANT_USERNAME}:`;
		if (!credentials.startsWith(prefix)) return null;
		const encoded = credentials
			.slice(prefix.length)
			.replaceAll("-", "+")
			.replaceAll("_", "/");
		const fields: unknown = JSON.parse(atob(encoded));
		if (!fields || typeof fields !== "object" || Array.isArray(fields))
			return null;
		const headers = new Headers();
		for (const [name, value] of Object.entries(fields))
			if (typeof value === "string") headers.set(name, value);
		return headers;
	} catch {
		return null;
	}
}

/**
 * The repository path a grant may reach. Plain git's URLs come as the user
 * wrote them (github.com/owner/repo, with or without .git, any case); the
 * server's own transfers always use the exact `.git` form.
 */
function grantRoot(request: Request, grant: AnyGitGrant) {
	const url = new URL(request.url);
	const exact = `/git/${grant.owner}/${grant.name}.git/`;
	if (!("kind" in grant)) return url.pathname.startsWith(exact) ? exact : null;
	const match = /^\/git\/([^/]+)\/([^/]+?)(\.git)?\//.exec(url.pathname);
	if (
		!match ||
		match[1].toLowerCase() !== grant.owner.toLowerCase() ||
		match[2].toLowerCase() !== grant.name.toLowerCase()
	)
		return null;
	return match[0];
}

type AnyGitGrant = GitProxyGrant | MachineGitGrant;

function gitTarget(request: Request, grant: AnyGitGrant) {
	const url = new URL(request.url);
	const root = grantRoot(request, grant);
	if (!root) return null;
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

export type RefUpdate = { oldId: string; newId: string; ref: string };
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
	const capabilities: string[] = [];
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
				const [line, capabilityList] = ascii(
					buffer.subarray(offset + 4, offset + length),
				)
					.replace(/\n$/, "")
					.split("\0");
				// The first command carries the client's capabilities.
				if (capabilityList !== undefined && !capabilities.length)
					capabilities.push(...capabilityList.split(" ").filter(Boolean));
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
		capabilities,
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
	{ readonly expiresAt: number; readonly access: Promise<unknown> }
>();
const MAX_READ_AUTHORIZATIONS = 256;

function authorizeReadOnce<T>(
	signed: Headers,
	authorize: () => Promise<T | null>,
): Promise<T | null> {
	const signature = signed.get("x-ytimesy-delivery-signature") ?? "";
	const expiresAt = Number(signed.get(EXPIRY_HEADER));
	const now = Date.now();
	const known = readAuthorizations.get(signature);
	if (known && known.expiresAt > now) return known.access as Promise<T | null>;
	for (const [key, entry] of readAuthorizations)
		if (
			entry.expiresAt <= now ||
			readAuthorizations.size >= MAX_READ_AUTHORIZATIONS
		)
			readAuthorizations.delete(key);
	const access = authorize();
	readAuthorizations.set(signature, { expiresAt, access });
	// A refusal or failure is not remembered: the next request checks again.
	access.then(
		(value) => {
			if (!value) readAuthorizations.delete(signature);
		},
		() => readAuthorizations.delete(signature),
	);
	return access;
}

export function forgetGitReadAuthorizationsForTests() {
	readAuthorizations.clear();
}

/** What plain git on a VM may reach: GitHub's token (null: anonymous, a public repository) and the default branch. */
export type MachineGitAccess = { token: string | null; defaultBranch: string };

/** The edge's checks for grants plain git on a chat's VM asked for. */
export type MachineGitHooks = {
	/** Re-checks the chat, its owner and their GitHub access; null refuses. */
	authorize(grant: MachineGitGrant): Promise<MachineGitAccess | null>;
	/**
	 * Whether this push to the default branch may go ahead: the project
	 * allows it, or the user approved exactly this push (spent here). When
	 * not, the push is recorded for request_push_approval.
	 */
	defaultBranchPush(
		grant: MachineGitGrant,
		update: RefUpdate,
	): Promise<boolean>;
};

/** Most ref updates one workspace push may carry. */
const MAX_MACHINE_UPDATES = 32;

export const DEFAULT_BRANCH_PUSH_REFUSAL =
	"pushing to the default branch needs the user's approval";

/**
 * Why each ref update of a workspace push is refused, or "default" when it
 * updates the default branch (allowed only with approval), or null when it
 * may go ahead. Any other branch may be created, updated or force-pushed;
 * deleting one, tags and other refs are refused.
 */
export function machinePushVerdicts(
	updates: readonly RefUpdate[],
	rules: { grantBranch?: string; defaultBranch: string | null },
): (string | null)[] {
	return updates.map((update) => {
		if (/^0+$/.test(update.newId)) return "deleting branches is not allowed";
		if (!update.ref.startsWith("refs/heads/"))
			return "only branches can be pushed";
		const branch = update.ref.slice("refs/heads/".length);
		if (rules.grantBranch && branch !== rules.grantBranch)
			return `this push may update only ${rules.grantBranch}`;
		if (rules.defaultBranch !== null && branch === rules.defaultBranch)
			return "default";
		return null;
	});
}

const encoder = new TextEncoder();

function pktLine(payload: Uint8Array | string) {
	const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
	const line = new Uint8Array(bytes.length + 4);
	line.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")));
	line.set(bytes, 4);
	return line;
}

function concatBytes(parts: readonly Uint8Array[]) {
	const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		all.set(part, offset);
		offset += part.length;
	}
	return all;
}

/**
 * Git's own answer refusing a push: every ref "ng" with its reason, and the
 * explanation as "remote:" lines when the client reads side-band. Git shows
 * it like a protected-branch refusal, so the agent reads why and what to do.
 */
export function refusedPushReport(
	updates: readonly RefUpdate[],
	reasons: readonly (string | null)[],
	capabilities: readonly string[],
	explanation: readonly string[],
) {
	const report = concatBytes([
		pktLine("unpack ok\n"),
		...updates.map((update, index) =>
			pktLine(
				`ng ${update.ref} ${reasons[index] ?? "another ref in this push was refused"}\n`,
			),
		),
		encoder.encode("0000"),
	]);
	const longBand = capabilities.includes("side-band-64k");
	if (!longBand && !capabilities.includes("side-band")) return report;
	const chunk = longBand ? 65_515 : 995;
	const parts: Uint8Array[] = explanation.map((line) =>
		pktLine(concatBytes([Uint8Array.of(2), encoder.encode(`${line}\n`)])),
	);
	for (let offset = 0; offset < report.length; offset += chunk)
		parts.push(
			pktLine(
				concatBytes([
					Uint8Array.of(1),
					report.subarray(offset, offset + chunk),
				]),
			),
		);
	parts.push(encoder.encode("0000"));
	return concatBytes(parts);
}

/** Reads a refused push's pack to its end, so Git reads the refusal rather than a reset. */
async function drained(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	try {
		for (;;) if ((await reader.read()).done) return;
	} catch {
		// The client went away; nothing is left to answer.
	}
}

async function pushRefusal(
	body: ReadableStream<Uint8Array>,
	updates: readonly RefUpdate[],
	reasons: readonly (string | null)[],
	capabilities: readonly string[],
	explanation: readonly string[],
) {
	await drained(body);
	if (
		!capabilities.includes("report-status") &&
		!capabilities.includes("report-status-v2")
	)
		return new Response(null, { status: 403 });
	return new Response(
		refusedPushReport(updates, reasons, capabilities, explanation),
		{
			status: 200,
			headers: {
				"content-type": "application/x-git-receive-pack-result",
				"cache-control": "no-store",
			},
		},
	);
}

function defaultBranchExplanation(grant: MachineGitGrant, branch: string) {
	if (grant.holder === "terminal")
		return [
			`Pushing to ${branch} on ${grant.owner}/${grant.name} needs your approval.`,
			`Ask the agent in this chat to push it and approve the card, or turn on "Allow pushes to ${branch} without asking" in project settings.`,
		];
	return [
		`Pushing to ${branch} on ${grant.owner}/${grant.name} needs the user's approval.`,
		`Call request_push_approval with repo "${grant.owner}/${grant.name}", branch "${branch}" and a one-line summary, then push the same commit again once approved.`,
		"Or push to your own branch instead.",
	];
}

/** Parses and verifies a request's grant, from its headers or its Basic credentials. */
async function verifiedGrant(
	request: Request,
	secret: string,
): Promise<
	{ grant: AnyGitGrant; signed: Headers } | { refusal: "missing" | "invalid" }
> {
	const signed = grantHeaders(request);
	const body = signed?.get(grantHeader);
	if (!signed || !body) return { refusal: "missing" };
	if (body.length > 2048) return { refusal: "invalid" };
	let grant: AnyGitGrant;
	try {
		const value: unknown = JSON.parse(body);
		grant =
			value && typeof value === "object" && "kind" in value
				? machineGrantSchema.parse(value)
				: grantSchema.parse(value);
	} catch {
		return { refusal: "invalid" };
	}
	if (
		!(await verifyDeliveryRequest(
			secret,
			new Request(grantUrl, { method: "POST", headers: signed }),
			body,
		))
	)
		return { refusal: "invalid" };
	return { grant, signed };
}

/** Whether a request is part of a push, so plain git's credential helper asks for a write grant. */
function isPushRequest(request: Request) {
	const url = new URL(request.url);
	return (
		url.pathname.endsWith("/git-receive-pack") ||
		url.searchParams.get("service") === "git-receive-pack"
	);
}

type ReceivePackCommands = NonNullable<
	Awaited<ReturnType<typeof readReceivePackCommands>>
>;

/**
 * Fixed-origin Git smart HTTP only. Packs and responses are streamed. A
 * server push may update only the grant's branch, never delete it; a
 * workspace push (machine grant) follows machinePushVerdicts and is answered
 * in Git's own words when refused. Either consumes the grant.
 */
export async function proxyGithubGit(
	request: Request,
	secret: string,
	authorize: (grant: GitProxyGrant) => Promise<string | null>,
	upstream: typeof fetch = fetch,
	claimGrant: (
		nonce: string,
		expiresAt: number,
	) => Promise<boolean> = async () => false,
	machine?: MachineGitHooks,
) {
	const verified = await verifiedGrant(request, secret);
	if ("refusal" in verified)
		// Plain git sends credentials only after a challenge; the realm tells
		// its credential helper whether to ask for a read or a write grant.
		return new Response(null, {
			status: 401,
			headers:
				verified.refusal === "missing"
					? {
							"www-authenticate": `Basic realm="ytimesy git ${isPushRequest(request) ? "push" : "fetch"}"`,
						}
					: {},
		});
	const { grant, signed } = verified;
	const hooks = "kind" in grant ? machine : undefined;
	if ("kind" in grant && !hooks) return new Response(null, { status: 403 });
	const target = gitTarget(request, grant);
	if (!target) return new Response(null, { status: 403 });
	let body: ReadableStream<Uint8Array> | null =
		request.method === "POST" ? request.body : null;
	/** The ref updates of a push request that has any (not Git's empty probe). */
	let pushed: ReceivePackCommands | null = null;
	if (request.method === "POST" && target.endsWith("/git-receive-pack")) {
		if (!request.body || request.headers.has("content-encoding"))
			return new Response(null, { status: 403 });
		const commands = await readReceivePackCommands(request.body);
		if (!commands) return new Response(null, { status: 403 });
		if (!("kind" in grant)) {
			if (
				commands.updates.length > 1 ||
				commands.updates.some(
					(update) =>
						update.ref !== `refs/heads/${grant.branch}` ||
						/^0+$/.test(update.newId),
				)
			)
				return new Response(null, { status: 403 });
		} else {
			const reasons =
				commands.updates.length > MAX_MACHINE_UPDATES
					? commands.updates.map(() => "too many refs in one push")
					: machinePushVerdicts(commands.updates, {
							grantBranch: grant.branch,
							defaultBranch: null,
						});
			if (reasons.some(Boolean))
				return pushRefusal(
					commands.body,
					commands.updates,
					reasons,
					commands.capabilities,
					[...new Set(reasons.filter((reason) => reason !== null))],
				);
		}
		body = commands.body;
		// Git probes large pushes with an empty command list first; only the
		// request that updates a ref spends the grant.
		pushed = commands.updates.length ? commands : null;
	}
	try {
		let token: string | null;
		if (!("kind" in grant) || !hooks) {
			token = await (grant.access === "read"
				? authorizeReadOnce(signed, () => authorize(grant as GitProxyGrant))
				: authorize(grant as GitProxyGrant));
			if (!token) return new Response(null, { status: 403 });
		} else {
			const access = await (grant.access === "read"
				? authorizeReadOnce(signed, () => hooks.authorize(grant))
				: hooks.authorize(grant));
			if (!access) {
				await body?.cancel().catch(() => undefined);
				return new Response(null, { status: 403 });
			}
			token = access.token;
			if (pushed) {
				const reasons = machinePushVerdicts(pushed.updates, {
					grantBranch: grant.branch,
					defaultBranch: access.defaultBranch,
				});
				for (const [index, reason] of reasons.entries())
					if (
						reason === "default" &&
						(await hooks.defaultBranchPush(grant, pushed.updates[index]))
					)
						reasons[index] = null;
				if (reasons.some(Boolean))
					return pushRefusal(
						pushed.body,
						pushed.updates,
						reasons.map((reason) =>
							reason === "default" ? DEFAULT_BRANCH_PUSH_REFUSAL : reason,
						),
						pushed.capabilities,
						defaultBranchExplanation(grant, access.defaultBranch),
					);
			}
		}
		if (
			pushed &&
			!(await claimGrant(grant.nonce ?? "", Number(signed.get(EXPIRY_HEADER))))
		) {
			body?.cancel().catch(() => undefined);
			return new Response(null, { status: 403 });
		}
		const headers = new Headers({ "user-agent": "ytimesy-git-proxy" });
		if (token !== null)
			headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
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
