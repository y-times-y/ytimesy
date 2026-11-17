import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ComposerDeliveryToggle } from "./composer-delivery";

it("offers Queue and Steer as radios, the chosen one checked", () => {
	const html = renderToStaticMarkup(
		<ComposerDeliveryToggle value="steer" onChange={() => {}} active />,
	);
	expect(html).toContain("<fieldset");
	expect(html).toContain("How to send while the agent is working");
	expect(html).toContain(">Queue<");
	expect(html).toContain(">Steer<");
	expect(html.match(/type="radio"/g)).toHaveLength(2);
	expect(html).toMatch(/<input[^>]*checked=""[^>]*value="steer"/);
	expect(html).not.toMatch(/<input[^>]*checked=""[^>]*value="queue"/);
	expect(html).toContain('data-active="true"');
});

it("keeps its space but is hidden from the page and from the keyboard when no turn runs", () => {
	const html = renderToStaticMarkup(
		<ComposerDeliveryToggle value="queue" onChange={() => {}} active={false} />,
	);
	expect(html).toContain('data-active="false"');
	expect(html).toContain('aria-hidden="true"');
	expect(html).toContain("inert");
});
