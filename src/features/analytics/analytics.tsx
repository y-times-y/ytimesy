import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { analyticsSurface } from "#/domain/analytics";
import { authClient } from "#/features/auth/client";
import { useLegalAcceptedForReplay } from "#/features/auth/legal-acceptance-prompt";
import { useStrictPrivacyRegion } from "../app/privacy-region";
import {
	captureAnalytics,
	setAnalyticsStrictRegion,
	setAnalyticsUser,
} from "./client";
import { captureFirstTouch, firstTouchEventProperties } from "./first-touch";
import { startWebVitals } from "./web-vitals";

export function Analytics() {
	const { data, isPending } = authClient.useSession();
	const userId = data?.user.id ?? null;
	// No session replay for visitors in the EU, EEA, UK or Switzerland, and
	// none before the user has accepted the current Privacy Policy.
	const strict = useStrictPrivacyRegion();
	const legalAccepted = useLegalAcceptedForReplay();
	const replay = !strict && legalAccepted;
	// Before any effect below can start the client.
	setAnalyticsStrictRegion(strict);
	const strictRegion = strict;
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
	useEffect(() => {
		if (!isPending) setAnalyticsUser(userId, { replay });
	}, [isPending, userId, replay]);
	useEffect(() => {
		if (!isPending)
			captureAnalytics("app_viewed", {
				surface: analyticsSurface(pathname),
				...firstTouchEventProperties(),
			});
	}, [isPending, pathname]);
	return null;
}
