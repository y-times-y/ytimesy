import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { analyticsSurface } from "#/domain/analytics";
import { authClient } from "#/features/auth/client";
import { useStrictPrivacyRegion } from "../app/privacy-region";
import { captureAnalytics, setAnalyticsUser } from "./client";
import { startWebVitals } from "./web-vitals";

export function Analytics() {
	const { data, isPending } = authClient.useSession();
	const userId = data?.user.id ?? null;
	// No session replay for visitors in the EU, EEA, UK or Switzerland.
	const replay = !useStrictPrivacyRegion();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	useEffect(() => {
		startWebVitals();
	}, []);
	useEffect(() => {
		if (!isPending) setAnalyticsUser(userId, { replay });
	}, [isPending, userId, replay]);
	useEffect(() => {
		if (!isPending)
			captureAnalytics("app_viewed", { surface: analyticsSurface(pathname) });
	}, [isPending, pathname]);
	return null;
}
