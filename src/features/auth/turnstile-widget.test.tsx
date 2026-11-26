import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnstileProblem, turnstileFailureMessage } from "./turnstile-widget";

describe("Turnstile failure", () => {
	it("tells the person what happened and offers a retry", () => {
		const html = renderToStaticMarkup(
			<TurnstileProblem reason="script" onRetry={() => undefined} />,
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain(turnstileFailureMessage("script"));
		expect(html).toContain("Try again");
	});

	it("explains a blocked script differently from a failed challenge", () => {
		expect(turnstileFailureMessage("script")).toMatch(/blocker|connection/i);
		expect(turnstileFailureMessage("challenge")).toMatch(/security check/i);
		expect(turnstileFailureMessage("expired")).toMatch(/expired/i);
	});
});
