import { createFileRoute } from "@tanstack/react-router";
import { configuredSocialProviders } from "../../../server/auth/providers";
import { serverConfig } from "../../../server/config";
import { endpoint } from "../../../server/http";

export const Route = createFileRoute("/api/identity/providers")({
	server: {
		handlers: {
			GET: () =>
				endpoint(async () => ({
					socialProviders: configuredSocialProviders(serverConfig()),
				})),
		},
	},
});
