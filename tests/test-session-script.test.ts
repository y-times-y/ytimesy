import { describe, expect, it } from "vitest";
import { parseCli, requestTestSession } from "../scripts/test-session";

describe("test-session script", () => {
	it("has no way to name a user", () => {
		for (const flag of ["--user", "--email", "--user-id"])
			expect(() => parseCli(["mint", flag, "someone"])).toThrow();
	});
	it("needs the capability token and sends only an action and a caller", async () => {
		await expect(
			requestTestSession({
				base: "https://x.test",
				token: undefined,
				caller: "c",
				action: "mint",
			}),
		).rejects.toThrow("YTIMESY_TEST_SESSION_TOKEN");
		let body = "";
		await requestTestSession({
			base: "https://x.test",
			token: "t",
			caller: "thread-1",
			action: "mint",
			fetcher: (async (_u: unknown, init?: RequestInit) => {
				body = String(init?.body);
				return Response.json({ cookie: { name: "n", value: "v" } });
			}) as typeof fetch,
		});
		expect(JSON.parse(body)).toEqual({ action: "mint", caller: "thread-1" });
	});
});
