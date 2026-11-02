import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		children,
		className,
	}: {
		to: string;
		params?: { path: string };
		children: unknown;
		className?: string;
	}) => (
		<a
			href={params ? to.replace("$path", params.path) : to}
			className={className}
		>
			{children as string}
		</a>
	),
}));

import { LandingPage } from "./landing-page";

it("shows the pitch, the benchmark, and sign-in, sign-up, terms, privacy and support", () => {
	const html = renderToStaticMarkup(<LandingPage />);
	const text = html.replace(/<[^>]+>/g, " ");
	expect(text).toContain("AI Software Engineer in the Cloud");
	expect(text).toContain("Terminal-Bench 4.0");
	expect(text).toContain("58.5%");
	expect(text).toContain("57.9%");
	expect(text).toContain("49 of 66");
	expect(text).toContain("46 of 66");
	expect(text).toContain("$7.47");
	expect(text).toContain("$7.12");
	expect(text.replace(/\s+/g, " ")).toContain(
		"Codex with GPT-6 Astra max scores 58.2% at $9.90 per attempt. ytimesy matches that score at about 25% lower cost.",
	);
	// Final numbers, and no speed claim.
	expect(text).not.toContain("Preliminary");
	expect(text).not.toMatch(/Time per|min\b/);
	expect(html).toContain('href="/blog/harness-1-0"');
	expect(text).toContain("Read how we built it");
	expect(html).toContain(
		'href="https://hub.harborframework.com/jobs/6aacc762-8e07-4be2-ab4e-17495141235d"',
	);
	// The score-vs-cost chart, wide and narrow.
	expect(html.match(/class="scc-svg/g)?.length).toBe(2);
	expect(html).toContain('href="/auth/sign-in"');
	expect(html).toContain('href="/auth/sign-up"');
	expect(html).toContain('href="/terms"');
	expect(html).toContain('href="/privacy"');
	expect(html).toContain('href="mailto:support@ytimesy.com"');
	// No emoji anywhere on the page.
	expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
});
