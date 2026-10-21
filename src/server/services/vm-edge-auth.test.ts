import { beforeEach, expect, it, vi } from "vitest";
import type { PreviewGrantStore } from "../adapters/preview-grants";
import {
	authorizePreviewRequest,
	EDGE_AUTHORIZER_HEADER,
	edgeAuthorizerKey,
	edgeAuthorizerUrl,
	PREVIEW_COOKIE,
	previewLoginUrl,
} from "./vm-edge-auth";

/** In-memory stand-in for the preview_route_grant / preview_login_nonce tables. */
function memoryStore() {
	let sequence = 0;
	const grants = new Map<
		string,
		{ userId: string; sessionId: string; version: number }
	>();
	const nonces = new Map<
		string,
		{ ruleId: string; userId: string; expiresAt: Date }
	>();
	const store: PreviewGrantStore = {
		async grant(input) {
			const current = grants.get(input.ruleId);
			const version =
				current && current.userId === input.userId
					? current.version
					: ++sequence;
			grants.set(input.ruleId, { ...input, version });
			return version;
		},
		async recordNonce(input) {
			nonces.set(input.nonce, input);
		},
		async consumeNonce(input) {
			const nonce = nonces.get(input.nonce);
			nonces.delete(input.nonce);
			if (
				!nonce ||
				nonce.ruleId !== input.ruleId ||
				nonce.userId !== input.userId
			)
				return null;
			const grant = grants.get(input.ruleId);
			return grant && grant.userId === input.userId ? grant.version : null;
		},
		async version(ruleId, userId) {
			const grant = grants.get(ruleId);
			return grant && grant.userId === userId ? grant.version : null;
		},
		async revokeScope(input) {
			for (const grant of grants.values())
				if (
					grant.userId === input.userId &&
					grant.sessionId === input.sessionId
				)
					grant.version = ++sequence;
		},
	};
	return { store, grants };
}

let db: ReturnType<typeof memoryStore>;
beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", "r".repeat(40));
	db = memoryStore();
});

const now = 1_800_000_000_000;
const scope = { userId: "u1", projectId: "p1", sessionId: "s1" };
function edgeRequest(
	uri: string,
	options: { rule?: string; cookie?: string; key?: string } = {},
) {
	const headers = new Headers({
		[EDGE_AUTHORIZER_HEADER]: options.key ?? edgeAuthorizerKey(),
		"x-forwarded-uri": uri,
		"x-forwarded-host": "ytimesy-pv-x-3000.style.dev",
	});
	if (options.rule !== "")
		headers.set("x-freestyle-tls-rule-id", options.rule ?? "tls-1");
	if (options.cookie) headers.set("cookie", options.cookie);
	return new Request("https://app.example/api/vm-edge/authorize", { headers });
}
async function loginUri(rule = "tls-1", at = now) {
	const url = new URL(
		await previewLoginUrl(
			"https://ytimesy-pv-x-3000.style.dev",
			{ ...scope, ruleId: rule },
			db.store,
			at,
		),
	);
	return `${url.pathname}${url.search}`;
}
const authorize = (request: Request, at = now) =>
	authorizePreviewRequest(request, at, db.store);
async function signIn() {
	const login = await authorize(edgeRequest(await loginUri()));
	expect(login.status).toBe(303);
	return `other=1; ${(login.headers.get("set-cookie") ?? "").split(";")[0]}`;
}

it("signs a browser in from the app's link, then admits it to that route only", async () => {
	const login = await authorize(edgeRequest(await loginUri()));
	expect(login.status).toBe(303);
	expect(login.headers.get("location")).toBe("/");
	const setCookie = login.headers.get("set-cookie") ?? "";
	expect(setCookie).toMatch(
		new RegExp(
			`^${PREVIEW_COOKIE}=[^;]+; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$`,
		),
	);
	const cookie = `other=1; ${setCookie.split(";")[0]}`;
	expect(
		(await authorize(edgeRequest("/app.js", { cookie }), now + 1000)).status,
	).toBe(204);
	expect(
		(await authorize(edgeRequest("/", { cookie, rule: "tls-2" }))).status,
	).toBe(401);
	expect(
		(await authorize(edgeRequest("/", { cookie }), now + 9 * 3600_000)).status,
	).toBe(401);
	// Opening the preview again keeps the version: the first cookie still works.
	const second = await signIn();
	expect((await authorize(edgeRequest("/", { cookie }))).status).toBe(204);
	expect((await authorize(edgeRequest("/", { cookie: second }))).status).toBe(
		204,
	);
});

it("uses a sign-in link once", async () => {
	const uri = await loginUri();
	expect((await authorize(edgeRequest(uri))).status).toBe(303);
	expect((await authorize(edgeRequest(uri), now + 1000)).status).toBe(401);
});

it("refuses cookies once access is withdrawn or the chat is deleted", async () => {
	const cookie = await signIn();
	await db.store.revokeScope(scope);
	expect((await authorize(edgeRequest("/", { cookie }))).status).toBe(401);
	const fresh = await signIn();
	expect((await authorize(edgeRequest("/", { cookie: fresh }))).status).toBe(
		204,
	);
	db.grants.delete("tls-1"); // chat, project or account deleted: the row cascades away
	expect((await authorize(edgeRequest("/", { cookie: fresh }))).status).toBe(
		401,
	);
});

it("refuses expired, foreign-route or tampered sign-in links and anonymous visitors", async () => {
	expect(
		(await authorize(edgeRequest(await loginUri("tls-1", now - 121_000))))
			.status,
	).toBe(401);
	expect((await authorize(edgeRequest(await loginUri("tls-2")))).status).toBe(
		401,
	);
	expect((await authorize(edgeRequest(`${await loginUri()}x`))).status).toBe(
		401,
	);
	expect((await authorize(edgeRequest("/"))).status).toBe(401);
	expect(
		(
			await authorize(
				edgeRequest("/", { cookie: `${PREVIEW_COOKIE}=forged.sig` }),
			)
		).status,
	).toBe(401);
});

it("answers only Freestyle (static key) and only for a named rule", async () => {
	expect(
		(await authorize(edgeRequest(await loginUri(), { key: "nope" }))).status,
	).toBe(403);
	expect(
		(await authorize(edgeRequest(await loginUri(), { rule: "" }))).status,
	).toBe(403);
});

it("needs an HTTPS app origin and versions the authorizer URL by key", () => {
	expect(() => edgeAuthorizerUrl("http://127.0.0.1:3000")).toThrow(/HTTPS/);
	const url = edgeAuthorizerUrl("https://app.example");
	expect(url).toMatch(
		/^https:\/\/app\.example\/api\/vm-edge\/authorize\?v=[a-f0-9]{12}$/,
	);
	vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
	expect(edgeAuthorizerUrl("https://app.example")).not.toBe(url);
});
