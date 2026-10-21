import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
	ProjectTrainingView,
	TrainingConsentView,
} from "./training-consent-settings";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

it("shows the drafted training copy with the toggle off by default", () => {
	const html = renderToStaticMarkup(
		<TrainingConsentView enabled={false} onChange={() => undefined} />,
	);
	expect(text(html)).toContain("Help improve ytimesy");
	expect(text(html)).toContain(
		"Your API keys, secrets and attachments are never included.",
	);
	expect(html).toContain('href="/training"');
	expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
});

it("shows the project exclusion with the drafted copy", () => {
	const html = renderToStaticMarkup(
		<ProjectTrainingView excluded={false} onChange={() => undefined} />,
	);
	expect(text(html)).toContain("Never use this project for training");
	expect(text(html)).toContain(
		"Chats in this project are never used to improve ytimesy",
	);
});
