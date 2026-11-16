import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SecretRequestItem } from "#/domain/session-item";
import { SecretRequestCard } from "./secret-request-card";

const item: SecretRequestItem = {
	kind: "secretRequest",
	id: SessionItemId("request"),
	secrets: [
		{
			name: "STRIPE_KEY",
			secretKind: "runtime",
			reason: "Charge test cards in the checkout flow.",
		},
		{ name: "APP_URL", secretKind: "environment", reason: "Links in emails." },
	],
};
const legacy: SecretRequestItem = {
	kind: "secretRequest",
	id: SessionItemId("legacy"),
	name: "STRIPE_KEY",
	secretKind: "runtime",
	reason: "Charge test cards in the checkout flow.",
};
const actions = {
	disabled: false,
	onSave: async () => {},
	onAnswer: () => {},
};

it("offers a password field per secret while the request waits", () => {
	const html = renderToStaticMarkup(
		<SecretRequestCard item={item} outcome="pending" actions={actions} />,
	);
	expect(html).toContain("The agent needs 2 values");
	expect(html).toContain("STRIPE_KEY");
	expect(html).toContain("APP_URL");
	expect(html).toContain("Charge test cards in the checkout flow.");
	expect(html.match(/type="password"/g)).toHaveLength(2);
	expect(html).toContain('autoComplete="off"');
	expect(html).toContain("Skip for now");
	expect(html).toContain(">Save<");
});

it("still renders an older one-secret request", () => {
	const html = renderToStaticMarkup(
		<SecretRequestCard item={legacy} outcome="pending" actions={actions} />,
	);
	expect(html).toContain("The agent needs <code>STRIPE_KEY</code>");
	expect(html.match(/type="password"/g)).toHaveLength(1);
});

it("shows only the outcome once answered", () => {
	for (const request of [item, legacy]) {
		const html = renderToStaticMarkup(
			<SecretRequestCard item={request} outcome="provided" actions={actions} />,
		);
		expect(html).toContain("Saved to project");
		expect(html).not.toContain("<input");
	}
});

it("asks for a new value of a secret the project has, and says it replaces it", () => {
	const replacing: SecretRequestItem = {
		kind: "secretRequest",
		id: SessionItemId("replace"),
		secrets: [
			{
				name: "CLOUDFLARE_DEPLOY_TOKEN",
				secretKind: "runtime",
				reason: "Cloudflare rejects the current token.",
				replace: true,
			},
		],
	};
	const html = renderToStaticMarkup(
		<SecretRequestCard item={replacing} outcome="pending" actions={actions} />,
	);
	expect(html).toContain("a new value for ");
	expect(html).toContain("CLOUDFLARE_DEPLOY_TOKEN");
	expect(html).toContain("Replaces the current value");
	expect(html).toContain('aria-label="New value for CLOUDFLARE_DEPLOY_TOKEN"');
	expect(html).toContain(">Replace<");
	expect(html).toContain("replacing what is set now");
});

it("keeps Save when only some of the secrets replace one", () => {
	const mixed: SecretRequestItem = {
		kind: "secretRequest",
		id: SessionItemId("mixed"),
		secrets: [
			{ name: "OLD_KEY", secretKind: "runtime", reason: "", replace: true },
			{ name: "NEW_KEY", secretKind: "runtime", reason: "" },
		],
	};
	const html = renderToStaticMarkup(
		<SecretRequestCard item={mixed} outcome="pending" actions={actions} />,
	);
	expect(html).toContain(">Save<");
	expect(html.match(/Replaces the current value/g)).toHaveLength(1);
});
