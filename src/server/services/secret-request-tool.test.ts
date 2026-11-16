import { expect, it } from "vitest";
import type { z } from "zod";
import {
	REQUEST_PROJECT_SECRET_TOOL,
	SECRET_REQUEST_LIMIT,
} from "#/domain/secret-request";
import { secretRequestTools } from "./secret-request-tool";

const run = (input: unknown, existing: string[] = []) =>
	secretRequestTools(existing)[REQUEST_PROJECT_SECRET_TOOL]?.execute?.(
		input as never,
		{ toolCallId: "call", messages: [] } as never,
	);

it("accepts one request for several missing secrets, without any value", async () => {
	await expect(
		run({
			secrets: [
				{ name: "STRIPE_KEY", kind: "runtime", reason: " Charge test cards " },
				{ name: "APP_URL", kind: "environment", reason: "Links" },
			],
		}),
	).resolves.toEqual({
		requested: true,
		secrets: [
			{ name: "STRIPE_KEY", kind: "runtime", reason: "Charge test cards" },
			{ name: "APP_URL", kind: "environment", reason: "Links" },
		],
	});
});

it("still accepts the older one-secret shape", async () => {
	await expect(
		run({ name: "STRIPE_KEY", kind: "runtime", reason: " Charge test cards " }),
	).resolves.toEqual({
		requested: true,
		secrets: [
			{ name: "STRIPE_KEY", kind: "runtime", reason: "Charge test cards" },
		],
	});
});

it("drops secrets the project already has and repeated names", async () => {
	await expect(
		run(
			{
				secrets: [
					{ name: "STRIPE_KEY", kind: "runtime", reason: "" },
					{ name: "APP_URL", kind: "environment", reason: "" },
					{ name: "APP_URL", kind: "runtime", reason: "again" },
				],
			},
			["STRIPE_KEY"],
		),
	).resolves.toEqual({
		requested: true,
		secrets: [{ name: "APP_URL", kind: "environment", reason: "" }],
		alreadySet: ["STRIPE_KEY"],
	});
});

it("refuses when every secret is already set, and invalid names", async () => {
	await expect(
		run({ name: "STRIPE_KEY", kind: "runtime", reason: "" }, ["STRIPE_KEY"]),
	).resolves.toMatchObject({ requested: false });
	await expect(
		run(
			{
				secrets: [
					{ name: "A", kind: "runtime", reason: "" },
					{ name: "B", kind: "runtime", reason: "" },
				],
			},
			["A", "B"],
		),
	).resolves.toMatchObject({
		requested: false,
		error: expect.stringMatching(/A, B are already set/),
	});
	await expect(
		run({ secrets: [{ name: "stripe key", kind: "runtime", reason: "" }] }),
	).rejects.toThrow("uppercase");
});

it("takes 1 to 64 secrets, each defaulting to runtime", () => {
	const schema = secretRequestTools([])[REQUEST_PROJECT_SECRET_TOOL]
		?.inputSchema as z.ZodType;
	const secrets = (count: number) =>
		Array.from({ length: count }, (_, index) => ({
			name: `KEY_${index}`,
			reason: "",
		}));
	expect(schema.safeParse({ secrets: secrets(1) })).toMatchObject({
		success: true,
		data: { secrets: [{ name: "KEY_0", kind: "runtime", reason: "" }] },
	});
	expect(
		schema.safeParse({ secrets: secrets(SECRET_REQUEST_LIMIT) }).success,
	).toBe(true);
	expect(
		schema.safeParse({ secrets: secrets(SECRET_REQUEST_LIMIT + 1) }).success,
	).toBe(false);
	expect(schema.safeParse({ secrets: [] }).success).toBe(false);
});

it("does not promise the agent never sees the value", () => {
	const description =
		secretRequestTools([])[REQUEST_PROJECT_SECRET_TOOL]?.description ?? "";
	expect(description).not.toMatch(/never see/i);
	expect(description).toContain("best-effort");
	expect(description).toMatch(/ask only when you cannot proceed/);
});

it("refuses a name the project has unless the agent asks to replace it", async () => {
	await expect(
		run(
			{
				secrets: [
					{ name: "CLOUDFLARE_DEPLOY_TOKEN", kind: "runtime", reason: "x" },
				],
			},
			["CLOUDFLARE_DEPLOY_TOKEN"],
		),
	).resolves.toMatchObject({
		requested: false,
		error: expect.stringContaining("replace: true"),
	});
});

it("asks for a new value of a secret the project has when told to replace it", async () => {
	await expect(
		run(
			{
				secrets: [
					{
						name: "CLOUDFLARE_DEPLOY_TOKEN",
						kind: "runtime",
						reason: " Rejected by Cloudflare ",
						replace: true,
					},
					{ name: "STRIPE_KEY", kind: "runtime", reason: "Charges" },
				],
			},
			["CLOUDFLARE_DEPLOY_TOKEN"],
		),
	).resolves.toEqual({
		requested: true,
		secrets: [
			{
				name: "CLOUDFLARE_DEPLOY_TOKEN",
				kind: "runtime",
				reason: "Rejected by Cloudflare",
				replace: true,
			},
			{ name: "STRIPE_KEY", kind: "runtime", reason: "Charges" },
		],
	});
});

it("ignores replace for a name the project does not have: it is a plain request", async () => {
	await expect(
		run({
			secrets: [
				{ name: "STRIPE_KEY", kind: "runtime", reason: "", replace: true },
			],
		}),
	).resolves.toEqual({
		requested: true,
		secrets: [{ name: "STRIPE_KEY", kind: "runtime", reason: "" }],
	});
});

it("accepts replace in the older one-secret shape", async () => {
	await expect(
		run({ name: "STRIPE_KEY", kind: "runtime", reason: "r", replace: true }, [
			"STRIPE_KEY",
		]),
	).resolves.toEqual({
		requested: true,
		secrets: [
			{ name: "STRIPE_KEY", kind: "runtime", reason: "r", replace: true },
		],
	});
});
