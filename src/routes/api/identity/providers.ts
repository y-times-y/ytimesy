import { createFileRoute } from "@tanstack/react-router";
import type { IdentityOptions } from "../../../domain/identity-providers";
import { authEmailDeliveryConfigured } from "../../../server/adapters/email";
import { configuredSocialProviders } from "../../../server/auth/providers";
import { turnstileSettings } from "../../../server/auth/turnstile";
import { serverConfig } from "../../../server/config";
import { endpoint } from "../../../server/http";

export const Route = createFileRoute("/api/identity/providers")({
	server: {
		handlers: {
			GET: () =>
				endpoint(
					async (): Promise<IdentityOptions> => ({
						socialProviders: configuredSocialProviders(serverConfig()),
						emailDelivery: authEmailDeliveryConfigured(),
						...(turnstileSettings()
							? { turnstileSiteKey: turnstileSettings()?.siteKey }
							: {}),
					}),
				),
		},
	},
});
