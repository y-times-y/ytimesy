import { describe, expect, it, vi } from "vitest";
import {
	DESCRIBE_SECRET_TOOL,
	describeSecretTools,
} from "./describe-secret-tool";

const run = (
	tools: ReturnType<typeof describeSecretTools>,
	input: { name: string; description: string },
) =>
	(
		tools[DESCRIBE_SECRET_TOOL] as {
			execute: (
				input: unknown,
				options: unknown,
			) => Promise<{ saved: boolean; error?: string }>;
		}
	).execute(input, { toolCallId: "c", messages: [] });

describe("describe_secret", () => {
	const make = (saved: "project" | "account" | null = "project") => {
		const save = vi.fn(async () => saved);
		return {
			save,
			tools: describeSecretTools({
				values: () => ["sk_live_51HxQz9AbCdEf"],
				save,
			}),
		};
	};

	it("saves a plain description on the named secret", async () => {
		const f = make();
		const result = await run(f.tools, {
			name: "STRIPE_KEY",
			description:
				"Stripe live account acct_1ABC; can read balances, not payouts. Tested with GET /v1/account.",
		});
		expect(result.saved).toBe(true);
		expect(f.save).toHaveBeenCalledWith({
			name: "STRIPE_KEY",
			description: expect.stringContaining("Stripe live account"),
		});
	});

	it("refuses a description that holds a secret value or something shaped like one", async () => {
		const f = make();
		for (const description of [
			"The key is sk_live_51HxQz9AbCdEf.",
			"Token sk-abcdefghijklmnopqrstuvwxyz works.",
			"api_key=abcd1234efgh5678",
		]) {
			const result = await run(f.tools, { name: "STRIPE_KEY", description });
			expect(result.saved).toBe(false);
			expect(result.error).toContain("looks like a secret value");
		}
		expect(f.save).not.toHaveBeenCalled();
	});

	it("says so when the project has no such secret", async () => {
		const f = make(null);
		const result = await run(f.tools, {
			name: "NOPE",
			description: "Something.",
		});
		expect(result).toEqual({
			saved: false,
			error: "This project has no secret named NOPE.",
		});
	});
});
