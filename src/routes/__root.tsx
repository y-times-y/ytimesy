import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useState } from "react";
import { Analytics } from "../features/analytics/analytics";
import { ReplayConsentBanner } from "../features/analytics/replay-consent-banner";
import { AppError, AppNotFound } from "../features/app/app-status";
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
