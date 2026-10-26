import { createFileRoute } from "@tanstack/react-router";
import type { IdentityOptions } from "../../../domain/identity-providers";
import { authEmailDeliveryConfigured } from "../../../server/adapters/email";
import { configuredSocialProviders } from "../../../server/auth/providers";
import { turnstileSettings } from "../../../server/auth/turnstile";
import { serverConfig } from "../../../server/config";
import { endpoint } from "../../../server/http";

const IDENTITY_OPTIONS_MAX_AGE_SECONDS = 300;

export const Route = createFileRoute("/api/identity/providers")({
	server: {
		handlers: {
			GET: async () => {
				const response = await endpoint(
					async (): Promise<IdentityOptions> => ({
						socialProviders: configuredSocialProviders(serverConfig()),
						emailDelivery: authEmailDeliveryConfigured(),
						...(turnstileSettings()
							? { turnstileSiteKey: turnstileSettings()?.siteKey }
							: {}),
					}),
				);
				// Deployment settings, the same for every visitor: the browser
				// reuses them for five minutes instead of asking on every page.
				if (response.ok)
					response.headers.set(
						"Cache-Control",
						`public, max-age=${IDENTITY_OPTIONS_MAX_AGE_SECONDS}`,
					);
				return response;
			},
		},
	},
});
