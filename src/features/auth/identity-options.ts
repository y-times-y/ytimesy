import { useQuery } from "@tanstack/react-query";
import type { IdentityOptions } from "#/domain/identity-providers";

/**
 * The sign-in methods the server actually configured. Until it loads, only
 * GitHub (always configured) is assumed, and email sign-up and password reset
 * stay hidden so nobody starts a flow whose email can never arrive.
 */
export function useIdentityOptions() {
	return useQuery({
		queryKey: ["identity-options"],
		queryFn: async (): Promise<IdentityOptions> => {
			const response = await fetch("/api/identity/providers");
			if (!response.ok) throw new Error("Sign-in options are unavailable.");
			return response.json();
		},
		staleTime: Number.POSITIVE_INFINITY,
		retry: 2,
	});
}

export const fallbackIdentityOptions: IdentityOptions = {
	socialProviders: ["github"],
	emailDelivery: false,
};
