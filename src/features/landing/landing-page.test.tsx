import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DISCORD_URL } from "./community-links";

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
	const flat = text.replace(/\s+/g, " ");
	// The post's three columns and nine rows.
	expect(flat).toContain(
		"ytimesy GPT-6 Astra xhigh Codex GPT-6 Astra max Codex GPT-6 Astra xhigh",
	);
	for (const value of [
		"58.5% 47.9–68.8",
		"58.2% 47.6–68.5",
		"57.9% 47.3–68.2",
		"— −0.3 −6.1 to +4.8 −0.6 −6.4 to +5.5",
		"49 of 66 47 of 66 46 of 66",
		"$7.47 $9.90 $7.12",
		"$2,466 $3,267 $2,351",
		"3.34M 4.56M 3.60M",
		"48k 73k 45k",
		"33.2 min* 43.4 min 33.3 min",
		"6aacc762 0f01715e caf6e433",
		"* at OpenAI speed; the difference from Codex xhigh is within noise",
		"Terminal-Bench 4.0 · GPT-6 Astra · all 66 tasks · 5 attempts each",
	])
		expect(flat).toContain(value);
	// No value is emphasized: every number is shown the same way.
	expect(html).not.toContain("data-best");
	// The Codex max sentence is gone: the table shows max.
	expect(flat).not.toContain("Codex with GPT-6 Astra max scores");
	expect(text).not.toContain("Preliminary");
	expect(html).toContain('href="/blog/harness-1-0"');
	expect(html).toContain('class="bench-writeup"');
	expect(html.indexOf("bench-writeup")).toBeGreaterThan(
		html.indexOf("bench-foot"),
	);
	expect(text).toContain("For more details, read the post");
	expect(text).toContain("Introducing ytimesy harness 1.0");
	for (const job of [
		"6aacc762-8e07-4be2-ab4e-17495141235d",
		"0f01715e-2f98-40e3-836f-1ac4fdce39a4",
		"caf6e433-9fff-4475-b0bc-977f14ac7052",
	])
		expect(html).toContain(
			`href="https://hub.harborframework.com/jobs/${job}"`,
		);
	// The score-vs-cost chart, wide and narrow.
	expect(html.match(/class="scc-svg/g)?.length).toBe(2);
	expect(html).toContain('href="/auth/sign-in"');
	expect(html).toContain('href="/auth/sign-up"');
	expect(html).toContain('href="/terms"');
	expect(html).toContain('href="/privacy"');
	expect(html).toContain('href="mailto:support@ytimesy.com"');
	expect(html).toContain('href="https://github.com/y-times-y/ytimesy"');
	expect(text).toContain("Open source");
	const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
	expect(header).toContain('href="https://github.com/y-times-y/ytimesy"');
	expect(header).toContain('aria-label="ytimesy on GitHub (open source)"');
	expect(header).toContain("GitHub");
	expect(header).toContain(`href="${DISCORD_URL}"`);
	expect(header).toContain('aria-label="Join the ytimesy Discord"');
	expect(html).toContain("Discord");
	// No emoji anywhere on the page.
	expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
});

it("shows the app as the product's own components render it today", () => {
	const html = renderToStaticMarkup(<LandingPage />);
	const preview = html.slice(html.indexOf('class="landing-preview"'));
	// Inert and described: a picture of the app, not controls.
	expect(preview.slice(0, 500)).toContain('role="img"');
	expect(preview.slice(0, 500)).toContain("inert");
	for (const real of [
		"workspace-shell",
		"project-sidebar",
		"Super agent",
		"Needs you",
		"Recently finished",
		"web-3",
		"canvas-card",
		"Pull requests",
		"Issues",
	])
		expect(preview, real).toContain(real);
	// The hand-drawn mock is gone.
	expect(html).not.toContain("app-shot");
	expect(html).not.toContain("as-sidebar");
});
