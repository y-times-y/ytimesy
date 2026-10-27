import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LazyDetails, RenderFoldedBodies } from "./lazy-details";

const details = (open?: boolean) => (
	<LazyDetails className="session-activity" open={open}>
		<summary>Ran tests</summary>
		<pre>full output</pre>
	</LazyDetails>
);

it("renders only the summary while folded", () => {
	const html = renderToStaticMarkup(details());
	expect(html).toBe(
		'<details class="session-activity"><summary>Ran tests</summary></details>',
	);
});

it("renders the body when open, or when asked to render folded bodies", () => {
	expect(renderToStaticMarkup(details(true))).toContain("full output");
	expect(
		renderToStaticMarkup(
			<RenderFoldedBodies.Provider value={true}>
				{details()}
			</RenderFoldedBodies.Provider>,
		),
	).toContain("full output");
});
