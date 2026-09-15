import { createFileRoute } from "@tanstack/react-router";
import {
	disconnectAgentAccount,
	loadAgentAccount,
} from "../../../server/auth/agent-account";
import { requireUser } from "../../../server/auth/auth";
import { endpoint, requireSameOrigin } from "../../../server/http";

export const Route = createFileRoute("/api/agent/account")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () =>
					loadAgentAccount((await requireUser(request.headers)).id),
				),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					await disconnectAgentAccount(user.id);
					return { status: "disconnected" as const };
				}),
		},
	},
});
