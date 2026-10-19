import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children: unknown }) => (
		<a href={to}>{children as string}</a>
	),
}));

import { TermsConsent, TermsNotice } from "./terms-consent";

it("asks for required consent to the Terms and Privacy Policy at sign-up", () => {
	const html = renderToStaticMarkup(
		<TermsConsent checked={false} onCheckedChange={() => undefined} />,
	);
	expect(html).toContain('role="checkbox"');
	expect(html).toContain('aria-required="true"');
	expect(html).toContain('aria-checked="false"');
	expect(html).toContain('href="/terms"');
	expect(html).toContain('href="/privacy"');
	expect(html.replace(/<[^>]+>/g, "")).toContain(
		"I agree to the Terms and Privacy Policy.",
	);
});

it("tells sign-in users which terms apply", () => {
	const html = renderToStaticMarkup(<TermsNotice />);
	expect(html).toContain('href="/terms"');
	expect(html).toContain('href="/privacy"');
});
