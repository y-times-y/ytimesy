import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
	ProjectTrainingView,
	TRAINING_DETAILS,
	TrainingConsentView,
} from "./training-consent-settings";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

it("shows the drafted training copy with the toggle off by default", () => {
	const html = renderToStaticMarkup(
		<TrainingConsentView enabled={false} onChange={() => undefined} />,
	);
	expect(text(html)).toContain("Help improve ytimesy");
	expect(text(html)).toContain(
		"Use your chats to improve our agents and models.",
	);
	expect(html).toContain('aria-label="Training details"');
	expect(text(html)).toContain(TRAINING_DETAILS);
	expect(html).toContain('href="/training"');
	expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
});

it("keeps every training commitment in the details", () => {
	for (const commitment of [
		"from now on",
		"prompts, agent actions and the code the agent reads or writes",
		"train our own models",
		"We remove account details and secrets first",
		"never share it with model providers",
		"Your API keys, secrets and attachments are never included.",
		"we stop immediately and delete what we kept within 30 days",
	])
		expect(TRAINING_DETAILS).toContain(commitment);
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
