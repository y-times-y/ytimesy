import { randomUUID } from "node:crypto";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import { edgeSigningSecret } from "#/domain/edge-signing-secret";
import type { EnvironmentModel } from "#/domain/environment-model";
import { environmentWorkflowRequest } from "#/domain/environment-workflow";
import { executorFetch } from "./executor-fetch";

/** Queue retries pass the original job ID so a lost response cannot create a second Workflow. */
export async function dispatchEnvironmentWorkflow(
	workspaceId: string,
	force: boolean,
	repairModel: EnvironmentModel | null,
	requestId: string = randomUUID(),
) {
	const endpoint = process.env.YTIMESY_ENVIRONMENT_WORKFLOW_URL;
	if (!endpoint) return false;
	const origin = new URL(endpoint);
	const secret = edgeSigningSecret(
		"YTIMESY_ENVIRONMENT_WORKFLOW_SECRET",
		"environment-workflows",
	);
	if (
		origin.protocol !== "https:" ||
		origin.pathname !== "/" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		!secret ||
		secret.length < 32
	)
		throw new Error(
			"Environment Workflow requires an HTTPS origin and signing secret.",
		);
	const body = JSON.stringify(
		environmentWorkflowRequest.parse({
			requestId,
			workspaceId,
			force,
			repairModel,
		}),
	);
	const url = new URL("/environment/start", origin).href;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const response = await executorFetch(url, {
				method: "POST",
				headers: {
					...(await signDeliveryRequest(secret, "POST", url, body)),
					"content-type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok)
				throw new Error("Environment Workflow admission failed.");
			return true;
		} catch {
			if (attempt === 1)
				throw new Error(
					"Environment Workflow admission is uncertain; check setup status before retrying.",
				);
		}
	}
	return false;
}
