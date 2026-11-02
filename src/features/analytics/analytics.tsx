import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { analyticsSurface } from "#/domain/analytics";
import { authClient } from "#/features/auth/client";
import { useStrictPrivacyRegion } from "../app/privacy-region";
import { captureAnalytics, setAnalyticsUser } from "./client";
import { captureFirstTouch, firstTouchEventProperties } from "./first-touch";
import { startWebVitals } from "./web-vitals";

export function Analytics() {
	const { data, isPending } = authClient.useSession();
	const userId = data?.user.id ?? null;
	// No session replay for visitors in the EU, EEA, UK or Switzerland.
	const strictRegion = useStrictPrivacyRegion();
	const replay = !strictRegion;
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
