import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { analyticsSurface } from "#/domain/analytics";
import { authClient } from "#/features/auth/client";
import { useLegalAcceptedForReplay } from "#/features/auth/legal-acceptance-prompt";
import { useConsentTier } from "../app/privacy-region";
import {
	captureAnalytics,
	setAnalyticsUser,
	setConsentTier,
	setReplayChoice,
} from "./client";
import { ConsentBanner, consentBannerVisible } from "./consent-banner";
import { captureFirstTouch, firstTouchEventProperties } from "./first-touch";
import { useReplayChoice } from "./use-replay-choice";
import { startWebVitals } from "./web-vitals";

export function Analytics() {
	const { data, isPending } = authClient.useSession();
	const userId = data?.user.id ?? null;
	// What waits for the visitor's Accept depends on where they are
	// (consent-tier.ts). A signed-in user also needs the current Privacy Policy.
	const tier = useConsentTier();
	const legalAccepted = useLegalAcceptedForReplay();
	const replay = userId === null || legalAccepted;
	const saved = useReplayChoice();
	const choice = saved?.choice ?? null;
	// Before any effect below can start the client.
	setConsentTier(tier);
	// The first-touch cookie is non-essential: not before an Accept in the
	// opt-in regions.
	const strictRegion = tier === "analytics" && choice !== "allowed";
	// Pageviews start counting once analytics may run, not on every choice.
	const analyticsOn = tier !== "analytics" || choice === "allowed";
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	// After hydration, so the first paint is untouched: where this visitor
	// first came from, then ref/utm_* removed from the address bar.
	useEffect(() => {
		captureFirstTouch({ strictRegion });
	}, [strictRegion]);
	useEffect(() => {
		startWebVitals();
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: an Accept or a withdrawal (choice) must re-run this: the client starts, or replay starts or stops, only once it sees it.
	useEffect(() => {
		if (!isPending) setAnalyticsUser(userId, { replay });
	}, [isPending, userId, replay, choice]);
	useEffect(() => {
		if (!isPending && analyticsOn)
			captureAnalytics("app_viewed", {
				surface: analyticsSurface(pathname),
				...firstTouchEventProperties(),
			});
	}, [isPending, pathname, analyticsOn]);
	if (
		!saved ||
		!consentBannerVisible({
			tier,
			choice: saved.choice,
			block: saved.block,
			signedIn: userId !== null,
		})
	)
		return null;
	return <ConsentBanner tier={tier} onChoose={setReplayChoice} />;
}
