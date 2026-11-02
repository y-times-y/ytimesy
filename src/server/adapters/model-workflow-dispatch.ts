import { signDeliveryRequest } from "#/domain/delivery-auth";
import { edgeSigningSecret } from "#/domain/edge-signing-secret";
import type { ApiTurn } from "./api-turns";
import { executorFetch } from "./executor-fetch";

/** Domain-separated key; only this derived key is shared with the development Workflow. */
export function modelWorkflowSigningSecret() {
	const secret = edgeSigningSecret(
		"YTIMESY_MODEL_WORKFLOW_SECRET",
		"model-workflows",
	);
	if (!secret) throw new Error("Missing model workflow signing secret.");
	if (secret.length < 32)
		throw new Error("Invalid model workflow signing secret.");
	return secret;
}

/**
 * The development PR-repair ingress Worker's own key. It may only sign
 * /pr-repair-event deliveries; the executor accepts nothing else with it.
 */
export function prRepairIngressSigningSecret() {
	const secret = edgeSigningSecret(
		"YTIMESY_PR_REPAIR_INGRESS_SECRET",
		"pr-repair-ingress",
	);
	if (!secret) throw new Error("Missing PR repair ingress signing secret.");
	if (secret.length < 32)
		throw new Error("Invalid PR repair ingress signing secret.");
	return secret;
}

function modelWorkflowConfiguration() {
	const endpoint = process.env.YTIMESY_MODEL_WORKFLOW_URL;
	if (!endpoint) return null;
	const secret = modelWorkflowSigningSecret();
	const url = new URL(endpoint);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("Model workflow dispatch requires an HTTPS origin.");
	return { url: url.origin, secret };
}

/** Starts the edge Workflow for a turn the caller already claimed (operator proofs). */
export async function dispatchModelWorkflow(turn: ApiTurn) {
	const config = modelWorkflowConfiguration();
	if (!config || !turn.lease_id)
		throw new Error("Cannot dispatch an unowned workflow turn.");
	const url = `${config.url}/start`;
	const body = JSON.stringify({ turnId: turn.id, leaseId: turn.lease_id });
	const response = await executorFetch(url, {
		method: "POST",
		headers: {
			...(await signDeliveryRequest(config.secret, "POST", url, body)),
			"content-type": "application/json",
		},
		body,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error("Durable model workflow admission failed.");
}
