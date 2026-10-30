import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NetworkAccessView } from "./network-access-settings";

const text = (html: string) => html.replace(/<[^>]+>/g, "");
const noop = () => undefined;

it("shows the three modes and hides the list in full mode", () => {
	const html = renderToStaticMarkup(
		<NetworkAccessView
			mode="full"
			text=""
			pending={false}
			onMode={noop}
			onText={noop}
			onSubmit={noop}
		/>,
	);
	expect(text(html)).toContain("Full internet");
	expect(text(html)).toContain("Common dependencies");
	expect(text(html)).toContain("Allowlist only");
	expect(html).not.toContain("<textarea");
});

it("shows the editable list and built-in domains in defaults mode", () => {
	const html = renderToStaticMarkup(
		<NetworkAccessView
			mode="defaults"
			text="example.com"
			pending={false}
			onMode={noop}
			onText={noop}
			onSubmit={noop}
		/>,
	);
	expect(html).toContain("<textarea");
	expect(html).toContain("example.com");
	expect(text(html)).toContain("pypi.org");
	expect(text(html)).toContain("Save");
});
