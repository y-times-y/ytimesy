import { beforeEach, expect, it, vi } from "vitest";
import {
	authorizePreviewRequest,
	EDGE_AUTHORIZER_HEADER,
	edgeAuthorizerKey,
	edgeAuthorizerUrl,
	PREVIEW_COOKIE,
	previewLoginUrl,
} from "./vm-edge-auth";

beforeEach(() => vi.stubEnv("BETTER_AUTH_SECRET", "r".repeat(40)));

const now = 1_800_000_000_000;
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
function loginUri(rule = "tls-1", at = now) {
	const url = new URL(
		previewLoginUrl("https://ytimesy-pv-x-3000.style.dev", rule, at),
	);
	return `${url.pathname}${url.search}`;
}

it("signs a browser in from the app's link, then admits it to that route only", () => {
	const login = authorizePreviewRequest(edgeRequest(loginUri()), now);
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
		authorizePreviewRequest(edgeRequest("/app.js", { cookie }), now + 1000)
			.status,
	).toBe(204);
	expect(
		authorizePreviewRequest(edgeRequest("/", { cookie, rule: "tls-2" }), now)
			.status,
	).toBe(401);
	expect(
		authorizePreviewRequest(edgeRequest("/", { cookie }), now + 9 * 3600_000)
			.status,
	).toBe(401);
});

it("refuses expired, foreign-route or tampered sign-in links and anonymous visitors", () => {
	expect(
		authorizePreviewRequest(edgeRequest(loginUri("tls-1", now - 121_000)), now)
			.status,
	).toBe(401);
	expect(
		authorizePreviewRequest(edgeRequest(loginUri("tls-2")), now).status,
	).toBe(401);
	expect(
		authorizePreviewRequest(edgeRequest(`${loginUri()}x`), now).status,
	).toBe(401);
	expect(authorizePreviewRequest(edgeRequest("/"), now).status).toBe(401);
	expect(
		authorizePreviewRequest(
			edgeRequest("/", { cookie: `${PREVIEW_COOKIE}=forged.sig` }),
			now,
		).status,
	).toBe(401);
});

it("answers only Freestyle (static key) and only for a named rule", () => {
	expect(
		authorizePreviewRequest(edgeRequest(loginUri(), { key: "nope" }), now)
			.status,
	).toBe(403);
	expect(
		authorizePreviewRequest(edgeRequest(loginUri(), { rule: "" }), now).status,
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
