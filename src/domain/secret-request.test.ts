import { expect, it } from "vitest";
import { applyApiProgress } from "./api-progress";
import { SessionItemId } from "./ids";
import {
	REQUEST_PROJECT_SECRET_TOOL,
	secretDeclinedText,
	secretProvidedText,
	secretRequestOutcome,
} from "./secret-request";
import type { SessionItem } from "./session-item";
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

it("shows an accepted request as a secret card, with no value anywhere", () => {
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
			name: "STRIPE_KEY",
			secretKind: "runtime",
			reason: "Charge test cards",
		},
	]);
});

it("keeps a refused or failed request as an ordinary tool call", () => {
	for (const items of [
		requested({ requested: false, error: "STRIPE_KEY is already set" }),
		requested({ requested: true, name: "STRIPE_KEY", kind: "build" }),
		requested(null, true),
	])
		expect(items[0]?.kind).toBe("dynamicToolCall");
});

it("reads the request's outcome from the user's next reply", () => {
	const request: SessionItem = {
		kind: "secretRequest",
		id: SessionItemId("request"),
		name: "STRIPE_KEY",
		secretKind: "runtime",
		reason: "",
	};
	const reply = (text: string): SessionItem => ({
		kind: "userMessage",
		id: SessionItemId("reply"),
		text,
	});
	expect(secretRequestOutcome([request], request.id)).toBe("pending");
	expect(
		secretRequestOutcome(
			[request, reply(secretProvidedText("STRIPE_KEY"))],
			request.id,
		),
	).toBe("provided");
	for (const text of [secretDeclinedText("STRIPE_KEY"), "use test mode"])
		expect(secretRequestOutcome([request, reply(text)], request.id)).toBe(
			"answered",
		);
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
