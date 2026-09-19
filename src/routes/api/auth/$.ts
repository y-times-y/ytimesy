import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../../../server/auth/auth";
import { withLocalQaSession } from "../../../server/auth/local-qa-identity";
export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: async ({ request }) =>
				withLocalQaSession(request, await auth().handler(request)),
			POST: ({ request }) => auth().handler(request),
		},
	},
});
