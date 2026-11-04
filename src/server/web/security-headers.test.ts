import { expect, it } from "vitest";
import { BUILD_ID, BUILD_ID_HEADER } from "../../lib/build-id";
import { SECURITY_HEADERS, withSecurityHeaders } from "./security-headers";

it("adds the baseline headers and keeps the body and status", async () => {
	const response = withSecurityHeaders(
		new Response("hello", { status: 201, headers: { "x-app": "1" } }),
	);
	expect(response.status).toBe(201);
	expect(await response.text()).toBe("hello");
	expect(response.headers.get("x-app")).toBe("1");
	for (const [name, value] of Object.entries(SECURITY_HEADERS))
		expect(response.headers.get(name)).toBe(value);
});

it("keeps a route's own policy", () => {
	const response = withSecurityHeaders(
		new Response(null, { headers: { "Referrer-Policy": "no-referrer" } }),
	);
	expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
});

it("names the build that answered", () => {
	expect(
		withSecurityHeaders(new Response(null)).headers.get(BUILD_ID_HEADER),
	).toBe(BUILD_ID);
});
