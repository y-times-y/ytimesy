import { describe, expect, it } from "vitest";
import { serverFnOriginRejection } from "./server-fn-origin";

const app = "https://app.example.com";
const call = (
	method: string,
	headers: Record<string, string>,
	path = "/_serverFn/abc",
) =>
	serverFnOriginRejection(
		new Request(`${app}${path}`, { method, headers }),
		app,
	);

describe("server function origin check", () => {
	it("allows same-origin posts", () => {
		expect(call("POST", { origin: app })).toBeNull();
		expect(call("POST", { "sec-fetch-site": "same-origin" })).toBeNull();
	});
	it("rejects cross-origin or unlabelled posts", () => {
		expect(call("POST", { origin: "https://evil.example" })?.status).toBe(403);
		expect(call("POST", { origin: "null" })?.status).toBe(403);
		expect(call("POST", {})?.status).toBe(403);
		expect(call("POST", { "sec-fetch-site": "cross-site" })?.status).toBe(403);
	});
	it("ignores safe methods and other paths", () => {
		expect(call("GET", { origin: "https://evil.example" })).toBeNull();
		expect(call("POST", {}, "/api/auth/sign-in")).toBeNull();
	});
});
