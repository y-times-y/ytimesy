import { Effect } from "effect";
import { expect, it } from "vitest";
import { publicFailureMessage } from "../src/domain/project-workspace";
import { readableServerError } from "../src/server/public-error";

const notConnected = () =>
	new Response("Connect GitHub to choose repositories.", { status: 409 });

it("turns a thrown Response into an Error with its body text", async () => {
	const error = await readableServerError(notConnected());
	expect(error).toBeInstanceOf(Error);
	expect(publicFailureMessage(error)).toBe(
		"Connect GitHub to choose repositories.",
	);
});

it("unwraps a Response that failed inside an Effect (which reads as {})", async () => {
	const cause = await Effect.runPromise(
		Effect.promise(() => Promise.reject(notConnected())),
	).catch((error: unknown) => error);
	expect((cause as Error).message).toBe("{}");
	expect(publicFailureMessage(await readableServerError(cause))).toBe(
		"Connect GitHub to choose repositories.",
	);
});

it("keeps other errors as they were", async () => {
	const error = new Error("Task text is required");
	expect(await readableServerError(error)).toBe(error);
	expect(
		publicFailureMessage(
			await readableServerError(new Response("", { status: 409 })),
		),
	).toBe("Something went wrong. Retry in a moment.");
});
