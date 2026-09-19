import { createFileRoute } from "@tanstack/react-router";
import { configuredSocialProviders } from "../../../server/auth/providers";
import { endpoint } from "../../../server/http";

export const Route = createFileRoute("/api/identity/providers")({
	server: {
		handlers: {
			GET: () =>
				endpoint(async () => ({
					socialProviders: configuredSocialProviders(),
				})),
		},
	},
});
