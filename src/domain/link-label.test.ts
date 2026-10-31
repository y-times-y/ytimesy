import { expect, it } from "vitest";
import { linkLabel } from "./link-label";

it("replaces a bare-domain label with the address it opens", () => {
	expect(linkLabel("github.com", "https://github.com/acme/app/pull/12")).toBe(
		"github.com/acme/app/pull/12",
	);
	expect(
		linkLabel("https://www.github.com/", "https://github.com/acme/app#readme"),
	).toBe("github.com/acme/app#readme");
});

it("keeps descriptive labels and links to the homepage itself", () => {
	expect(
		linkLabel("#12 Add dark mode", "https://github.com/acme/app/pull/12"),
	).toBeNull();
	expect(linkLabel("github.com", "https://github.com/")).toBeNull();
	expect(linkLabel("github.com", "mailto:a@github.com")).toBeNull();
});
