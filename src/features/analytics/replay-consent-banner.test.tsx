import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ReplayConsentPrompt } from "./replay-consent-banner";

it("offers Accept and Decline with equal weight and links the policy", () => {
	const html = renderToStaticMarkup(
		<ReplayConsentPrompt onChoose={() => undefined} />,
	);
	expect(html).toContain(">Decline</button>");
	expect(html).toContain(">Accept</button>");
	expect(html).toContain('href="/privacy"');
	expect(html.replace(/<[^>]+>/g, "")).toContain(
		"Recordings hide all text, code, chats and inputs.",
	);
});
