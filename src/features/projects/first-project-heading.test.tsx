import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FirstProjectHeading } from "./first-project-heading";

it("says one short line and offers no action of its own", () => {
	const html = renderToStaticMarkup(<FirstProjectHeading />);
	expect(html).toContain("<h2>Pick a repository to start</h2>");
	expect(html).not.toContain("<button");
	expect(html).not.toContain("<a ");
	expect(html.match(/<p/g)).toBeNull();
});
