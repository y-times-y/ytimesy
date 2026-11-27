import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProjectMark } from "./project-mark";

it("renders initials on a fixed-size tile, never an image", () => {
	const html = renderToStaticMarkup(
		<ProjectMark project={{ id: "p1", name: "my-app" }} size={20} />,
	);
	expect(html).toContain(">MA<");
	expect(html).toContain("width:20px");
	expect(html).toContain("height:20px");
	expect(html).not.toContain("<img");
	expect(html).toContain('aria-hidden="true"');
});

it("renders the same markup for the same project everywhere", () => {
	const a = renderToStaticMarkup(
		<ProjectMark project={{ id: "p1", name: "x" }} />,
	);
	expect(
		renderToStaticMarkup(<ProjectMark project={{ id: "p1", name: "x" }} />),
	).toBe(a);
});
