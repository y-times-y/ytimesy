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

import { BlogIndex, HarnessPost } from "./blog-pages";

it("/blog/harness-1-0 renders the whole post with its chart, diagrams and links", () => {
	const html = renderToStaticMarkup(<HarnessPost />);
	const text = html.replace(/<[^>]+>/g, " ");
	expect(html).toContain("<h1>Introducing ytimesy harness 1.0</h1>");
	expect(html).toContain('src="/blog/harness-1-0/banner.jpg"');
	// Results table, the chart (wide and narrow) and the three diagrams.
	expect(html).toContain('class="rt"');
	expect(html.match(/class="scc-svg/g)?.length).toBe(2);
	expect(html).toContain("The lead agent and its eleven tools");
	expect(html).toContain("A real program from a ytimesy run");
	expect(html).toContain("only tracked files and the declared outputs");
	expect(text).toContain("Score vs cost");
	// The chart marker is replaced, not printed.
	expect(html).not.toContain("score-cost-chart -->");
	// Start building goes to sign-up; footnotes link the public jobs.
	expect(html).toContain(
		'<a class="btn" href="/auth/sign-up">Start building</a>',
	);
	for (const job of ["6aacc762", "caf6e433", "0f01715e"])
		expect(html).toContain(`https://hub.harborframework.com/jobs/${job}`);
	expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
});

it("/blog lists the post", () => {
	const html = renderToStaticMarkup(<BlogIndex />);
	expect(html).toContain('href="/blog/harness-1-0"');
	expect(html).toContain("Introducing ytimesy harness 1.0");
	expect(html).toMatch(/datetime="2026-11-01"/i);
});
