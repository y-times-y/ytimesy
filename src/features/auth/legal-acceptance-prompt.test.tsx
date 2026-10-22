import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	LegalAcceptanceDialog,
	legalPromptPending,
} from "./legal-acceptance-prompt";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

it("asks a user with no recorded acceptance to accept before continuing", () => {
	const html = renderToStaticMarkup(
		<LegalAcceptanceDialog
			updated={false}
			onAccept={() => undefined}
			onSignOut={() => undefined}
		/>,
	);
	expect(html).toContain('role="dialog"');
	expect(html).toContain('href="/terms"');
	expect(html).toContain('href="/privacy"');
	expect(text(html)).toContain("Review our Terms and Privacy Policy");
	// Accept stays disabled until the box is ticked.
	expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Accept and continue/);
});

it("tells returning users the documents changed", () => {
	const html = renderToStaticMarkup(
		<LegalAcceptanceDialog
			updated
			onAccept={() => undefined}
			onSignOut={() => undefined}
		/>,
	);
	expect(text(html)).toContain("We updated our Terms and Privacy Policy");
});

describe("legalPromptPending", () => {
	const base = {
		sessionPending: false,
		userId: "u1",
		statusPending: false,
		current: true,
	};
	it("holds other prompts while the Terms prompt shows or may show", () => {
		expect(legalPromptPending({ ...base, current: false })).toBe(true);
		expect(legalPromptPending({ ...base, statusPending: true })).toBe(true);
		expect(legalPromptPending({ ...base, sessionPending: true })).toBe(true);
	});
	it("releases them once Terms are accepted, or for signed-out visitors", () => {
		expect(legalPromptPending(base)).toBe(false);
		expect(legalPromptPending({ ...base, userId: undefined })).toBe(false);
	});
});
