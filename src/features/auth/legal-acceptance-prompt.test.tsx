import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	LegalUpdateCard,
	legalPromptPending,
	replayAllowedByLegal,
} from "./legal-acceptance-prompt";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

it("tells a signed-in user the documents changed, without blocking the app", () => {
	const html = renderToStaticMarkup(
		<LegalUpdateCard onDismiss={() => undefined} />,
	);
	expect(html).not.toContain('role="dialog"');
	expect(html).not.toContain("aria-modal");
	expect(html).not.toContain('role="checkbox"');
	expect(html).toContain('href="/terms"');
	expect(html).toContain('href="/privacy"');
	expect(text(html)).toContain("We updated our Terms and Privacy Policy.");
	expect(html).toContain('aria-label="Dismiss"');
});

describe("legalPromptPending", () => {
	const base = {
		sessionPending: false,
		userId: "u1",
		statusPending: false,
		current: true,
	};
	it("holds other prompts while the Terms notice shows or may show", () => {
		expect(legalPromptPending({ ...base, current: false })).toBe(true);
		expect(legalPromptPending({ ...base, statusPending: true })).toBe(true);
		expect(legalPromptPending({ ...base, sessionPending: true })).toBe(true);
	});
	it("releases them once Terms are accepted, or for signed-out visitors", () => {
		expect(legalPromptPending(base)).toBe(false);
		expect(legalPromptPending({ ...base, userId: undefined })).toBe(false);
	});
});

it("allows session replay only after the current policy is accepted", () => {
	expect(replayAllowedByLegal({ statusError: false, current: true })).toBe(
		true,
	);
	// The update notice is open: no recording until it is accepted.
	expect(replayAllowedByLegal({ statusError: false, current: false })).toBe(
		false,
	);
	// Still loading, or unreadable: fail closed.
	expect(replayAllowedByLegal({ statusError: false, current: undefined })).toBe(
		false,
	);
	expect(replayAllowedByLegal({ statusError: true, current: true })).toBe(
		false,
	);
});
