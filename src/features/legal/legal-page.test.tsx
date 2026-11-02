import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children: unknown }) => (
		<a href={to}>{children as string}</a>
	),
}));

import { LegalPage, publicLegalMarkdown } from "./legal-page";

const source = (name: string) =>
	readFileSync(`src/content/legal/${name}`, "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, "");

const page = (name: string, cutAt?: string) =>
	text(
		renderToStaticMarkup(
			<LegalPage
				markdown={publicLegalMarkdown(source(name), cutAt)}
				version="v"
			/>,
		),
	);
const published = [
	["terms.md"],
	["privacy.md"],
	["training-opt-in.md", "## Schema and product requirements"],
] as const;

it("renders the Terms with links between the documents", () => {
	const html = renderToStaticMarkup(
		<LegalPage markdown={source("terms.md")} version="v-test" />,
	);
	expect(text(html)).toContain("ytimesy Terms of Service");
	expect(text(html)).toContain("Version v-test");
	// Links between the documents point at the in-app pages.
	expect(html).toContain('href="/privacy"');
	expect(html).toContain('href="/training"');
	expect(html).not.toContain(".md");
});

it("shows the draft banner only while the documents are not in effect", () => {
	const draft = renderToStaticMarkup(
		<LegalPage markdown={source("terms.md")} version="v" inEffect={false} />,
	);
	expect(draft).toContain('role="note"');
	expect(text(draft)).toContain("Draft — not yet in effect");
	const live = renderToStaticMarkup(
		<LegalPage markdown={source("terms.md")} version="v" inEffect />,
	);
	expect(live).not.toContain("not yet in effect");
});

it("publishes no placeholders, drafting notes or competitor names", () => {
	for (const [name, cutAt] of published) {
		const body = page(name, cutAt);
		expect(body, name).not.toMatch(/\[(OWNER|COUNSEL)|\{\{|\[DATE\]|DRAFT/);
		expect(body, name).not.toMatch(/\b(Competitor)\b/);
		expect(body, name).not.toContain(".md");
	}
});

it("describes self-serve account deletion, not a contact-us request", () => {
	const html = page("privacy.md");
	expect(html).toContain("Settings → Delete account");
	expect(html).not.toMatch(/contact us to delete/i);
});

it("publishes the training policy without its internal schema notes", () => {
	const body = publicLegalMarkdown(
		source("training-opt-in.md"),
		"## Schema and product requirements",
	);
	expect(body).toContain("## What is never used");
	expect(body).toContain("## Where things stand today");
	expect(body).not.toContain("training_eligible");
	expect(body).not.toContain("Schema and product requirements");
});
