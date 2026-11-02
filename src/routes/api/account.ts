import { createFileRoute } from "@tanstack/react-router";
import { Effect, Either } from "effect";
import { z } from "zod";
import { accountDeletionConfirmed } from "../../domain/account-deletion";
import { readFreestyleApiKey } from "../../server/adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../../server/adapters/freestyle/workspace-machines";
import { loadAgentAccount } from "../../server/auth/agent-account";
import { requireUser } from "../../server/auth/auth";
import { githubConnectionExists } from "../../server/auth/github-connection";
import { loadXaiSubscription } from "../../server/auth/xai-subscription";
import { endpoint, requireSameOrigin } from "../../server/http";
import { deleteAccount } from "../../server/services/account-deletion";

const deletion = z.object({ confirmation: z.string().max(320) });

/** Without a Freestyle key there are no VMs to reach; each destroy then fails
 * softly and account deletion still removes everything else. */
function providerMachines() {
	const key = Effect.runSync(Effect.either(readFreestyleApiKey()));
	if (Either.isRight(key)) return createFreestyleWorkspaceMachines(key.right);
	const unavailable = () =>
		Promise.reject(new Error("Machine provider is not configured."));
	return { destroy: unavailable, destroySnapshot: unavailable };
}

export const Route = createFileRoute("/api/account")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const user = await requireUser(request.headers);
					return {
						user: {
							id: user.id,
							name: user.name,
							email: user.email,
							image: user.image,
						},
						githubConnected: await githubConnectionExists(user.id),
						agentAccount: await loadAgentAccount(user.id),
						// Absent while the SuperGrok feature switch is off.
						xaiSubscription: await loadXaiSubscription(user.id),
					};
				}),
			/** Permanently deletes the signed-in account; the body repeats the typed confirmation. */
			DELETE: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					const { confirmation } = deletion.parse(await request.json());
					if (!accountDeletionConfirmed(user, confirmation))
						throw new Response("Type the confirmation exactly to delete.", {
							status: 400,
						});
					await deleteAccount(providerMachines(), user.id);
					return { deleted: true };
				}),
		},
	},
});
