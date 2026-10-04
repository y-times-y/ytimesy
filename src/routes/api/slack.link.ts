import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "#/server/auth/auth";
import { endpoint, requireSameOrigin } from "#/server/http";
import {
	confirmSlackLink,
	linkSelection,
	slackLinkChoices,
} from "#/server/slack/links";

export const Route = createFileRoute("/api/slack/link")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () =>
					slackLinkChoices((await requireUser(request.headers)).id),
				),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					const input = linkSelection.parse(await request.json());
					return confirmSlackLink(user.id, input.token, input.sessionId);
				}),
		},
	},
});
