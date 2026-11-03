import { expect, it } from "vitest";
import { applyApiProgress } from "./api-progress";
import { SessionItemId } from "./ids";
import {
	REQUEST_PROJECT_SECRET_TOOL,
	requestedSecrets,
	secretRequestOutcome,
	secretsAnsweredText,
	secretsSkippedText,
} from "./secret-request";
import type { SecretRequestItem, SessionItem } from "./session-item";
import { groupTimelineRows } from "./timeline-activity";

function requested(output: unknown, failed?: boolean) {
	const called = applyApiProgress([], "turn", {
		type: "tool-call",
		id: "call",
		name: REQUEST_PROJECT_SECRET_TOOL,
		input: { name: "STRIPE_KEY", reason: "Charge test cards" },
	});
	return applyApiProgress(called, "turn", {
		type: "tool-result",
		id: "call",
		name: REQUEST_PROJECT_SECRET_TOOL,
		output,
		...(failed ? { failed } : {}),
	});
}

it("shows an accepted request as one card listing every secret, with no value anywhere", () => {
	const items = requested({
		requested: true,
		secrets: [
			{ name: "STRIPE_KEY", kind: "runtime", reason: "Charge test cards" },
			{ name: "APP_URL", kind: "environment", reason: "Links in emails" },
		],
		alreadySet: ["DATABASE_URL"],
	});
	expect(items).toEqual([
		{
			kind: "secretRequest",
			id: expect.any(String),
			secrets: [
				{
					name: "STRIPE_KEY",
					secretKind: "runtime",
					reason: "Charge test cards",
				},
				{
					name: "APP_URL",
					secretKind: "environment",
					reason: "Links in emails",
				},
			],
		},
	]);
});

it("shows an older one-secret result as a card too", () => {
	const items = requested({
		requested: true,
		name: "STRIPE_KEY",
		kind: "runtime",
		reason: "Charge test cards",
	});
	expect(items).toEqual([
		{
			kind: "secretRequest",
			id: expect.any(String),
			secrets: [
				{
					name: "STRIPE_KEY",
					secretKind: "runtime",
					reason: "Charge test cards",
				},
			],
		},
	]);
});

it("keeps a refused or failed request as an ordinary tool call", () => {
	for (const items of [
		requested({ requested: false, error: "STRIPE_KEY is already set" }),
		requested({ requested: true, name: "STRIPE_KEY", kind: "build" }),
		requested({
			requested: true,
			secrets: [
				{ name: "A", kind: "runtime" },
				{ name: "B", kind: "build" },
			],
		}),
		requested({ requested: true, secrets: [] }),
		requested(null, true),
	])
		expect(items[0]?.kind).toBe("dynamicToolCall");
});

it("reads both stored shapes", () => {
	const legacy: SecretRequestItem = {
		kind: "secretRequest",
		id: SessionItemId("request"),
		name: "STRIPE_KEY",
		secretKind: "runtime",
		reason: "Charge",
	};
	expect(requestedSecrets(legacy)).toEqual([
		{ name: "STRIPE_KEY", secretKind: "runtime", reason: "Charge" },
	]);
});

it("names what was saved and what was skipped in the reply", () => {
	expect(secretsAnsweredText(["A", "B"], ["C", "D"])).toBe(
		"I saved A, B to the project's secrets and skipped C, D for now. Continue.",
	);
	expect(secretsAnsweredText(["A"])).toBe(
		"I saved A to the project's secrets. Continue.",
	);
	expect(secretsAnsweredText([], ["C", "D"])).toBe(
		"Skip these for now: C, D. Continue without them.",
	);
	expect(secretsSkippedText(["C"])).toBe(
		"Skip C for now. Continue without it.",
	);
});

const reply = (text: string): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId("reply"),
	text,
});

it("reads an older one-secret request's outcome from the user's next reply", () => {
	const request: SessionItem = {
		kind: "secretRequest",
		id: SessionItemId("request"),
		name: "STRIPE_KEY",
		secretKind: "runtime",
		reason: "",
	};
	expect(secretRequestOutcome([request], request.id)).toBe("pending");
	expect(
		secretRequestOutcome(
			[
				request,
				reply("I saved STRIPE_KEY to the project's secrets. Continue."),
			],
			request.id,
		),
	).toBe("provided");
	for (const text of [
		"I won't add STRIPE_KEY. Continue without it.",
		secretsSkippedText(["STRIPE_KEY"]),
		"use test mode",
	])
		expect(secretRequestOutcome([request, reply(text)], request.id)).toBe(
			"answered",
		);
});

it("reads a list request's outcome: provided once any was saved", () => {
	const request: SessionItem = {
		kind: "secretRequest",
		id: SessionItemId("request"),
		secrets: ["A", "B", "C"].map((name) => ({
			name,
			secretKind: "runtime" as const,
			reason: "",
		})),
	};
	const outcome = (text: string) =>
		secretRequestOutcome([request, reply(text)], request.id);
	expect(secretRequestOutcome([request], request.id)).toBe("pending");
	expect(outcome(secretsAnsweredText(["B"], ["A", "C"]))).toBe("provided");
	expect(outcome(secretsAnsweredText(["A", "B", "C"]))).toBe("provided");
	expect(outcome(secretsAnsweredText([], ["A", "B", "C"]))).toBe("answered");
	// A reply naming other secrets answers some other request.
	expect(outcome(secretsAnsweredText(["A"]))).toBe("answered");
	expect(outcome("use test mode")).toBe("answered");
});

it("keeps a secret request in view after the turn's activity", () => {
	const rows = groupTimelineRows(
		[
			{
				kind: "userMessage",
				id: SessionItemId("user"),
				text: "Set up billing",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read"),
				tool: "read_file",
				status: "completed",
			},
			{
				kind: "secretRequest",
				id: SessionItemId("request"),
				name: "STRIPE_KEY",
				secretKind: "runtime",
				reason: "",
			},
		] as SessionItem[],
		"idle",
	);
	expect(
		rows.map((row) => (row.kind === "item" ? row.item.kind : row.kind)),
	).toEqual(["userMessage", "work", "secretRequest"]);
});
