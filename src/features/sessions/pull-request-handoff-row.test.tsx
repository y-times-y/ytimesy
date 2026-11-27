import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pullRequestChipAttributes } from "./pull-request-handoff-row";

describe("the handoff row's pull request link", () => {
	it("is marked so a plain click opens the in-app pull request page", () => {
		const html = renderToStaticMarkup(
			<a
				href="https://github.com/y-times-y/ytimesy/pull/45"
				{...pullRequestChipAttributes(
					"https://github.com/y-times-y/ytimesy/pull/45",
				)}
			>
				PR
			</a>,
		);
		expect(html).toContain('data-reference="pull-request"');
		expect(html).toContain('data-ref="y-times-y/ytimesy#45"');
	});
	it("is left alone for an address that is not a pull request", () => {
		expect(pullRequestChipAttributes("https://example.com/x")).toEqual({});
	});
});
