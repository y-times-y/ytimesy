import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SecretRequestItem } from "#/domain/session-item";
import { SecretRequestCard } from "./secret-request-card";

const item: SecretRequestItem = {
	kind: "secretRequest",
	id: SessionItemId("request"),
	name: "STRIPE_KEY",
	secretKind: "runtime",
	reason: "Charge test cards in the checkout flow.",
};
const actions = {
	disabled: false,
	onSave: async () => {},
	onDecline: () => {},
};

it("offers a password field while the request waits", () => {
	const html = renderToStaticMarkup(
		<SecretRequestCard item={item} outcome="pending" actions={actions} />,
	);
	expect(html).toContain("STRIPE_KEY");
	expect(html).toContain("Charge test cards in the checkout flow.");
	expect(html).toContain('type="password"');
	expect(html).toContain('autoComplete="off"');
	expect(html).toContain("Save and continue");
});

it("shows only the outcome once answered", () => {
	const html = renderToStaticMarkup(
		<SecretRequestCard item={item} outcome="provided" actions={actions} />,
	);
	expect(html).toContain("Saved to project");
	expect(html).not.toContain("<input");
});
