import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
	markNewBuildAvailable,
	useNewBuildAvailable,
} from "./new-build-reload";
import { NewVersionCard, NewVersionNotice } from "./new-version-notice";

it("offers one click to update, bottom right", () => {
	const html = renderToStaticMarkup(<NewVersionCard onUpdate={() => {}} />);
	expect(html).toContain("A new version is available.");
	expect(html).toContain("Update");
	expect(html).toContain("right-4 bottom-4");
	expect(html).toContain('role="status"');
});

it("shows nothing until the tab knows of a newer build", () => {
	expect(renderToStaticMarkup(<NewVersionNotice />)).toBe("");
	function Probe() {
		return <i>{String(useNewBuildAvailable())}</i>;
	}
	// The server snapshot is always "no": the notice never renders into server HTML.
	markNewBuildAvailable();
	expect(renderToStaticMarkup(<Probe />)).toContain("false");
});
