import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LegalAcceptanceDialog } from "./legal-acceptance-prompt";

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
