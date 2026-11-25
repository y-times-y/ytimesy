import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		const chain: Record<string, unknown> = {};
		for (const name of ["handler", "validator"]) chain[name] = () => chain;
		return chain;
	},
	useServerFn: (fn: unknown) => fn,
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));

import { ReferralInviteCard, referralOfferText } from "./referral-invite";

describe("referral invitation", () => {
	it("offers both a reset until the referrer's rewards are used, then only the friend's", () => {
		expect(referralOfferText(false)).toMatch(
			/you both get a fresh usage window/,
		);
		const capped = referralOfferText(true);
		expect(capped).toMatch(/Friends who join/);
		expect(capped).not.toMatch(/you both|you get/i);
	});
	it("shows the link with copy, Share and Post on X, in the notification card", () => {
		const html = renderToStaticMarkup(
			<ReferralInviteCard
				title="Your usage window is full"
				message="New work resumes soon."
				link="https://ytimesy.com/?ref=r-k3f9x2qa"
				onDismiss={() => undefined}
			/>,
		);
		expect(html).toContain('class="usage-warning-banner referral-invite"');
		expect(html).toContain("ytimesy.com/?ref=r-k3f9x2qa");
		expect(html).toContain('aria-label="Copy link"');
		expect(html).toContain("Share");
		expect(html).toContain("https://x.com/intent/post?text=");
		expect(html).not.toMatch(/data-level|amber|yellow/);
	});
});
