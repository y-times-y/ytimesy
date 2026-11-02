import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
	createServerFn: () => {
		const chain = { validator: () => chain, handler: () => vi.fn() };
		return chain;
	},
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));
vi.mock("#/server/adapters/training-consent", () => ({}));
vi.mock("#/server/auth/auth", () => ({}));
vi.mock("#/server/http", () => ({}));

import { PrivacyRegionProvider } from "../app/privacy-region";
import { PrivacyStep } from "../onboarding/first-run";
import { trainingConsentInput } from "./training-consent.fn";
import { TrainingChoice, TrainingConsentCard } from "./training-consent-prompt";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

it("shows the training switch on by default, with the policy link and where to change it", () => {
	const onContinue = vi.fn();
	const onDismiss = vi.fn();
	const html = renderToStaticMarkup(
		<TrainingConsentCard onContinue={onContinue} onDismiss={onDismiss} />,
	);
	expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
	expect(text(html)).toContain("Help improve ytimesy");
	// Only the link describes it; the details are its tooltip.
	expect(text(html)).not.toContain("Uses your prompts");
	expect(text(html)).toContain("Learn more");
	expect(html).toContain('href="/training"');
	expect(text(html)).toContain(
		"You can change this anytime in Settings → Privacy.",
	);
	expect(text(html)).toContain("Continue");
	expect(html).toContain('aria-label="Close"');
	// Not modal: the app behind stays usable.
	expect(html).not.toContain("aria-modal");
	// Showing the card records nothing.
	expect(onContinue).not.toHaveBeenCalled();
	expect(onDismiss).not.toHaveBeenCalled();
});

it("shows the switch as the user set it", () => {
	const html = renderToStaticMarkup(
		<TrainingChoice enabled={false} onChange={() => undefined} />,
	);
	expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
});

it("puts the same default-on card in the first run, recorded on Continue", () => {
	const html = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<PrivacyStep />
		</QueryClientProvider>,
	);
	expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
	expect(html).toMatch(/<button[^>]*class="first-run-primary"[^>]*>Continue/);
});

it("starts the switch off in the EU/UK, on the card and in the first run", () => {
	const card = renderToStaticMarkup(
		<PrivacyRegionProvider strict>
			<TrainingConsentCard onContinue={vi.fn()} onDismiss={vi.fn()} />
		</PrivacyRegionProvider>,
	);
	expect(card).toMatch(/role="switch"[^>]*aria-checked="false"/);
	const firstRun = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<PrivacyRegionProvider strict>
				<PrivacyStep />
			</PrivacyRegionProvider>
		</QueryClientProvider>,
	);
	expect(firstRun).toMatch(/role="switch"[^>]*aria-checked="false"/);
});

it("records Settings changes as settings and the card's choice as onboarding", () => {
	expect(
		trainingConsentInput.parse({ enabled: true, policyVersion: "v" }).source,
	).toBe("settings");
	expect(
		trainingConsentInput.parse({
			enabled: false,
			policyVersion: "v",
			source: "onboarding",
		}).source,
	).toBe("onboarding");
	expect(() =>
		trainingConsentInput.parse({
			enabled: true,
			policyVersion: "v",
			source: "admin",
		}),
	).toThrow();
});
