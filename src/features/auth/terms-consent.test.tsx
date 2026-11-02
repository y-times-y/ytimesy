import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children: unknown }) => (
		<a href={to}>{children as string}</a>
	),
}));

import { TermsNotice } from "./terms-consent";

it("states that continuing accepts the Terms and Privacy Policy, with links and no checkbox", () => {
	const html = renderToStaticMarkup(<TermsNotice />);
	expect(html).toContain('href="/terms"');
	expect(html).toContain('href="/privacy"');
	expect(html).not.toContain('role="checkbox"');
	expect(html.replace(/<[^>]+>/g, "")).toBe(
		"By continuing, you agree to our Terms and Privacy Policy.",
	);
});
