import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { Workflow } from "@cloudflare/workers-types";
import { readBoundedRequestBody } from "../domain/bounded-request-body";
import {
	signDeliveryRequest,
	verifyDeliveryRequest,
} from "../domain/delivery-auth";
import {
	driveModelWorkflow,
	MODEL_WORKFLOW_DEADLINE_MS,
	type WorkflowStepOutcome,
	type WorkflowTurn,
	workflowTurnSchema,
} from "../domain/model-workflow";

type ModelWorkflowEnvironment = {
	MODEL_TURNS: Workflow<WorkflowTurn>;
	MODEL_EXECUTOR_URL: string;
	MODEL_WORKFLOW_SECRET: string;
};

export class ModelTurnWorkflow extends WorkflowEntrypoint<
	ModelWorkflowEnvironment,
	WorkflowTurn
> {
	async run(event: WorkflowEvent<WorkflowTurn>, step: WorkflowStep) {
		const turn = workflowTurnSchema.parse(event.payload);
		return driveModelWorkflow(
			turn,
			(name, run) =>
				step.do(
					name,
					{ retries: { limit: 0, delay: "1 second" }, timeout: "31 minutes" },
					run,
				),
			async (request) => {
				const url = new URL("/model-step", this.env.MODEL_EXECUTOR_URL).href;
				if (!url.startsWith("https://"))
					throw new Error("Executor requires HTTPS.");
				const body = JSON.stringify(request);
				const response = await fetch(url, {
					method: "POST",
					headers: {
						...(await signDeliveryRequest(
							this.env.MODEL_WORKFLOW_SECRET,
							"POST",
							url,
							body,
						)),
						"content-type": "application/json",
					},
					body,
					signal: AbortSignal.timeout(MODEL_WORKFLOW_DEADLINE_MS),
				});
				if (!response.ok)
					throw new Error(
						"Model step unavailable; uncertain work was not replayed.",
					);
				const result = (await response.json()) as {
					outcome: WorkflowStepOutcome;
				};
				if (
					!["continue", "completed", "failed", "cancelled"].includes(
						result.outcome,
					)
				)
					throw new Error("Invalid executor outcome.");
				return result.outcome;
			},
		);
	}
}

export default {
	async fetch(
		request: Request,
		env: ModelWorkflowEnvironment,
	): Promise<Response> {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/start")
			return new Response(null, { status: 404 });
		if (Number(request.headers.get("content-length")) > 1024)
			return new Response(null, { status: 413 });
		let body: string;
		try {
			body = await readBoundedRequestBody(request, 1024);
		} catch {
			return new Response(null, { status: 413 });
		}
		if (
			!(await verifyDeliveryRequest(env.MODEL_WORKFLOW_SECRET, request, body))
		)
			return new Response(null, { status: 401 });
		try {
			const parsed = workflowTurnSchema.safeParse(JSON.parse(body));
			if (!parsed.success) return new Response(null, { status: 400 });
			// Batch creation is idempotent for existing IDs; unknown network outcomes cannot duplicate a turn.
			await env.MODEL_TURNS.createBatch([
				{
					id: `${parsed.data.turnId}-${parsed.data.leaseId}`,
					params: parsed.data,
				},
			]);
			return new Response(null, { status: 202 });
		} catch {
			return new Response(null, { status: 503 });
		}
	},
};
