import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";
import { signDeliveryRequest } from "../../domain/delivery-auth";
import { modelConversationName } from "../../domain/model-conversation-routing";
import {
	driveModelWorkflow,
	MODEL_WORKFLOW_DEADLINE_MS,
	type WorkflowTurn,
	workflowTurnSchema,
} from "../../domain/model-workflow";
import { backgroundJobId } from "../adapters/background-job-dispatch";
import { database } from "../adapters/database";
import { withDatabaseScope } from "../adapters/database-scope";
import type { EdgeExecutorEnvironment } from "./environment";

const outcomeSchema = z
	.object({ outcome: z.enum(["continue", "completed", "failed", "cancelled"]) })
	.strict();

/** Orchestration calls the chat DO binding directly; no Linux executor or public callback is required. */
export class EdgeModelTurnWorkflow extends WorkflowEntrypoint<
	EdgeExecutorEnvironment,
	WorkflowTurn
> {
	async run(event: WorkflowEvent<WorkflowTurn>, step: WorkflowStep) {
		const turn = workflowTurnSchema.parse(event.payload);
		const scope = await step.do(
			"resolve-chat-owner",
			{ retries: { limit: 0, delay: "1 second" } },
			() =>
				withDatabaseScope(
					this.env.HYPERDRIVE.connectionString,
					async () => {
						const result = await database().query<{
							userId: string;
							sessionId: string;
						}>(
							`select t.user_id as "userId",t.session_id as "sessionId" from api_turn t
					 join agent_session s on s.id=t.session_id and s.user_id=t.user_id
					 where t.id=$1 and t.lease_id=$2 and t.executor='durable-object'`,
							[turn.turnId, turn.leaseId],
						);
						if (!result.rows[0])
							throw new Error("Turn is not assigned to the chat executor.");
						return result.rows[0];
					},
					null,
				),
		);
		const secret = z.string().min(32).parse(process.env.MODEL_WORKFLOW_SECRET);
		const outcome = await driveModelWorkflow(
			turn,
			(name, run) =>
				step.do(
					name,
					{ retries: { limit: 0, delay: "1 second" }, timeout: "31 minutes" },
					run,
				),
			async (request) => {
				const url = "https://model-conversation.internal/model-step";
				const body = JSON.stringify(request);
				const response = await this.env.MODEL_CONVERSATIONS.getByName(
					modelConversationName(scope),
				).fetch(
					new Request(url, {
						method: "POST",
						body,
						headers: await signDeliveryRequest(secret, "POST", url, body),
						signal: AbortSignal.timeout(MODEL_WORKFLOW_DEADLINE_MS),
					}),
				);
				if (!response.ok)
					throw new Error(
						"Chat model step unavailable; uncertain work was not replayed.",
					);
				return outcomeSchema.parse(await response.json()).outcome;
			},
		);
		if (process.env.BACKGROUND_EXECUTION_ENABLED === "1") {
			await step.do(
				"wake-next-turn",
				{ retries: { limit: 2, delay: "1 second" } },
				async () => {
					const id = backgroundJobId(
						`completed:${turn.turnId}:${turn.leaseId}`,
					);
					await this.env.BACKGROUND_JOBS.createBatch([
						{ id, params: { id, kind: "model-admission" } },
					]);
					return true;
				},
			);
		}
		return outcome;
	}
}
