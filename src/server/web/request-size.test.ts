import { expect, it } from "vitest";
import { limitRequestBody, MAX_REQUEST_BODY_BYTES } from "./request-size";

it("admits the largest attachment message and refuses a larger declared body", () => {
	expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(28_000_000);
	expect(MAX_REQUEST_BODY_BYTES).toBeLessThan(33_000_000);
	const sized = (length: string) =>
		new Request("https://app.test/_serverFn/x", {
			method: "POST",
			headers: { "content-length": length },
			body: "x",
		});
	expect(limitRequestBody(sized("1"), 10)).toBeInstanceOf(Request);
	const refused = limitRequestBody(sized("11"), 10);
	expect(refused).toBeInstanceOf(Response);
	expect((refused as Response).status).toBe(413);
	expect((limitRequestBody(sized("1e9"), 10) as Response).status).toBe(413);
	const bodiless = new Request("https://app.test/");
	expect(limitRequestBody(bodiless, 10)).toBe(bodiless);
});

it("fails a streamed body without a declared length once it passes the limit", async () => {
	const stream = (size: number) =>
		new Request("https://app.test/_serverFn/x", {
			method: "POST",
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(size));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
	const small = limitRequestBody(stream(10), 10) as Request;
	expect((await small.arrayBuffer()).byteLength).toBe(10);
	const large = limitRequestBody(stream(11), 10) as Request;
	await expect(large.arrayBuffer()).rejects.toThrow();
});
