import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WORKSPACE_PANES_END } from "../app/first-paint";
import { WorkspacePanes } from "./workspace-panes";

it("ends with the marker the first paint waits for, after both panes", () => {
	const html = renderToStaticMarkup(
		<WorkspacePanes
			open
			compact={false}
			ratio={0.55}
			view="files"
			layout="chat"
			onResize={() => {}}
			onReset={() => {}}
		>
			<p>chat</p>
			<p>inspector</p>
		</WorkspacePanes>,
	);
	const end = html.indexOf(`id="${WORKSPACE_PANES_END}"`);
	expect(end).toBeGreaterThan(html.indexOf("<p>inspector</p>"));
	expect(html.indexOf("<p>inspector</p>")).toBeGreaterThan(
		html.indexOf("<p>chat</p>"),
	);
});
