import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useLayoutEffect } from "react";
import { AuthProvider } from "#/components/auth/auth-provider";
import { Toaster } from "#/components/ui/sonner";
import { TooltipProvider } from "#/components/ui/tooltip";
import {
	returnToForLocation,
	sanitizedReturnToUrl,
	withReturnTo,
} from "#/domain/return-to";
import { authClient } from "./client";
import {
	fallbackIdentityOptions,
	useIdentityOptions,
} from "./identity-options";

export function AuthProviders({ children }: { children: ReactNode }) {
	const navigate = useNavigate();
	const identity = useIdentityOptions().data ?? fallbackIdentityOptions;
	const location = useRouterState({ select: (state) => state.location });
	// Every sign-in method returns here: the page a signed-out visitor
	// followed, or the validated parameter carried between sign-in views.
	const returnTo = returnToForLocation(
		location.pathname,
		location.searchStr ?? "",
	);
	useNoUnsafeReturnTo(location.href);
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			forcedTheme="dark"
			enableSystem={false}
			disableTransitionOnChange
		>
			<TooltipProvider>
				<AuthProvider
					authClient={authClient}
					redirectTo={returnTo}
					socialProviders={[...identity.socialProviders]}
					emailAndPassword={{
						enabled: true,
						requireEmailVerification: true,
						forgotPassword: identity.emailDelivery,
					}}
					localization={{
						auth: {
							emailPlaceholder: "you@email.com",
						},
					}}
					navigate={({ to, replace }) =>
						navigate({ href: withReturnTo(to, returnTo), replace })
					}
					Link={({ href, ...props }) => {
						const target = new URL(withReturnTo(href, returnTo), "http://link");
						return (
							<Link
								to={target.pathname}
								search={Object.fromEntries(target.searchParams) as never}
								hash={target.hash.slice(1) || undefined}
								{...props}
							/>
						);
					}}
				>
					{children}
					<Toaster />
				</AuthProvider>
			</TooltipProvider>
		</ThemeProvider>
	);
}

const useClientLayoutEffect =
	typeof window === "undefined" ? () => undefined : useLayoutEffect;

/**
 * The auth UI reads `redirectTo` straight from the address bar when it
 * redirects after sign-in, so an unsafe value is replaced before anyone can
 * act on the page.
 */
function useNoUnsafeReturnTo(href: string) {
	useClientLayoutEffect(() => {
		void href;
		const { pathname, search, hash } = window.location;
		const safe = sanitizedReturnToUrl(pathname, search, hash);
		if (safe !== null)
			window.history.replaceState(window.history.state, "", safe);
	}, [href]);
}
