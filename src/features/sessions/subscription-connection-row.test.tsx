import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	SubscriptionConnectionRow,
	type SubscriptionConnectionRowProps,
} from "./subscription-connection-row";

const base: Omit<SubscriptionConnectionRowProps, "name"> = {
	mark: <svg />,
	meta: "status",
	signedIn: false,
	badge: { text: "Connected", ok: true },
	signIn: <button type="button">Sign in</button>,
	onSignOut: async () => {},
};
const render = (props: Partial<SubscriptionConnectionRowProps> = {}) =>
	renderToStaticMarkup(
		<ul>
			<SubscriptionConnectionRow name="X" {...base} {...props} />
		</ul>,
	);
/** The markup with the per-provider words blanked, to compare structure. */
const shape = (html: string) =>
	html.replace(/ aria-label="[^"]*"/, "").replace(/>[^<]+</g, "><");

describe("SubscriptionConnectionRow", () => {
	it("gives Codex, Claude and Grok the same structure", () => {
		for (const signedIn of [true, false]) {
			const [codex, claude, grok] = [
				"Codex subscription",
				"Claude subscription",
				"Grok subscription",
			].map((name) => render({ name, signedIn }));
			expect(shape(claude)).toBe(shape(codex));
			expect(shape(grok)).toBe(shape(codex));
			expect(codex).toContain('class="settings-row"');
		}
	});

	it("signed in: badge and Sign out, no sign-in action", () => {
		const html = render({ signedIn: true });
		expect(html).toContain('data-tone="ok"');
		expect(html).toContain(">Connected<");
		expect(html).toContain(">Sign out<");
		expect(html).not.toContain(">Sign in<");
	});

	it("Retrying has no ok tone and keeps Sign out", () => {
		const html = render({ signedIn: true, badge: { text: "Retrying" } });
		expect(html).toContain(">Retrying<");
		expect(html).not.toContain("data-tone");
		expect(html).toContain(">Sign out<");
	});

	it("signed out: only the provider's sign-in action, plus the hint", () => {
		const html = render({ hint: <small>hint</small> });
		expect(html).toContain(">Sign in<");
		expect(html).toContain("<small>hint</small>");
		expect(html).not.toContain("Sign out");
		expect(html).not.toContain("settings-badge");
		expect(render({ signedIn: true, hint: <small>hint</small> })).not.toContain(
			"hint",
		);
	});

	it("shows the detail as the status line's tooltip", () => {
		expect(render({ metaTitle: "more" })).toContain('title="more"');
	});
});
