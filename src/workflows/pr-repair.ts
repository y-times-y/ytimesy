/// <reference path="../../.ytimesy/pr-repair-runtime.d.ts" />

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { z } from "zod";
import { signDeliveryRequest } from "../domain/delivery-auth";
import {
	acceptPrRepairWebhook,
	prRepairExecutorUrl,
} from "../domain/pr-repair-ingress";
import { prRepairDelivery } from "../domain/pr-repair-signal";

type RepairDelivery = z.infer<typeof prRepairDelivery>;
export class PrRepairWorkflow extends WorkflowEntrypoint<
	PrRepairEnvironment,
	RepairDelivery
> {
	async run(event: WorkflowEvent<RepairDelivery>, step: WorkflowStep) {
		const delivery = prRepairDelivery.parse(event.payload);
		return step.do(
			"persist development repair event",
			{
				retries: { limit: 6, delay: "10 seconds", backoff: "exponential" },
				timeout: "20 seconds",
			},
			async () => {
				const url = prRepairExecutorUrl(this.env.REPAIR_EXECUTOR_URL);
				const body = JSON.stringify(delivery);
				const response = await fetch(url, {
					method: "POST",
					redirect: "manual",
					headers: {
						"content-type": "application/json",
						...(await signDeliveryRequest(
							this.env.PR_REPAIR_INGRESS_SECRET,
							"POST",
							url,
							body,
						)),
					},
					body,
					signal: AbortSignal.timeout(15000),
				});
				await response.body?.cancel();
				if (!response.ok)
					throw new Error(
						"Development repair persistence unavailable; delivery retained for retry.",
					);
				return { persisted: true };
			},
		);
	}
}

export default {
	async fetch(request: Request, env: PrRepairEnvironment) {
		if (!env.GITHUB_PR_REPAIR_WEBHOOK_SECRET || !env.PR_REPAIR_INGRESS_SECRET)
			return new Response(null, { status: 503 });
		return acceptPrRepairWebhook(
			request,
			env.GITHUB_PR_REPAIR_WEBHOOK_SECRET,
			async (delivery) => {
				const id = `repair-${delivery.deliveryId}`;
				try {
					await env.PR_REPAIRS.create({ id, params: delivery });
				} catch {
					const existing = await env.PR_REPAIRS.get(id);
					const status = await existing.status();
					if (status.status === "errored")
						throw new Error("Repair persistence needs operator retry.");
				}
			},
		);
	},
};
