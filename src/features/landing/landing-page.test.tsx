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
	expect(text).toContain("Cloud coding agent.");
	expect(text).toContain("Time per task");
	expect(text).toContain("19.3 min");
	expect(html).toContain('href="/auth/sign-in"');
	expect(html).toContain('href="/auth/sign-up"');
	expect(html).toContain('href="/terms"');
	expect(html).toContain('href="/privacy"');
	expect(html).toContain('href="mailto:support@ytimesy.com"');
	// No emoji anywhere on the page.
	expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
});
