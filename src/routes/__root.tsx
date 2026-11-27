import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { refetchOnFocusUnlessPushed } from "#/features/workspace/user-hub-store";
import interLatin from "../assets/fonts/inter-latin-wght-400-700.woff2?url";
import { Analytics } from "../features/analytics/analytics";
import { AppError, AppNotFound } from "../features/app/app-status";
import { FIRST_PAINT_SCRIPT } from "../features/app/first-paint";
import { NewVersionNotice } from "../features/app/new-version-notice";
import { PrivacyRegionProvider } from "../features/app/privacy-region";
import { readPrivacyRegionFn } from "../features/app/privacy-region.fn";
import { SPECULATION_RULES } from "../features/app/speculation-rules";
import { AuthProviders } from "../features/auth/auth-providers";
import { LegalUpdateNotice } from "../features/auth/legal-acceptance-prompt";
import { ReconnectingNotice } from "../features/workspace/reconnecting-notice";
import { followOtherTabSaves } from "../lib/optimistic-mutation";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	notFoundComponent: AppNotFound,
	errorComponent: AppError,
	// The visitor's region, read once with the server's page: the EU/UK
	// defaults (no replay, training off) are right from the first paint.
	loader: () => readPrivacyRegionFn(),
	staleTime: Number.POSITIVE_INFINITY,
	shouldReload: false,
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
			// For search engines, which read neither SVG media queries nor the
			// tab icons below: the opaque Y (brand/github-avatar.png), square,
			// a multiple of 48 px; /favicon.ico holds 16-48 px of the same.
			{
				rel: "icon",
				type: "image/png",
				sizes: "96x96",
				href: "/brand/favicon-96.png",
			},
			// The Y mark in the tab: dark artwork on light tab bars, light on dark.
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/brand/mark-dark.svg",
				media: "(prefers-color-scheme: light)",
			},
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/brand/mark-light.svg",
				media: "(prefers-color-scheme: dark)",
			},
			{ rel: "apple-touch-icon", href: "/brand/favicon-192.png" },
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
				defaultOptions: {
					queries: {
						staleTime: 15000,
						retry: false,
						// While the user hub pushes changes, focus re-reads nothing.
						refetchOnWindowFocus: refetchOnFocusUnlessPushed,
					},
				},
			}),
	);
	useEffect(() => followOtherTabSaves(queryClient), [queryClient]);
	const region = Route.useLoaderData();
	const strictRegion = region?.strict ?? false;
	const analyticsOptIn = region?.analyticsOptIn ?? strictRegion;
	const replayConsent = region?.replayConsent ?? false;
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
					<PrivacyRegionProvider
						strict={strictRegion}
						analyticsOptIn={analyticsOptIn}
						replayConsent={replayConsent}
					>
						<AuthProviders>
							<Analytics />
							<LegalUpdateNotice />
							<NewVersionNotice />
							<ReconnectingNotice />
							{children}
						</AuthProviders>
					</PrivacyRegionProvider>
				</QueryClientProvider>

				<Scripts />
			</body>
		</html>
	);
}
