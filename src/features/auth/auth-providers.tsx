import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { AuthProvider } from "#/components/auth/auth-provider";
import { Toaster } from "#/components/ui/sonner";
import { TooltipProvider } from "#/components/ui/tooltip";
import { requestJson } from "../projects/api";
import { authClient } from "./client";

const githubOnly = ["github"] as const;

export function AuthProviders({ children }: { children: ReactNode }) {
	const navigate = useNavigate();
	const providers = useQuery({
		queryKey: ["identity", "providers"],
		queryFn: () =>
			requestJson<{ socialProviders: Array<"github" | "google"> }>(
				"/api/identity/providers",
			),
	});
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
					socialProviders={providers.data?.socialProviders ?? githubOnly}
					emailAndPassword={{
						enabled: true,
						requireEmailVerification: true,
						forgotPassword: true,
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
