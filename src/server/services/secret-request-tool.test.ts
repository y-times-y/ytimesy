import { expect, it } from "vitest";
import { REQUEST_PROJECT_SECRET_TOOL } from "#/domain/secret-request";
import { secretRequestTools } from "./secret-request-tool";

const run = (input: unknown, existing: string[] = []) =>
	secretRequestTools(existing)[REQUEST_PROJECT_SECRET_TOOL]?.execute?.(
		input as never,
		{ toolCallId: "call", messages: [] } as never,
	);

it("accepts a request for a missing secret, without any value", async () => {
	await expect(
		run({ name: "STRIPE_KEY", kind: "runtime", reason: " Charge test cards " }),
	).resolves.toEqual({
		requested: true,
		name: "STRIPE_KEY",
		kind: "runtime",
		reason: "Charge test cards",
	});
});

it("refuses a secret the project already has, and invalid names", async () => {
	await expect(
		run({ name: "STRIPE_KEY", kind: "runtime", reason: "" }, ["STRIPE_KEY"]),
	).resolves.toMatchObject({ requested: false });
	await expect(
		run({ name: "stripe key", kind: "runtime", reason: "" }),
	).rejects.toThrow("uppercase");
});
