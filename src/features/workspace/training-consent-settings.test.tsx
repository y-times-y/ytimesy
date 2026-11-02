import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
	ProjectTrainingView,
	TRAINING_DETAILS,
	TRAINING_TOOLTIP_PLACEMENT,
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
		"your prompts, your code and its results",
		"We never use replies or code written by AI models.",
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

it("opens the training details below the icon, above the Settings dialog", () => {
	expect(TRAINING_TOOLTIP_PLACEMENT.side).toBe("bottom");
	expect(TRAINING_TOOLTIP_PLACEMENT.collisionPadding).toBeGreaterThan(0);
	// The tooltip is portaled to the page: it must stack over the overlay.
	const css = readFileSync(
		new URL("../../styles.css", import.meta.url),
		"utf8",
	);
	const overlay = Number(
		/\.settings-overlay\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1],
	);
	const tooltip = Number(
		/z-\[(\d+)\]/.exec(TRAINING_TOOLTIP_PLACEMENT.className)?.[1],
	);
	expect(overlay).toBeGreaterThan(0);
	expect(tooltip).toBeGreaterThan(overlay);
});
