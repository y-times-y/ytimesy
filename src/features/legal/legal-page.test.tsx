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

it("renders the drafted Terms with placeholders and the draft banner", () => {
	const html = renderToStaticMarkup(
		<LegalPage markdown={source("terms.md")} version="v-test" />,
	);
	expect(html).toContain('role="note"');
	expect(text(html)).toContain("Draft — not yet in effect");
	expect(text(html)).toContain("ytimesy Terms of Service");
	expect(text(html)).toContain("[OWNER/COUNSEL:");
	expect(text(html)).toContain("Version v-test");
	// Links between the drafts point at the in-app pages.
	expect(html).toContain('href="/privacy"');
	expect(html).toContain('href="/training"');
	expect(html).not.toContain(".md");
});

it("drops the draft banner once the documents are in effect", () => {
	const html = renderToStaticMarkup(
		<LegalPage markdown={source("terms.md")} version="v" inEffect />,
	);
	expect(html).not.toContain("not yet in effect");
});

it("describes self-serve account deletion, not a contact-us request", () => {
	const html = text(
		renderToStaticMarkup(
			<LegalPage markdown={source("privacy.md")} version="v" />,
		),
	);
	expect(html).toContain("Settings, Delete account");
	expect(html).not.toMatch(/contact us to delete/i);
	expect(html).toContain("[OWNER");
});

it("publishes the training policy without its internal schema spec", () => {
	const page = publicLegalMarkdown(
		source("training-opt-in.md"),
		"## Schema and product requirements",
	);
	expect(page).toContain("## Copy");
	expect(page).not.toContain("create table");
	expect(page).not.toContain("Schema and product requirements");
});
