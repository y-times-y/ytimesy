import {
	type AuthErrorKind,
	authErrorKind,
	authViewFromPath,
} from "#/domain/auth-funnel";
import { captureAnalytics } from "#/features/analytics/client";

type FunnelStep = "view" | "submit" | "error" | "code_sent" | "verified";

/** Records one email sign-in step: the step and error kind only, no personal data. */
export function trackAuthFunnel(
	step: FunnelStep,
	error?: {
		error?: { code?: string; message?: string; status?: number } | null;
	} | null,
) {
	if (typeof window === "undefined") return;
	const kind: AuthErrorKind | undefined =
		step === "error" ? authErrorKind(error?.error ?? null) : undefined;
	captureAnalytics("auth_funnel", {
		view: authViewFromPath(window.location.pathname),
		step,
		...(kind ? { kind } : {}),
	});
}
