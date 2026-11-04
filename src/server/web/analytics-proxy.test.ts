import { expect, it } from "vitest";
import { analyticsProxyTarget, proxyAnalytics } from "./analytics-proxy";

it("maps /r/* to PostHog ingest, and SDK assets to its asset host", () => {
	const target = (path: string) =>
		analyticsProxyTarget(new URL(`https://ytimesy.com${path}`))?.href ?? null;
	expect(target("/r/e/?compression=gzip-js&ver=1")).toBe(
		"https://us.i.posthog.com/e/?compression=gzip-js&ver=1",
	);
	expect(target("/r/s/")).toBe("https://us.i.posthog.com/s/");
	expect(target("/r/static/1.435.6/exception-autocapture.js")).toBe(
		"https://us-assets.i.posthog.com/static/1.435.6/exception-autocapture.js",
	);
	expect(target("/r/array/phc_x/config.js")).toBe(
		"https://us-assets.i.posthog.com/array/phc_x/config.js",
	);
	expect(target("/r")).toBeNull();
	expect(target("/rules")).toBeNull();
	expect(target("/")).toBeNull();
});

it("forwards the body and safe headers only, drops cookies, and serves the decoded body", async () => {
	let sent: { url: string; init: RequestInit } | undefined;
	const send = (async (url: URL, init: RequestInit) => {
		sent = { url: url.href, init };
		return new Response("ok", {
			status: 200,
			headers: {
				"set-cookie": "a=b",
				"content-type": "text/plain",
				"content-encoding": "gzip",
			},
		});
	}) as unknown as typeof fetch;
	const response = await proxyAnalytics(
		new Request("https://ytimesy.com/r/e/?ver=1", {
			method: "POST",
			headers: {
				cookie: "better-auth.session_token=secret",
				authorization: "Bearer secret",
				"content-type": "text/plain",
				"user-agent": "Browser",
			},
			body: "payload",
		}),
		send,
	);
	expect(response?.status).toBe(200);
	expect(response?.headers.get("set-cookie")).toBeNull();
	// The body arrives already decoded, so it must not claim gzip.
	expect(response?.headers.get("content-encoding")).toBeNull();
	expect(await response?.text()).toBe("ok");
	expect(sent?.url).toBe("https://us.i.posthog.com/e/?ver=1");
	const headers = new Headers(sent?.init.headers);
	expect(headers.get("cookie")).toBeNull();
	expect(headers.get("authorization")).toBeNull();
	expect(headers.get("user-agent")).toBe("Browser");
	expect(await new Response(sent?.init.body).text()).toBe("payload");
});

it("ignores other paths and refuses other methods", async () => {
	const send = (async () => new Response("no")) as unknown as typeof fetch;
	expect(await proxyAnalytics(new Request("https://ytimesy.com/"), send)).toBe(
		null,
	);
	const put = await proxyAnalytics(
		new Request("https://ytimesy.com/r/e/", { method: "PUT", body: "x" }),
		send,
	);
	expect(put?.status).toBe(405);
});
