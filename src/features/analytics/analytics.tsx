import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { analyticsSurface } from "#/domain/analytics";
import { authClient } from "#/features/auth/client";
import { captureAnalytics, setAnalyticsUser } from "./client";

export function Analytics() {
	const { data, isPending } = authClient.useSession();
	const userId = data?.user.id ?? null;
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	useEffect(() => {
		if (!isPending) setAnalyticsUser(userId);
	}, [isPending, userId]);
	useEffect(() => {
		if (!isPending)
			captureAnalytics("app_viewed", { surface: analyticsSurface(pathname) });
	}, [isPending, pathname]);
	return null;
}
