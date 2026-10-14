import {
	offeredSocialProviders,
	type SocialProviderId,
} from "#/domain/identity-providers";

export function googleOAuthConfigured(config: {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
}): config is { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string } {
	return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}

/** Providers the server can actually complete a sign-in with. */
export function configuredSocialProviders(config: {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
}): SocialProviderId[] {
	return offeredSocialProviders.filter(
		(provider) => provider !== "google" || googleOAuthConfigured(config),
	);
}

export function authTrustedOrigins(appUrl: string) {
	const { origin, hostname, port, protocol } = new URL(appUrl);
	const origins = new Set([origin]);
	const explicitPort = port || (protocol === "https:" ? "443" : "80");
	if (hostname === "127.0.0.1")
		origins.add(`${protocol}//localhost:${explicitPort}`);
	if (hostname === "localhost")
		origins.add(`${protocol}//127.0.0.1:${explicitPort}`);
	return [...origins];
}
