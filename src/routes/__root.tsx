import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import interLatin from "../assets/fonts/inter-latin-wght-400-700.woff2?url";
import { Analytics } from "../features/analytics/analytics";
import {
	ANALYTICS_ENABLED,
	ANALYTICS_HOST,
} from "../features/analytics/client";
import { ReplayConsentBanner } from "../features/analytics/replay-consent-banner";
import { AppError, AppNotFound } from "../features/app/app-status";
import { FIRST_PAINT_SCRIPT } from "../features/app/first-paint";
import { SPECULATION_RULES } from "../features/app/speculation-rules";
import { AuthProviders } from "../features/auth/auth-providers";
import { LegalUpdateNotice } from "../features/auth/legal-acceptance-prompt";
import { followOtherTabSaves } from "../lib/optimistic-mutation";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	notFoundComponent: AppNotFound,
	errorComponent: AppError,
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content:
					"width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
			},
			{
				title: "ytimesy",
			},
		],
		links: [
			// The text's font downloads with the stylesheet instead of after it.
			{
				rel: "preload",
				href: interLatin,
				as: "font",
				type: "font/woff2",
				crossOrigin: "anonymous",
			},
			{
				rel: "stylesheet",
				href: appCss,
			},
			// Analytics posts here once the session is known; connect early.
			...(ANALYTICS_ENABLED
				? [
						{
							rel: "preconnect",
							href: new URL(ANALYTICS_HOST).origin,
							crossOrigin: "anonymous" as const,
						},
					]
				: []),
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: { queries: { staleTime: 15000, retry: false } },
			}),
	);
	useEffect(() => followOtherTabSaves(queryClient), [queryClient]);
	return (
		<html lang="en" className="dark" suppressHydrationWarning>
			<head>
				{/* Server and client bundles minify the script differently; it ran once already. */}
				<script
					// biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant script, no user input.
					dangerouslySetInnerHTML={{ __html: FIRST_PAINT_SCRIPT }}
					suppressHydrationWarning
				/>
				<HeadContent />
				<script
					type="speculationrules"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant JSON, no user input.
					dangerouslySetInnerHTML={{ __html: SPECULATION_RULES }}
				/>
			</head>
			<body>
				<QueryClientProvider client={queryClient}>
					<AuthProviders>
						<Analytics />
						<LegalUpdateNotice />
						<ReplayConsentBanner />
						{children}
					</AuthProviders>
				</QueryClientProvider>

				<Scripts />
			</body>
		</html>
	);
}
