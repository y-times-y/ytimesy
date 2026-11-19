import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	THREAD_CARD_OPEN_DELAY_MS,
	ThreadHoverCard,
} from "./thread-hover-card";

describe("ThreadHoverCard", () => {
	it("opens after a short rest, and its trigger renders as the row itself", () => {
		expect(THREAD_CARD_OPEN_DELAY_MS).toBe(250);
		const html = renderToStaticMarkup(
			<ThreadHoverCard
				data={{
					id: "WEB-3F9A",
					title: "Fix form",
					projectName: "Web",
					status: "Working",
					model: "Kimi K3",
					cloud: true,
					pullRequest: null,
				}}
			>
				<li className="row">Fix form</li>
			</ThreadHoverCard>,
		);
		expect(html).toContain('<li class="row"');
		// Closed until hovered or focused: the card is not in the markup.
		expect(html).not.toContain("thread-card");
	});
});
