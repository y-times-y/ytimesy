import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FileChangeEntry } from "#/domain/session-item";
import { DiffFilePreview } from "./diff-inspector";

const render = (
	preview: string | null,
	change: FileChangeEntry["change"] = "update",
) =>
	renderToStaticMarkup(
		createElement(DiffFilePreview, {
			change: {
				path: "src/main.ts",
				change,
				additions: 1,
				deletions: 1,
				preview,
			},
			defaultOpen: true,
		}),
	);

describe("diff inspector library integration", () => {
	it("renders separate library hunks with original line numbers", () => {
		const html = render(
			"@@ -120 +120 @@\n-const old = 1;\n+const next = 2;\n@@ -200 +200 @@\n keep\n",
		);
		expect(html.match(/class="diff diff-unified"/g)).toHaveLength(2);
		expect(html).toContain('data-change-key="D120"');
		expect(html).toContain('data-change-key="I120"');
		expect(html).toContain("79");
		expect(html).toContain("unmodified");
		expect(html).not.toContain("@@ -200");
		expect(html).toContain("diff-code-delete");
		expect(html).toContain("diff-code-insert");
	});
	it.each(["add", "delete"] as const)(
		"renders a whole-file %s without a patch header",
		(change) => {
			const html = render("const value = 1;\n", change);
			expect(html).toContain(
				`diff-code-${change === "add" ? "insert" : "delete"}`,
			);
			expect(html).toContain("const value = 1;");
		},
	);
	it("keeps malformed previews visible and escapes source HTML", () => {
		const html = render("@@ -120,5 +120,5 @@\n-<script>alert(1)</script>\n");
		expect(html).toContain("Source line numbers unavailable");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});
	it("preserves empty-file feedback", () => {
		expect(render(null)).toContain("No diff preview for this file.");
	});
});
