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
	// The description is only the link; the details are its tooltip.
	expect(text(html)).not.toContain("Use your chats");
	expect(text(html)).toContain("Learn more");
	expect(html).toContain('href="/training"');
	expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
	expect(html).not.toContain("Session recording");
});

it("shows a loading switch, never off, until the setting is known", () => {
	const html = renderToStaticMarkup(
		<TrainingConsentView enabled={undefined} onChange={() => undefined} />,
	);
	expect(html).toContain("settings-switch-pending");
	expect(html).toContain('aria-busy="true"');
	expect(html).not.toContain('data-state="unchecked"');
});

it("keeps every training commitment in the details", () => {
	for (const commitment of [
		"from now on",
		"your prompts, your code and its results",
		"We never use replies or code written by AI models.",
		"train our own models",
		"never share it with model providers",
		"Your stored API keys, secrets and your attachments are never included.",
		"Nothing is copied out for training yet.",
		"it stops immediately, for earlier chats too",
	])
		expect(TRAINING_DETAILS).toContain(commitment);
});

it("shows the project exclusion with the drafted copy", () => {
	const html = renderToStaticMarkup(
		<ProjectTrainingView excluded={false} onChange={() => undefined} />,
	);
	expect(text(html)).toContain("Never use this project for training");
	expect(html).toContain(
		"Chats in this project are never used to improve ytimesy",
	);
});

it("opens the training details below the link, above the Settings dialog", () => {
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
