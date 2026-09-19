import { Link, useNavigate } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { AuthProvider } from "#/components/auth/auth-provider";
import { Toaster } from "#/components/ui/sonner";
import { TooltipProvider } from "#/components/ui/tooltip";
import { offeredSocialProviders } from "#/domain/identity-providers";
import { authClient } from "./client";

export function AuthProviders({ children }: { children: ReactNode }) {
	const navigate = useNavigate();
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
					redirectTo="/"
					socialProviders={[...offeredSocialProviders]}
					emailAndPassword={{
						enabled: true,
						requireEmailVerification: true,
						forgotPassword: true,
					}}
					localization={{
						auth: {
							emailPlaceholder: "you@email.com",
						},
					}}
					navigate={navigate}
					Link={({ href, ...props }) => <Link to={href} {...props} />}
				>
					{children}
					<Toaster />
				</AuthProvider>
			</TooltipProvider>
		</ThemeProvider>
	);
}
