import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useState } from "react";
import { Analytics } from "../features/analytics/analytics";
import { ReplayConsentBanner } from "../features/analytics/replay-consent-banner";
import { AppError, AppNotFound } from "../features/app/app-status";
import { FIRST_PAINT_SCRIPT } from "../features/app/first-paint";
import { AuthProviders } from "../features/auth/auth-providers";
import { LegalAcceptancePrompt } from "../features/auth/legal-acceptance-prompt";
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
			</head>
			<body>
				<QueryClientProvider client={queryClient}>
					<AuthProviders>
						<Analytics />
						<LegalAcceptancePrompt />
						<ReplayConsentBanner />
						{children}
					</AuthProviders>
				</QueryClientProvider>

				<Scripts />
			</body>
		</html>
	);
}
