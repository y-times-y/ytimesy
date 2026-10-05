import { createHmac } from "node:crypto";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import type { ApiTurn } from "./api-turns";

/** Domain-separated key; only this derived key is shared with the development Workflow. */
export function modelWorkflowSigningSecret() {
	const explicit = process.env.YTIMESY_MODEL_WORKFLOW_SECRET;
	if (explicit) {
		if (explicit.length < 32)
			throw new Error("Invalid model workflow signing secret.");
		return explicit;
	}
	const root = process.env.BETTER_AUTH_SECRET;
	if (!root || root.length < 32)
		throw new Error("Missing model workflow signing secret.");
	return createHmac("sha256", root)
		.update("ytimesy:model-workflows:development:v1")
		.digest("hex");
}

export function modelWorkflowConfiguration() {
	if (process.env.YTIMESY_MODEL_WORKFLOWS !== "true") return null;
	const endpoint = process.env.YTIMESY_MODEL_WORKFLOW_URL;
	const secret = modelWorkflowSigningSecret();
	if (!endpoint)
		throw new Error("Model workflow dispatch is enabled but not configured.");
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

export async function dispatchModelWorkflow(turn: ApiTurn) {
	const config = modelWorkflowConfiguration();
	if (!config || !turn.lease_id)
		throw new Error("Cannot dispatch an unowned workflow turn.");
	const url = `${config.url}/start`;
	const body = JSON.stringify({ turnId: turn.id, leaseId: turn.lease_id });
	const response = await fetch(url, {
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
