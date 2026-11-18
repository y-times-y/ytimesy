import { modelConversationName } from "../../domain/model-conversation-routing";
import {
	presentedTurnBoxToken,
	type TurnBoxGrant,
	TurnBoxReplayGuard,
	verifyTurnBoxGrant,
} from "../../domain/turn-box-grant";
import { TURN_BOX_PATHS } from "../../domain/turn-box-protocol";
import { withCodexSubscriptionEgress } from "../adapters/codex-subscription-transport";
import { withDatabaseScope } from "../adapters/database-scope";
import { createTurnBoxEdgeOps } from "../adapters/turn-box-edge";
import { createTurnBoxVmOps } from "../adapters/turn-box-vm-edge";
import { durableObjectLocation } from "./durable-object-location";
import type { EdgeExecutorEnvironment } from "./environment";
import { routeTurnBoxEdge, turnBoxEdgeConfig } from "./turn-box-routes";

const replay = new TurnBoxReplayGuard();
const asRecord = (env: EdgeExecutorEnvironment) =>
	env as unknown as Record<string, unknown>;

/**
 * The Worker's entry for the thin-client box API (docs/turn-runner-boxes.md):
 * 404 unless YTIMESY_BOX_TURN_USERS is set, 503 until the edge signing keys
 * are configured. Models, claims, writes and the socket upgrade are routed
 * by routeTurnBoxEdge; each database call runs in its own request scope.
 */
export function routeTurnBoxWorker(
	request: Request,
	env: EdgeExecutorEnvironment,
): Promise<Response> | Response {
	const config = turnBoxEdgeConfig(asRecord(env));
	if (config.status !== 200)
		return new Response(null, { status: config.status });
	const scope = <T>(run: () => Promise<T>) =>
		withDatabaseScope(env.HYPERDRIVE.connectionString, run, null);
	const vm = createTurnBoxVmOps(scope, env);
	// A subscription turn's model request leaves from here (the edge holds
	// the OAuth tokens): over the same Codex egress the Durable Object uses.
	return withCodexSubscriptionEgress(
		(input, options) => env.CODEX_EGRESS.fetch(input, options),
		() => routeTurnBox(request, env, config, scope, vm),
	);
}

function routeTurnBox(
	request: Request,
	env: EdgeExecutorEnvironment,
	config: Extract<ReturnType<typeof turnBoxEdgeConfig>, { status: 200 }>,
	scope: <T>(run: () => Promise<T>) => Promise<T>,
	vm: ReturnType<typeof createTurnBoxVmOps>,
) {
	return routeTurnBoxEdge(request, {
		publicKey: config.publicKey,
		privateKey: config.privateKey,
		boxUsers: config.boxUsers,
		ops: createTurnBoxEdgeOps(scope, { machines: () => vm.machines }),
		vm,
		replay,
		forwardSocket: (grant, upgrade) =>
			env.MODEL_CONVERSATIONS.getByName(
				modelConversationName(grant),
				durableObjectLocation(),
			).fetch(
				new Request(`https://chat.internal${TURN_BOX_PATHS.socket}`, {
					headers: upgrade.headers,
				}),
			),
	});
}

/** In the chat's Durable Object: the grant of a socket upgrade for THIS chat, or the refusal. */
export async function verifiedTurnBoxSocketGrant(
	request: Request,
	env: EdgeExecutorEnvironment,
	expectedName: (name: string) => boolean,
): Promise<TurnBoxGrant | Response> {
	const config = turnBoxEdgeConfig(asRecord(env));
	if (config.status !== 200)
		return new Response(null, { status: config.status });
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
		return new Response(null, { status: 426 });
	const grant = await verifyTurnBoxGrant(
		config.publicKey,
		presentedTurnBoxToken(request.headers),
	);
	if (!grant || !expectedName(modelConversationName(grant)))
		return new Response(null, { status: 401 });
	return grant;
}
