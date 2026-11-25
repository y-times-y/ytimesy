import { expect, it } from "vitest";
import { failureReason } from "./failure-reason";

it("names a thrown Response by status and body instead of [object Response]", async () => {
	expect(
		await failureReason(
			new Response("Repository access is unavailable.", { status: 403 }),
		),
	).toBe("403 Repository access is unavailable.");
});
it("uses an Error's message and bounds the length", async () => {
	expect(await failureReason(new Error("boom"))).toBe("boom");
	expect((await failureReason(new Error("x".repeat(900)))).length).toBe(300);
});
it("falls back to a string", async () => {
	expect(await failureReason("odd")).toBe("odd");
});
it("recognises a Response-shaped object from another realm", async () => {
	const foreign = {
		status: 403,
		clone: () => foreign,
		text: async () => "no access",
	};
	expect(await failureReason(foreign)).toBe("403 no access");
});
