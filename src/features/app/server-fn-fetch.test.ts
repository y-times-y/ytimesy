import { expect, it } from "vitest";
import { HttpRequestError } from "../projects/api";
import { serverFnFetch } from "./server-fn-fetch";

const answer = (status: number, body: string, raw: boolean) => async () =>
	new Response(body, {
		status,
		headers: raw ? { "x-tss-raw": "true" } : { "content-type": "text/plain" },
	});

it("throws a server function's raw failure (a signed-out 401) instead of returning it as the result", async () => {
	const failure = await serverFnFetch(
		"/_serverFn/x",
		undefined,
		answer(401, "Sign in required", true),
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(HttpRequestError);
	expect((failure as HttpRequestError).status).toBe(401);
	expect((failure as Error).message).toBe("Sign in required");
});

it("passes successes and non-raw answers through untouched", async () => {
	const ok = await serverFnFetch("/x", undefined, answer(200, "fine", true));
	expect(ok.status).toBe(200);
	// Serialized errors are the framework's own to decode.
	const serialized = await serverFnFetch(
		"/x",
		undefined,
		answer(500, "{}", false),
	);
	expect(serialized.status).toBe(500);
});
